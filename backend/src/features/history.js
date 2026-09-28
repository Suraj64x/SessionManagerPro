// Profile history and cookie snapshots. See README.md in this folder for deps.
//
// data/history/<id>.jsonl — append-only, capped at MAX_LINES, one { at, type, ...details }
// per line. Sources: the orchestrator's session:launched / session:closed, and the log
// stream (only entries with a sessionId whose category + message we recognise).
// data/cookies/snapshots/<id>/<ts>.json — a copy of the cookie dump after every clean
// close, newest KEEP_SNAPSHOTS kept. Restoring one adds its cookies on top of the current
// jar: the engine has no clear-cookies op, so "replace" means overwrite-by-name.
//
// Not tracked: proxy changes made by the sheet sync (no log, no event) are only noticed at
// the profile's next launch; status (label) and other record edits are not tracked at all;
// profiles created by bulk paths that log without an id (auto-generate, CSV import) get no
// "created" line (their record's createdAt still shows in the stats).
const fs = require("fs");
const { writeFileAtomic } = require("../fsutil");
const path = require("path");

const MAX_LINES = 500;
const KEEP_SNAPSHOTS = 5;
// ISO timestamps with ':' swapped for '-' (colons are not allowed in Windows file names).
const SNAP_RE = /^[\d\-T:.Z]+\.json$/;

