// Proxy library: import, check, rotate, assign. See README.md in this folder for deps.
//
// data/proxies.json: [{ id, name, scheme, host, port, username, password, changeIpUrl, notes,
//   createdAt, check: null | { ok, ip, country, countryCode, city, timezone, latency, at, error } }]
// manager.loadProxies() is the one reader: it merges resources/proxies/*.txt into the file, so
// the txt files stay an import source. data/proxies-removed.json lists host:port keys deleted
// here, so a deleted txt line is not re-imported on the next load.
const fs = require("fs");
const { writeFileAtomic } = require("../fsutil");
const path = require("path");
const crypto = require("crypto");

const SCHEMES = ["http", "https", "socks4", "socks5"];
const SOURCES = ["unused", "unused-ok", "ids"];
const ORDERS = ["sequential", "random"];
const PARALLEL = 8;
const MAX_LINES = 5000;
const RUNNING_ERROR = "running — applies on next launch is not possible; stop it first";

module.exports = function register(app, deps) {
  const { manager, orchestrator, broadcast, testProxy, log, DATA_DIR } = deps;
  const FILE = path.join(DATA_DIR, "proxies.json");
  const REMOVED = path.join(DATA_DIR, "proxies-removed.json");

  const key = (p) => `${p.host}:${p.port}`;
  const now = () => new Date().toISOString();

  function writeJson(file, value) {
    writeFileAtomic(file, JSON.stringify(value, null, 2));
  }
  function readRemoved() {
    try {
      return JSON.parse(fs.readFileSync(REMOVED, "utf8")).map(String);
    } catch {
      return [];
    }
  }

  // ponytail: one lock for every read-modify-write; checks write once per batch of 8.
  let lock = Promise.resolve();
  const withLock = (fn) => {
    const run = lock.then(fn, fn);
    lock = run.catch(() => {});
    return run;
  };
  const update = (fn) =>
    withLock(async () => {
      const list = manager.loadProxies();
      const out = await fn(list);
      writeJson(FILE, list);
      return out;
    });

  /** The panel never sees passwords: `line` is the proxy as text without one. */
  function pub(p, bound) {
    const b = bound.get(key(p));
    return {
      id: p.id,
      name: p.name || "",
      scheme: p.scheme || "http",
      host: p.host,
      port: Number(p.port),
      username: p.username || "",
      hasPassword: Boolean(p.password),
      changeIpUrl: p.changeIpUrl || "",
      notes: p.notes || "",
      createdAt: p.createdAt,
      check: p.check || null,
      isAssigned: Boolean(b),
      assignedTo: b || null,
      line: `${p.scheme || "http"}://${p.username ? `${encodeURIComponent(p.username)}@` : ""}${p.host}:${p.port}`,
    };
  }
  /** host:port → profile id (live or trashed), from the same binding the rest of the app uses. */
  const bindings = () => new Map(manager.listAllProxies().filter((p) => p.isAssigned).map((p) => [p.key, p.assignedTo]));
  const publish = (list) => {
    const bound = bindings();
    return list.map((p) => pub(p, bound));
  };

  const str = (v, max, what) => {
    if (typeof v !== "string") throw new Error(`${what} must be text`);
    return v.trim().slice(0, max);
  };
  const changeIpUrlOf = (v) => {
    const u = str(v, 500, "changeIpUrl");
    if (u && !/^https?:\/\/\S+$/i.test(u)) throw new Error("the change-IP URL must be http(s)");
    return u;
  };

  /* ---------------- parsing ---------------- */

  /** A pasted line with its password masked, in each layout parseProxy accepts. */
  const mask = (line) =>
    line
      .replace(/\/\/([^\s:@/]*):[^\s@/]*@/, "//$1:***@")
      .replace(/^([^\s:@/]*):[^\s@/]*@/, "$1:***@")
      .replace(/^([^\s:@/]+:\d+:[^\s:@/]+):[^\s[{]*/, "$1:***");

  /** Non-empty, non-comment lines of `text` as { line, ok, proxy?, error?, duplicate? }, no write. */
  function parseLines(text, defaultScheme, existingKeys) {
    if (typeof text !== "string") throw new Error("text must be a string");
    const scheme = SCHEMES.includes(defaultScheme) ? defaultScheme : "http";
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    if (lines.length > MAX_LINES) throw new Error(`at most ${MAX_LINES} lines at a time`);
    const seen = new Set(existingKeys);
    return lines.map((raw) => {
      const line = mask(raw);
      let p;
      try {
        p = manager.parseProxy(raw, scheme);
      } catch (err) {
        return { line, ok: false, error: err.message };
      }
      const duplicate = seen.has(key(p));
      seen.add(key(p));
      const { password, ...shown } = p;
      return { line, ok: true, duplicate, proxy: { ...shown, hasPassword: Boolean(password) }, parsed: p };
    });
  }

  /* ---------------- checks ---------------- */

  const toCheck = (r) => ({
    ok: Boolean(r.ok),
    ip: r.ip || null,
    country: r.country || null,
    countryCode: r.countryCode || null,
    city: r.city || null,
    timezone: r.timezone || null,
    latency: Number.isFinite(r.latency) ? r.latency : null,
    at: now(),
    error: r.ok ? null : r.error || "unreachable",
  });

  const inFlight = new Set();
  /** Checks `ids` 8 at a time; each result is stored and broadcast as it lands. */
  async function runChecks(ids) {
    const todo = ids.filter((id) => !inFlight.has(id));
    for (const id of todo) inFlight.add(id);
    const summary = { checked: 0, ok: 0, failed: 0, skipped: ids.length - todo.length };
    try {
      for (let i = 0; i < todo.length; i += PARALLEL) {
        const batch = todo.slice(i, i + PARALLEL);
        const list = manager.loadProxies();
        const results = await Promise.all(
          batch.map(async (id) => {
            const p = list.find((x) => x.id === id);
            if (!p) return null;
            const check = toCheck(await testProxy(p));
            broadcast("proxy", { id, check });
            return [id, check];
          })
        );
        const landed = results.filter(Boolean);
        await update((fresh) => {
          for (const [id, check] of landed) {
            const e = fresh.find((x) => x.id === id);
            if (e) e.check = check;
          }
        });
        for (const [, check] of landed) {
          summary.checked += 1;
          check.ok ? (summary.ok += 1) : (summary.failed += 1);
        }
      }
    } finally {
      for (const id of todo) inFlight.delete(id);
    }
    return summary;
  }

  /* ---------------- routes ---------------- */

  const findOr404 = (res, id) => {
    const p = manager.loadProxies().find((x) => x.id === id);
    if (!p) res.status(404).json({ error: "proxy not found" });
    return p || null;
  };
  const idList = (v) => (Array.isArray(v) ? [...new Set(v.map(String))] : []);

  app.get("/api/proxies", (req, res) => res.json(publish(manager.loadProxies())));

  app.post("/api/proxies/parse", (req, res) => {
    try {
      const rows = parseLines(req.body?.text ?? "", req.body?.defaultScheme, manager.loadProxies().map(key));
      res.json(rows.map(({ parsed, ...row }) => row));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/proxies", async (req, res) => {
    try {
      const r = await update((list) => {
        const rows = parseLines(req.body?.text ?? "", req.body?.defaultScheme, list.map(key));
        const errors = rows.filter((x) => !x.ok).map(({ line, error }) => ({ line, error }));
        let duplicates = 0;
        const added = [];
        for (const row of rows) {
          if (!row.ok) continue;
          if (row.duplicate) {
            duplicates += 1;
            continue;
          }
          const p = row.parsed;
          added.push({
            id: crypto.randomBytes(4).toString("hex"),
            name: p.name,
            scheme: p.scheme,
            host: p.host,
            port: p.port,
            username: p.username,
            password: p.password,
            changeIpUrl: p.changeIpUrl,
            notes: "",
            createdAt: now(),
            check: null,
          });
        }
        list.push(...added);
        // A key added back by hand is no longer "removed".
        if (added.length) {
          const keys = new Set(added.map(key));
          const removed = readRemoved();
          const kept = removed.filter((k) => !keys.has(k));
          if (kept.length !== removed.length) writeJson(REMOVED, kept);
        }
        return { added: added.length, duplicates, errors, proxies: added };
      });
      if (r.added) log("info", "PROXY", `Added ${r.added} proxies to the library${r.errors.length ? `, ${r.errors.length} lines skipped` : ""}`);
      res.json({ added: r.added, duplicates: r.duplicates, errors: r.errors, proxies: publish(r.proxies) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/proxies/check", async (req, res) => {
    const ids = idList(req.body?.ids);
    if (!ids.length) return res.status(400).json({ error: "ids is required" });
    res.json(await runChecks(ids));
  });

  // The frontend's preview and the bulk action share one planner (below).
  app.post("/api/proxies/assign", async (req, res) => {
    const { profiles, ...value } = req.body || {};
    const ids = idList(profiles);
    if (!ids.length) return res.status(400).json({ error: "profiles is required" });
    try {
      validateAssign(value);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const results = await Promise.allSettled(
      ids.map(async (id) => {
        const rec = manager.getSession(id);
        if (!rec) throw new Error("not found");
        return assign(rec, value);
      })
    );
    const bound = bindings();
    const plan = results.map((r, i) =>
      r.status === "fulfilled"
        ? { id: ids[i], proxy: pub(r.value.library, bound) }
        : { id: ids[i], error: r.reason?.message || String(r.reason) }
    );
    res.json({ dryRun: Boolean(value.dryRun), plan, ok: plan.filter((p) => p.proxy).length, failed: plan.filter((p) => p.error) });
  });

  app.patch("/api/proxies/:id", async (req, res) => {
    try {
      const out = await update((list) => {
        const p = list.find((x) => x.id === req.params.id);
        if (!p) return null;
        const b = req.body || {};
        if (b.name !== undefined) p.name = str(b.name, 60, "name");
        if (b.notes !== undefined) p.notes = str(b.notes, 500, "notes");
        if (b.changeIpUrl !== undefined) p.changeIpUrl = changeIpUrlOf(b.changeIpUrl);
        if (b.scheme !== undefined) {
          if (!SCHEMES.includes(b.scheme)) throw new Error(`scheme must be ${SCHEMES.join(", ")}`);
          p.scheme = b.scheme;
        }
        if (b.username !== undefined) p.username = str(b.username, 200, "username");
        if (b.password !== undefined) p.password = str(b.password, 200, "password");
        return p;
      });
      if (!out) return res.status(404).json({ error: "proxy not found" });
      // A profile keeps its own copy of the credentials: new ones (a rotated password)
      // must reach it, or it keeps launching with the old ones and fails with 407.
      const b = req.body || {};
      const holder = bindings().get(key(out));
      if (holder && !/ \(trash\)$/.test(holder) && ["scheme", "username", "password"].some((k) => b[k] !== undefined)) {
        await manager.saveSessionPatch(holder, {
          proxy: { scheme: out.scheme || "http", host: out.host, port: Number(out.port), username: out.username || "", password: out.password || "" },
        });
        deps.log("info", "PROXY", `Updated the proxy credentials of ${holder}`, holder);
      }
      res.json(pub(out, bindings()));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete("/api/proxies/:id", async (req, res) => {
    const p = findOr404(res, req.params.id);
    if (!p) return;
    const boundTo = bindings().get(key(p)) || null;
    if (boundTo && req.query.force !== "1") {
      return res.status(409).json({ error: `bound to ${boundTo} — delete anyway and the profile keeps its copy`, assignedTo: boundTo });
    }
    await update((list) => {
      const i = list.findIndex((x) => x.id === p.id);
      if (i >= 0) list.splice(i, 1);
      const removed = readRemoved();
      if (!removed.includes(key(p))) writeJson(REMOVED, [...removed, key(p)]);
    });
    log("warn", "PROXY", `Removed ${key(p)} from the library${boundTo ? ` (${boundTo} keeps its copy)` : ""}`);
    res.json({ ok: true, id: p.id, keptBy: boundTo, note: boundTo ? `${boundTo} keeps its copy of the proxy` : undefined });
  });

  // GET the change-IP URL (10 s, no redirects, any 2xx counts), wait 5 s, check again.
  app.post("/api/proxies/:id/rotate", async (req, res) => {
    const p = findOr404(res, req.params.id);
    if (!p) return;
    if (!p.changeIpUrl) return res.status(400).json({ error: "this proxy has no change-IP URL" });
    let status;
    try {
      status = (await fetch(p.changeIpUrl, { redirect: "manual", signal: AbortSignal.timeout(10_000) })).status;
    } catch (err) {
      return res.status(502).json({ error: `change-IP URL failed: ${err.cause?.message || err.message}` });
    }
    if (status < 200 || status > 299) return res.status(502).json({ error: `change-IP URL answered ${status}` });
    await new Promise((r) => setTimeout(r, 5000));
    await runChecks([p.id]);
    const check = manager.loadProxies().find((x) => x.id === p.id)?.check || null;
    log(check?.ok ? "info" : "warn", "PROXY", `Rotated ${key(p)}: ${check?.ok ? `new exit IP ${check.ip || "unknown"}` : check?.error || "check failed"}`);
    res.json({ id: p.id, rotated: status, check });
  });

  // Keep /api/proxies/test (server.js) working: it is registered before this module.

  /* ---------------- bulk assignment ---------------- */

  function validateAssign(value) {
    if (!value || typeof value !== "object") throw new Error("value must be { source, order, ids?, checkFirst?, dryRun? }");
    if (!SOURCES.includes(value.source)) throw new Error(`source must be ${SOURCES.join(", ")}`);
    if (value.order !== undefined && !ORDERS.includes(value.order)) throw new Error(`order must be ${ORDERS.join(" or ")}`);
    if (value.source === "ids" && !idList(value.ids).length) throw new Error("ids is required with source 'ids'");
  }

  const isRunning = (id) => orchestrator.live.has(id) || orchestrator.starting.has(id) || orchestrator.queue.includes(id);

  /**
   * One free pool per request: the bulk route calls the action once per profile with the
   * same `value` object, and each call takes the next proxy synchronously, so no two
   * profiles get the same one and the order is the order of the ids.
   */
  const pools = new WeakMap();
  function poolFor(value) {
    let pool = pools.get(value);
    if (pool) return pool;
    const bound = bindings();
    let free = manager.loadProxies().filter((p) => !bound.has(key(p)));
    if (value.source === "unused-ok") free = free.filter((p) => p.check?.ok === true);
    if (value.source === "ids") {
      const byId = new Map(free.map((p) => [p.id, p]));
      free = idList(value.ids).map((id) => byId.get(id)).filter(Boolean);
    } else if (value.order === "random") {
      for (let i = free.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [free[i], free[j]] = [free[j], free[i]];
      }
    }
    pools.set(value, free);
    return free;
  }

  async function assign(rec, value) {
    validateAssign(value);
    if (isRunning(rec.id)) throw new Error(RUNNING_ERROR);
    const pool = poolFor(value);
    let p;
    for (;;) {
      p = pool.shift();
      if (!p) throw new Error(value.source === "unused-ok" ? "no checked, unused proxies left" : "no unused proxies left");
      // A preview must stay quick and write nothing, so it plans without checking.
      if (!value.checkFirst || value.dryRun) break;
      await runChecks([p.id]);
      if (manager.loadProxies().find((x) => x.id === p.id)?.check?.ok) break;
    }
    const proxy = { scheme: p.scheme || "http", host: p.host, port: Number(p.port), username: p.username || "", password: p.password || "" };
    if (value.dryRun) return { library: p, proxy };
    // Proxy and fingerprint are geo-linked: rebuild it, the way PATCH /api/sessions/:id does.
    const patch = { proxy };
    if (rec.fingerprintFile) {
      patch.fingerprint = await require("../fingerprint").buildFingerprint(rec.fingerprintFile, proxy);
      log("info", "FINGERPRINT", `Rebuilt fingerprint for ${rec.id}`, rec.id);
    }
    await manager.saveSessionPatch(rec.id, patch);
    log("info", "PROXY", `Assigned ${key(p)} to ${rec.id}`, rec.id);
    return { library: p, proxy };
  }

  deps.bulk.proxy = assign;
};
