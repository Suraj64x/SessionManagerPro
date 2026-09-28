// Import wizard rows, profiles from cookie files, portable .smp export/import.
// See README.md in this folder for deps.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { execFile } = require("child_process");

const MAX_ROWS = 500;
const SMP_NAME = /^[\w.@-]+\.smp$/;
const DAY_MS = 24 * 60 * 60 * 1000;

// Node resolves a bare `tar` through PATH; in a Git shell that is GNU tar, which cannot
// write zip. Windows ships bsdtar at a fixed place, so use that when it is there.
const TAR = (() => {
  const win = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  return process.platform === "win32" && fs.existsSync(win) ? win : "tar";
})();

const tar = (args) =>
  new Promise((resolve, reject) =>
    execFile(TAR, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr || err.message).trim().split(/\r?\n/)[0] || "tar failed")) : resolve(String(stdout))
    )
  );

const str = (v, max) => (v === undefined || v === null ? "" : String(v).trim().slice(0, max));
const splitList = (v) => (Array.isArray(v) ? v : String(v || "").split(/[,;|]/)).map((s) => String(s).trim()).filter(Boolean);
const safeName = (id) => String(id).replace(/[^\w.@-]/g, "_");

module.exports = function register(app, deps) {
  const { manager, orchestrator, cleanTags, isWebUrl, DATA_DIR, ROOT, log } = deps;
  const EXPORTS = path.join(DATA_DIR, "exports");
  const COOKIES_DIR = path.join(DATA_DIR, "cookies");
  const FPTS_DIR = path.join(ROOT, "resources", "fpts");

  const busy = (id) => orchestrator.live.has(id) || orchestrator.starting.has(id) || orchestrator.queue.includes(id);

  // Exports are one-shot downloads and import temp dirs die with the request; anything older
  // than a day is a leftover from a crash.
  function sweep() {
    fs.mkdirSync(EXPORTS, { recursive: true });
    for (const f of fs.readdirSync(EXPORTS)) {
      const p = path.join(EXPORTS, f);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > DAY_MS) fs.rmSync(p, { recursive: true, force: true });
      } catch {
        // in use; next time
      }
    }
  }

  /* ---------------- rows → profiles ---------------- */

  /** Validates everything first so a bad row leaves nothing behind; throws a readable message. */
  async function importRow(row) {
    const name = str(row?.name, 120);
    if (!name) throw new Error("name is empty");
    const proxyText = str(row.proxy, 500);
    const proxy = proxyText ? manager.parseProxy(proxyText) : undefined;
    const startUrls = (Array.isArray(row.startUrls) ? row.startUrls : String(row.startUrl || "").split(/\s+/))
      .map((u) => String(u).trim())
      .filter(Boolean);
    if (startUrls.length > 10 || !startUrls.every(isWebUrl)) throw new Error("start pages must be up to 10 http(s) URLs");
    const cookieText = typeof row.cookies === "string" ? row.cookies.trim() : Array.isArray(row.cookies) ? row.cookies : "";
    const cookies = cookieText ? manager.normalizeCookies(cookieText) : null;

    const rec = await manager.createSessionRecord(name, { email: name, proxy, mustBeNew: true });
    const patch = {};
    const tags = cleanTags(splitList(row.tags));
    if (tags.length) patch.tags = tags;
    const label = str(row.status, 24);
    if (label) patch.label = label;
    const folder = str(row.folder, 40);
    if (folder) patch.folder = folder;
    const notes = str(row.notes, 2000);
    if (notes) patch.notes = notes;
    if (startUrls.length) patch.startUrls = startUrls;
    if (Object.keys(patch).length) await manager.saveSessionPatch(rec.id, patch);
    if (cookies) manager.stageCookieImport(rec.id, cookies);
    return rec.id;
  }

  async function importBatch(items, run) {
    const created = [];
    const skipped = [];
    for (const item of items) {
      try {
        created.push(await run(item));
      } catch (err) {
        skipped.push({ name: str(item?.name, 120) || "?", error: err.message });
      }
    }
    log(
      skipped.length ? "warn" : "success",
      "SESSION",
      `Imported ${created.length} profile(s)${skipped.length ? `, ${skipped.length} skipped (${skipped[0].error})` : ""}`
    );
    return { created: created.length, skipped };
  }

  const batchOf = (res, list, what) => {
    if (!Array.isArray(list) || !list.length) {
      res.status(400).json({ error: `${what} must be a non-empty array` });
      return null;
    }
    if (list.length > MAX_ROWS) {
      res.status(400).json({ error: `at most ${MAX_ROWS} ${what} per request` });
      return null;
    }
    return list;
  };

  app.post("/api/import/profiles", async (req, res) => {
    const rows = batchOf(res, req.body?.rows, "rows");
    if (!rows) return;
    if (!rows.every((r) => r && typeof r === "object")) return res.status(400).json({ error: "every row must be an object" });
    res.json(await importBatch(rows, importRow));
  });

  app.post("/api/import/cookie-files", async (req, res) => {
    const files = batchOf(res, req.body?.files, "files");
    if (!files) return;
    if (!files.every((f) => f && typeof f.name === "string")) return res.status(400).json({ error: "every file needs a name" });
    res.json(
      await importBatch(files, (f) => {
        if (typeof f.text !== "string" || !f.text.trim()) throw new Error("file is empty");
        return importRow({ name: f.name.replace(/\.[^.]+$/, ""), cookies: f.text });
      })
    );
  });

  /* ---------------- export ---------------- */

  app.post("/api/sessions/export", async (req, res) => {
    const { includeBrowserData = false, includeProxyPassword = false } = req.body || {};
    const ids = batchOf(res, req.body?.ids, "ids");
    if (!ids) return;
    sweep();
    const files = [];
    const skipped = [];
    for (const id of new Set(ids.map(String))) {
      let rec = null;
      try {
        rec = manager.getSession(id);
      } catch (err) {
        skipped.push({ id, error: err.message });
        continue;
      }
      if (!rec) {
        skipped.push({ id, error: "not found" });
        continue;
      }
      if (busy(rec.id)) {
        skipped.push({ id, error: "running — stop it first" });
        continue;
      }
      const dir = path.join(EXPORTS, `tmp-${safeName(rec.id)}`);
      const out = path.join(EXPORTS, `${safeName(rec.id)}.smp`);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        const { userDataDir, ...profile } = rec;
        if (profile.proxy && !includeProxyPassword) profile.proxy = { ...profile.proxy, password: "" };
        fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ smp: 1, exportedAt: new Date().toISOString(), ...profile }, null, 2));
        fs.writeFileSync(path.join(dir, "cookies.json"), JSON.stringify(manager.readCookies(rec.id)));
        if (rec.fingerprintFile && fs.existsSync(path.join(FPTS_DIR, rec.fingerprintFile))) {
          fs.mkdirSync(path.join(dir, "fpt"));
          fs.copyFileSync(path.join(FPTS_DIR, rec.fingerprintFile), path.join(dir, "fpt", rec.fingerprintFile));
        }
        if (includeBrowserData && userDataDir && fs.existsSync(userDataDir)) {
          // ponytail: copies the profile once before zipping; bsdtar -s renaming would avoid it if exports get slow.
          // A stale lock file would make the restored Firefox think the profile is in use.
          fs.cpSync(userDataDir, path.join(dir, "profile"), { recursive: true, force: true, filter: (p) => !/[\\/](parent\.lock|lock)$/.test(p) });
        }
        fs.rmSync(out, { force: true });
        // A real zip: `-a` alone would leave an unknown suffix like .smp as plain tar.
        await tar(["--format", "zip", "-cf", out, "-C", dir, "."]);
        files.push({ id: rec.id, url: `/api/exports/${encodeURIComponent(path.basename(out))}`, bytes: fs.statSync(out).size });
      } catch (err) {
        skipped.push({ id, error: err.message });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    log(
      skipped.length ? "warn" : "info",
      "SESSION",
      `Exported ${files.length} profile(s)${includeBrowserData ? " with browser data" : ""}${skipped.length ? `, ${skipped.length} skipped (${skipped[0].error})` : ""}`
    );
    res.json({ files, skipped });
  });

  app.get("/api/exports/:name", (req, res) => {
    const name = req.params.name;
    if (!SMP_NAME.test(name)) return res.status(400).json({ error: "bad export name" });
    const file = path.join(EXPORTS, name);
    if (!fs.existsSync(file)) return res.status(404).json({ error: "export not found" });
    res.download(file);
  });

  /* ---------------- import ---------------- */

  /** Creates a profile from an extracted .smp folder. The record is rolled back if a later step fails. */
  async function restore(dir) {
    const src = JSON.parse(fs.readFileSync(path.join(dir, "profile.json"), "utf8"));
    if (!src || typeof src !== "object" || typeof src.id !== "string") throw new Error("profile.json has no id");
    const base = manager.newId(src.id);

    let fptFile = typeof src.fingerprintFile === "string" && /^[\w.@-]+$/.test(src.fingerprintFile) ? src.fingerprintFile : "";
    if (fptFile) {
      const packed = path.join(dir, "fpt", fptFile);
      const dest = path.join(FPTS_DIR, fptFile);
      if (!fs.existsSync(dest) && fs.existsSync(packed)) {
        fs.mkdirSync(FPTS_DIR, { recursive: true });
        fs.copyFileSync(packed, dest);
      }
      if (!fs.existsSync(dest)) fptFile = "";
    }

    // Keep the exported proxy and fingerprint when nothing here holds them; otherwise the
    // pool assigns free ones and the fingerprint is rebuilt for the new proxy.
    const taken = [...manager.listSessions(), ...manager.listTrash()];
    const p = src.proxy;
    const proxyFree =
      p && typeof p === "object" && p.host && Number.isInteger(Number(p.port)) && Number(p.port) > 0 &&
      !taken.some((s) => s.proxy && s.proxy.host === p.host && Number(s.proxy.port) === Number(p.port));
    const fptFree = Boolean(fptFile) && !taken.some((s) => s.fingerprintFile === fptFile);
    // Exports leave the password out by default; the library on this machine may still hold it.
    const known = proxyFree && !p.password ? manager.loadProxies().find((l) => l.host === p.host && Number(l.port) === Number(p.port)) : null;
    const extras = {
      email: typeof src.email === "string" ? src.email : undefined,
      proxy: proxyFree
        ? {
            scheme: p.scheme || "http",
            host: String(p.host),
            port: Number(p.port),
            username: String(p.username || known?.username || ""),
            password: String(p.password || known?.password || ""),
          }
        : undefined,
      fingerprintFile: fptFree ? fptFile : undefined,
      fingerprint: proxyFree && fptFree && src.fingerprint && typeof src.fingerprint === "object" ? src.fingerprint : undefined,
      seed: Number.isFinite(src.seed) ? src.seed : undefined,
      mustBeNew: true,
    };

    let rec = null;
    for (let n = 1; !rec; n++) {
      const id = n === 1 ? base : `${base}-${n}`;
      try {
        rec = await manager.createSessionRecord(id, extras);
      } catch (err) {
        if (n >= 100 || !/already exists|in the trash|letter case/.test(err.message)) throw err;
      }
    }

    try {
      const patch = {};
      if (typeof src.notes === "string") patch.notes = src.notes.slice(0, 2000);
      if (typeof src.label === "string") patch.label = src.label.trim().slice(0, 24);
      if (typeof src.folder === "string") patch.folder = src.folder.trim().slice(0, 40);
      if (typeof src.color === "string" && /^#[0-9a-f]{6}$/i.test(src.color)) patch.color = src.color;
      if (Array.isArray(src.tags)) patch.tags = cleanTags(src.tags);
      if (Array.isArray(src.startUrls)) patch.startUrls = src.startUrls.map(String).filter(isWebUrl).slice(0, 10);
      if (Array.isArray(src.tabs)) patch.tabs = src.tabs.map(String).slice(0, 50);
      if (typeof src.pinned === "boolean") patch.pinned = src.pinned;
      for (const k of ["launchCount", "workSeconds"]) if (Number.isFinite(src[k])) patch[k] = src[k];
      for (const k of ["createdAt", "lastOpenedAt", "lastExitIp", "lastCountry"]) if (typeof src[k] === "string") patch[k] = src[k].slice(0, 64);

      let cookies = [];
      const cookiesFile = path.join(dir, "cookies.json");
      if (fs.existsSync(cookiesFile)) {
        try {
          cookies = JSON.parse(fs.readFileSync(cookiesFile, "utf8"));
        } catch {
          cookies = [];
        }
        if (!Array.isArray(cookies)) cookies = [];
      }
      if (cookies.length) {
        fs.mkdirSync(COOKIES_DIR, { recursive: true });
        fs.writeFileSync(path.join(COOKIES_DIR, `${rec.id}.json`), JSON.stringify(cookies, null, 2));
        patch.cookieCount = cookies.length;
      }

      const packedProfile = path.join(dir, "profile");
      if (fs.existsSync(packedProfile) && fs.statSync(packedProfile).isDirectory()) {
        fs.rmSync(rec.userDataDir, { recursive: true, force: true });
        try {
          fs.renameSync(packedProfile, rec.userDataDir);
        } catch {
          fs.cpSync(packedProfile, rec.userDataDir, { recursive: true });
        }
      } else if (cookies.length) {
        // The dump is never read back by the worker; stage it so the first launch gets the cookies.
        try {
          manager.stageCookieImport(rec.id, manager.normalizeCookies(cookies));
        } catch {
          // nothing the browser would accept
        }
      }
      await manager.saveSessionPatch(rec.id, patch);
    } catch (err) {
      await manager.deleteSession(rec.id).catch(() => {});
      throw err;
    }
    return rec.id;
  }

  const rawZip = express.raw({ type: "application/zip", limit: "2gb" });
  app.post("/api/sessions/import", rawZip, async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: "send the .smp file as the body with Content-Type: application/zip" });
    }
    sweep();
    const stamp = crypto.randomBytes(4).toString("hex");
    const file = path.join(EXPORTS, `import-${stamp}.smp`);
    const dir = path.join(EXPORTS, `import-${stamp}`);
    const created = [];
    const skipped = [];
    let id = "archive";
    try {
      fs.writeFileSync(file, req.body);
      const entries = (await tar(["-tf", file])).split(/\r?\n/).filter(Boolean);
      const bad = entries.find((e) => /^([a-zA-Z]:)?[\\/]/.test(e) || /(^|[\\/])\.\.([\\/]|$)/.test(e));
      if (bad) throw new Error(`refusing archive entry "${bad}"`);
      if (!entries.some((e) => /^(\.\/)?profile\.json$/.test(e))) throw new Error("not a .smp export: profile.json is missing");
      fs.mkdirSync(dir, { recursive: true });
      await tar(["-xf", file, "-C", dir]);
      try {
        id = String(JSON.parse(fs.readFileSync(path.join(dir, "profile.json"), "utf8")).id || id);
      } catch {
        // restore() reports it
      }
      const made = await restore(dir);
      created.push(made);
      log("success", "SESSION", `Imported ${made} from .smp${made !== id ? ` (was ${id})` : ""}`, made);
    } catch (err) {
      skipped.push({ id, error: err.message });
      log("warn", "SESSION", `.smp import of ${id} failed: ${err.message}`);
    } finally {
      fs.rmSync(file, { force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
    res.json({ created, skipped });
  });
};