module.exports = function register(app, deps) {
  const { orchestrator, manager, DATA_DIR, broadcast, log } = deps;
  const HIST_DIR = path.join(DATA_DIR, "history");
  const COOKIES_DIR = path.join(DATA_DIR, "cookies");
  const SNAP_DIR = path.join(COOKIES_DIR, "snapshots");

  const histFile = (id) => path.join(HIST_DIR, `${manager.safeId(id)}.jsonl`);
  const cookieFile = (id) => path.join(COOKIES_DIR, `${manager.safeId(id)}.json`);
  const snapDir = (id) => path.join(SNAP_DIR, manager.safeId(id));

  /* ---------------- events ---------------- */

  function readEvents(id) {
    let text;
    try {
      text = fs.readFileSync(histFile(id), "utf8");
    } catch {
      return [];
    }
    const out = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // a torn line from a crash mid-write; skip it
      }
    }
    return out;
  }

  function append(id, type, details = {}) {
    let file;
    try {
      file = histFile(id);
    } catch {
      return;
    }
    try {
      fs.mkdirSync(HIST_DIR, { recursive: true });
      fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), type, ...details }) + "\n");
      // Lines are ≥ 40 bytes, so a smaller file cannot be over the cap: skip the read.
      if (fs.statSync(file).size > MAX_LINES * 40) {
        const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
        if (lines.length > MAX_LINES) {
          writeFileAtomic(file, lines.slice(-MAX_LINES).join("\n") + "\n");
        }
      }
    } catch (err) {
      console.warn(`[history] ${id}: ${err.message}`);
    }
    broadcast("history", { id, type });
  }

  function forget(id) {
    try {
      fs.rmSync(histFile(id), { force: true });
      fs.rmSync(snapDir(id), { recursive: true, force: true });
    } catch {
      // locked; the next purge of the same name starts fresh anyway
    }
    lastProxy.delete(id);
  }

  function pruneOrphans() {
    const known = new Set([...manager.listSessions(), ...manager.listTrash()].map((r) => manager.safeId(r.id)));
    const gone = new Set();
    try {
      for (const f of fs.readdirSync(HIST_DIR)) if (f.endsWith(".jsonl") && !known.has(f.slice(0, -6))) gone.add(f.slice(0, -6));
    } catch {
      // no history yet
    }
    try {
      for (const d of fs.readdirSync(SNAP_DIR)) if (!known.has(d)) gone.add(d);
    } catch {
      // no snapshots yet
    }
    for (const id of gone) forget(id);
  }

  /* ---------------- proxy changes ---------------- */

  // PATCH /api/sessions/:id logs "Rebuilt fingerprint" for a proxy change (every profile has a
  // fingerprint file), but before the record is saved — so compare a moment later, and again
  // at every launch as the catch-all for edits that log nothing (sheet sync).
  const proxyOf = (rec) => (rec?.proxy?.host ? `${rec.proxy.host}:${rec.proxy.port}` : "");
  const lastProxy = new Map();
  for (const s of manager.listSessions()) lastProxy.set(s.id, proxyOf(s));
  const remember = (id) => {
    const rec = manager.getSession(id);
    if (rec) lastProxy.set(id, proxyOf(rec));
  };
  function checkProxy(id) {
    const rec = manager.getSession(id);
    if (!rec) return;
    const now = proxyOf(rec);
    const before = lastProxy.get(id);
    lastProxy.set(id, now);
    if (before !== undefined && before !== now) append(id, "proxy_changed", { from: before, to: now });
  }

  /* ---------------- snapshots ---------------- */

  const snapAt = (file) => {
    const iso = file.slice(0, -5).replace(/T(\d\d)-(\d\d)-(\d\d)/, "T$1:$2:$3");
    return Number.isNaN(Date.parse(iso)) ? null : new Date(iso).toISOString();
  };

  function listSnapshots(id) {
    const dir = snapDir(id);
    let names;
    try {
      names = fs.readdirSync(dir).filter((f) => SNAP_RE.test(f));
    } catch {
      return [];
    }
    return names
      .sort()
      .reverse()
      .map((file) => {
        const full = path.join(dir, file);
        let count = 0;
        try {
          const parsed = JSON.parse(fs.readFileSync(full, "utf8"));
          count = Array.isArray(parsed) ? parsed.length : 0;
        } catch {
          // unreadable: listed with 0 so it can still be downloaded or fall off the end
        }
        const st = fs.statSync(full);
        return { file, at: snapAt(file) || st.mtime.toISOString(), count, bytes: st.size };
      });
  }

  function takeSnapshot(id) {
    let cookies;
    try {
      cookies = manager.readCookies(id);
    } catch {
      return;
    }
    if (!Array.isArray(cookies) || !cookies.length) return;
    const dir = snapDir(id);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(cookieFile(id), path.join(dir, new Date().toISOString().replace(/:/g, "-") + ".json"));
    for (const old of listSnapshots(id).slice(KEEP_SNAPSHOTS)) fs.rmSync(path.join(dir, old.file), { force: true });
    broadcast("history", { id, type: "snapshot" });
  }

  /** The snapshot's path, or null when the name is not one we would have written. */
  const snapFile = (id, name) => (SNAP_RE.test(name) && !name.includes("..") ? path.join(snapDir(id), name) : null);

  /* ---------------- sources ---------------- */

  // The worker writes its final cookie dump during shutdown, which can be after it reported
  // disconnected (closing the last window). Keep the handle to wait for the process to exit.
  const workers = new Map();

  orchestrator.on("session:launched", (e) => {
    const h = orchestrator.live.get(e.id)?.handle;
    if (h) workers.set(e.id, h);
    append(e.id, "launched", { headless: e.headless, exitIp: e.exitIp, country: e.country });
  });

  orchestrator.on("session:closed", async (e) => {
    append(e.id, "closed", { status: e.status, reason: e.reason, durationMs: e.durationMs, closedByUser: e.closedByUser });
    const proc = workers.get(e.id)?.process;
    workers.delete(e.id);
    if (e.status !== "success") return;
    try {
      if (proc && proc.exitCode === null && proc.signalCode === null) {
        await new Promise((r) => {
          const t = setTimeout(r, 5000);
          proc.once("exit", () => (clearTimeout(t), r()));
        });
      }
      takeSnapshot(e.id);
    } catch (err) {
      console.warn(`[history] snapshot ${e.id}: ${err.message}`);
    }
  });

  orchestrator.on("session:update", (e) => {
    if (e.status === "running") checkProxy(e.id);
  });

  orchestrator.on("log", (e) => {
    const id = e.sessionId;
    // Bulk purges log one line without ids: sweep whatever no longer has a record.
    if (!id && e.category === "SESSION" && /^(Emptied trash|Trash: purged)/.test(e.message)) return pruneOrphans();
    if (!id) return;
    const m = e.message;
    let hit;
    switch (e.category) {
      case "COOKIE":
        if ((hit = /^Imported (\d+) of (\d+)/.exec(m))) append(id, "cookies_imported", { count: Number(hit[1]), total: Number(hit[2]) });
        break;
      case "FINGERPRINT":
        if (/^Rebuilt fingerprint/.test(m)) {
          append(id, "fingerprint_changed");
          setTimeout(() => checkProxy(id), 150).unref?.();
        }
        break;
      case "SESSION":
        if (/^Created profile/.test(m)) (append(id, "created"), remember(id));
        else if (/^Template ".*": created 1 /.test(m)) (append(id, "created", { via: "template" }), remember(id));
        else if (/^Imported .* from \.smp/.test(m)) (append(id, "created", { via: "import" }), remember(id));
        else if ((hit = /^Cloned (.+?) → /.exec(m))) (append(id, "cloned", { from: hit[1] }), remember(id));
        else if (/^Restored from trash/.test(m)) (append(id, "restored"), remember(id));
        else if (/^Moved to trash/.test(m)) append(id, "trashed");
        else if ((hit = /^Failed to launch [^:]*: (.*)$/.exec(m))) append(id, "launch_failed", { reason: hit[1] });
        else if (/^Permanently deleted/.test(m)) forget(id);
        break;
      case "SCRIPT":
        if ((hit = /^(.*): finished in (\d+) ms$/.exec(m))) append(id, "script_ok", { script: hit[1], ms: Number(hit[2]) });
        else if (e.level === "error") append(id, "script_failed", { message: m });
        break;
      default:
        break;
    }
  });

  // Bulk trash logs one line without ids; record each profile it actually moved.
  const bulkTrash = deps.bulk.trash;
  if (bulkTrash) {
    deps.bulk.trash = async (rec, value) => {
      const out = await bulkTrash(rec, value);
      if (out !== false) append(rec.id, "trashed");
      return out;
    };
  }

  /* ---------------- routes ---------------- */

  const found = (req, res) => {
    const rec = manager.getSession(req.params.id);
    if (!rec) res.status(404).json({ error: "Session not found" });
    return rec;
  };

  app.get("/api/sessions/:id/history", (req, res) => {
    const rec = found(req, res);
    if (!rec) return;
    const types = String(req.query.type || "").split(",").map((t) => t.trim()).filter(Boolean);
    const events = readEvents(rec.id).reverse().filter((e) => !types.length || types.includes(e.type));
    res.json({
      events,
      stats: {
        launchCount: rec.launchCount || 0,
        workSeconds: rec.workSeconds || 0,
        lastExitIp: rec.lastExitIp || null,
        lastCountry: rec.lastCountry || null,
        createdAt: rec.createdAt,
      },
    });
  });

  app.get("/api/sessions/:id/snapshots", (req, res) => {
    const rec = found(req, res);
    if (!rec) return;
    res.json(listSnapshots(rec.id));
  });

  app.get("/api/sessions/:id/snapshots/:file", (req, res) => {
    const rec = found(req, res);
    if (!rec) return;
    const file = snapFile(rec.id, req.params.file);
    if (!file) return res.status(400).json({ error: "not a snapshot name" });
    if (!fs.existsSync(file)) return res.status(404).json({ error: "snapshot not found" });
    res.download(file, `${rec.id}-cookies-${req.params.file}`);
  });

  app.post("/api/sessions/:id/snapshots/:file/restore", async (req, res) => {
    const rec = found(req, res);
    if (!rec) return;
    const file = snapFile(rec.id, req.params.file);
    if (!file) return res.status(400).json({ error: "not a snapshot name" });
    if (!fs.existsSync(file)) return res.status(404).json({ error: "snapshot not found" });
    let cookies;
    try {
      cookies = manager.normalizeCookies(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch (err) {
      return res.status(400).json({ error: `unreadable snapshot: ${err.message}` });
    }
    const live = orchestrator.live.get(rec.id);
    if (live) {
      await live.handle.rpc("add_cookies", { cookies }, 15_000);
    } else {
      // The dump is what the panel counts and exports; the staged import is what the next launch loads.
      fs.copyFileSync(file, cookieFile(rec.id));
      manager.stageCookieImport(rec.id, cookies);
      try {
        await manager.saveSessionPatch(rec.id, { cookieCount: cookies.length });
      } catch {
        // deleted meanwhile
      }
    }
    const applied = live ? "now" : "next launch";
    log("success", "COOKIE", `Restored cookie snapshot ${req.params.file} (${cookies.length} cookies, ${applied})`, rec.id);
    append(rec.id, "snapshot_restored", { count: cookies.length, applied });
    res.json({ count: cookies.length, applied });
  });
};
