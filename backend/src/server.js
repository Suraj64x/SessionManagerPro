const http = require("http");
const { writeFileAtomic } = require("./fsutil");
const { fetchVia } = require("./tunnel");
const path = require("path");
const fs = require("fs");
const express = require("express");
const { WebSocketServer } = require("ws");

const {
  listSessions,
  getSession,
  createSessionRecord,
  saveSessionPatch,
  ensureSessions,
  parseProxy,
  resolveProxyKey,
  publicRecord,
  listAllProxies,
  listAllFingerprints,
  getSystemStats,
  parseCsvAccounts,
  parseCsvText,
  nextSessionIds,
  syncSheetEdits,
  trashSession,
  restoreSession,
  listTrash,
  purgeTrash,
  cloneSession,
  normalizeCookies,
  countLanded,
  readCookies,
  stageCookieImport,
  TRASH_TTL_MS,
  ACCOUNT_FILE,
} = require("./manager");
const scripts = require("./scripts");

const orchestrator = require("./orchestrator");

// 47301, not 3001: Dolphin{anty}'s Local API listens on 3001, and the tray launcher treats
// anything answering on our port as our own server.
const PORT = Number(process.env.PORT) || 47301;
const ROOT = path.resolve(__dirname, "..", "..");
const DATA_DIR = path.join(ROOT, "data");
// Loopback only. This API can delete profiles and — through /api/scripts — run code on
// this machine, so it must never be reachable from the LAN.
const HOST = process.env.HOST || "127.0.0.1";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const hostnameOf = (hostHeader) => String(hostHeader || "").replace(/:\d+$/, "").toLowerCase();

/**
 * Only the local panel may drive this server.
 *  - Host must be loopback: a hostile domain rebound to 127.0.0.1 still sends its own name.
 *  - Origin, when present, must be loopback: browsers always send it cross-origin.
 * The terminal logger and curl send no Origin and a loopback Host, so they pass.
 */
const LOOPBACK_PEER = /^(127\.|::1$|::ffff:127\.)/;

function trusted(req) {
  // Headers are client-supplied; the socket's peer address is not.
  if (!LOOPBACK_PEER.test(req.socket?.remoteAddress || "")) return false;
  if (!LOOPBACK.has(hostnameOf(req.headers.host))) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return LOOPBACK.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

const app = express();

// Express 4 ignores rejected promises from async handlers; on Node 22 an unhandled
// rejection exits the process, closing every open browser with it. Wrap every route
// once, here, so no current or future handler can do that.
for (const method of ["get", "post", "patch", "delete"]) {
  const register = app[method].bind(app);
  app[method] = (path, ...handlers) =>
    handlers.length === 0
      ? register(path) // app.get("setting")
      : register(
          path,
          ...handlers.map((h) =>
            typeof h === "function" && h.length < 4
              ? (req, res, next) => {
                  try {
                    const out = h(req, res, next);
                    if (out && typeof out.catch === "function") out.catch(next);
                  } catch (err) {
                    next(err);
                  }
                }
              : h
          )
        );
}

app.use((req, res, next) => {
  if (!trusted(req)) return res.status(403).json({ error: "forbidden" });
  // A custom header cannot be set by a <form> or a no-cors fetch, and any page that tries
  // gets a preflight this server never approves. Closes body-less CSRF like /api/sessions/auto.
  if (!["GET", "HEAD"].includes(req.method) && req.get("x-smp") !== "1") {
    return res.status(403).json({ error: "missing X-SMP header" });
  }
  next();
});
// JSON only. Never add text/urlencoded parsers: they would reopen simple-request CSRF.
app.use(express.json({ limit: "10mb" }));

const isWebUrl = (u) => {
  if (u === "about:blank") return true;
  try {
    return ["http:", "https:"].includes(new URL(u).protocol);
  } catch {
    return false;
  }
};

const cleanTags = (tags) =>
  [...new Set([].concat(tags || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean))]
    .slice(0, 20)
    .map((t) => t.slice(0, 24));

// Helper: Test proxy connectivity
// Geolocates the proxy's EXIT IP (not its host), which is what sites — and the
// browser's timezone — actually see. Asked through the proxy: http, https, socks4 or socks5.
async function testProxy(p) {
  const start = Date.now();
  let r;
  try {
    r = await fetchVia({ ...p, scheme: p.scheme || "http" }, "http://ip-api.com/json?fields=status,query,country,countryCode,city,timezone,isp", {
      timeoutMs: 8000,
    });
  } catch (err) {
    const error = /username\/password/.test(err.message) ? "proxy rejected the credentials" : err.message.replace(/^\w+ proxy \S+: /, "");
    return { ok: false, latency: Date.now() - start, error };
  }
  const latency = Date.now() - start;
  try {
    const g = JSON.parse(r.body);
    if (g.status !== "success") throw new Error();
    return { ok: true, latency, ip: g.query, country: g.country, countryCode: g.countryCode, city: g.city, timezone: g.timezone, isp: g.isp };
  } catch {
    // The proxy answered, so it works; the geo service was rate-limited or odd.
    return { ok: true, latency, ip: null };
  }
}

// ---------------- REST API ----------------

// Dashboard summary stats
app.get("/api/stats", (req, res) => {
  const stats = getSystemStats();
  const pool = orchestrator.getStatus();
  res.json({
    ...stats,
    activeThreads: pool.activeCount,
    threadLimit: pool.threadLimit,
    queuedCount: pool.queuedCount,
  });
});

// All sessions with live status
app.get("/api/sessions", (req, res) => {
  const sessions = listSessions();
  const pool = orchestrator.getStatus();
  const liveMap = new Map(pool.live.map((item) => [item.id, item]));
  const queuedSet = new Set(pool.queued);

  const enriched = sessions.map((s) => {
    let status = "ready";
    if (liveMap.has(s.id)) status = "live";
    else if (queuedSet.has(s.id)) status = "queued";
    else if (s.lastResult?.status === "error") status = "error";
    else if (s.lastResult?.status === "success") status = "completed";

    return {
      ...publicRecord(s),
      status,
      liveInfo: liveMap.get(s.id) || null,
    };
  });
  res.json(enriched);
});

// Single session detail
app.get("/api/sessions/:id", (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: "Session not found" });
  res.json(publicRecord(s));
});

// Create single session
app.post("/api/sessions/create", async (req, res) => {
  try {
    const { name, proxy, proxyKey, fingerprintFile } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Session name is required" });
    }
    // Which browser runs it (GET /api/browsers); stored as given, default Stealth Firefox.
    const browser = req.body.browser === undefined ? undefined : await require("./browsers").validId(req.body.browser);
    const { geolocation, webrtc } = req.body;
    if (geolocation !== undefined && !["block", "spoof"].includes(geolocation)) {
      return res.status(400).json({ error: "geolocation must be block or spoof" });
    }
    if (webrtc !== undefined && !["masked", "off"].includes(webrtc)) {
      return res.status(400).json({ error: "webrtc must be masked or off" });
    }
    // The panel names a library proxy by its "host:port" key (it never sees passwords);
    // API callers may pass a full proxy URL instead.
    let parsedProxy = proxy;
    try {
      if (proxyKey) parsedProxy = resolveProxyKey(proxyKey);
      else if (typeof proxy === "string" && proxy.trim()) parsedProxy = parseProxy(proxy);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const session = await createSessionRecord(name.trim(), {
      proxy: parsedProxy,
      fingerprintFile,
      browser,
      geolocation,
      webrtc,
    });
    orchestrator.log("info", "SESSION", `Created profile: ${session.id}`, session.id);
    res.json(publicRecord(session));
  } catch (err) {
    // Every failure here is about the request or the pool (bad name, trashed name,
    // no free proxy), not a server fault.
    res.status(400).json({ error: err.message });
  }
});

// Batch create auto-generated sessions
app.post("/api/sessions/auto", async (req, res) => {
  try {
    const { count = 1, prefix = "session" } = req.body;
    const ids = nextSessionIds(Number(count) || 1, (prefix || "session").trim());
    const { created, existing } = await ensureSessions(ids);
    orchestrator.log(
      "info",
      "SESSION",
      `Auto-generated ${created.length} profiles with prefix '${prefix}'`
    );
    res.json({ created: created.map(publicRecord), existing: existing.map(publicRecord) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Launch sessions
app.post("/api/sessions/launch", async (req, res) => {
  try {
    const { ids, threads, url } = req.body;
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ error: "No session IDs provided" });
    }
    if (url && !isWebUrl(url)) {
      return res.status(400).json({ error: "start URL must be http(s)" });
    }
    const success = await orchestrator.launch(ids, { threads, url });
    res.json({ ok: success, count: ids.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stop specific session or all
app.post("/api/sessions/stop", async (req, res) => {
  try {
    const { id, all } = req.body;
    if (all) {
      await orchestrator.stopAll();
      return res.json({ ok: true, stopped: "all" });
    }
    if (!id) return res.status(400).json({ error: "Session ID or 'all' required" });
    const stopped = await orchestrator.stop(id);
    res.json({ ok: stopped, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update session notes, proxy, or fingerprint.
// Proxy and fingerprint are geo-linked, so either change rebuilds the fingerprint.
app.patch("/api/sessions/:id", async (req, res) => {
  try {
    const current = getSession(req.params.id);
    if (!current) return res.status(404).json({ error: "Session not found" });

    // Whitelist. A raw spread of req.body would let any caller rewrite userDataDir,
    // which DELETE later hands straight to fs.rmSync({ recursive: true }).
    const patch = {};
    if (typeof req.body.notes === "string") patch.notes = req.body.notes.slice(0, 2000);
    if (req.body.tags !== undefined) patch.tags = cleanTags(req.body.tags);
    if (req.body.label !== undefined) patch.label = String(req.body.label || "").trim().slice(0, 24);
    if (req.body.color !== undefined) {
      const c = String(req.body.color || "");
      if (c && !/^#[0-9a-f]{6}$/i.test(c)) return res.status(400).json({ error: "color must be #rrggbb" });
      patch.color = c;
    }
    if (req.body.startUrls !== undefined) {
      const urls = [].concat(req.body.startUrls || []).map((u) => String(u).trim()).filter(Boolean);
      if (urls.length > 10 || !urls.every(isWebUrl)) {
        return res.status(400).json({ error: "start pages must be up to 10 http(s) URLs" });
      }
      patch.startUrls = urls;
    }
    if (req.body.folder !== undefined) patch.folder = String(req.body.folder || "").trim().slice(0, 40);
    if (req.body.pinned !== undefined) patch.pinned = Boolean(req.body.pinned);
    if (req.body.geolocation !== undefined) {
      if (!["block", "spoof"].includes(req.body.geolocation)) {
        return res.status(400).json({ error: "geolocation must be block or spoof" });
      }
      patch.geolocation = req.body.geolocation;
    }
    if (req.body.webrtc !== undefined) {
      if (!["masked", "off"].includes(req.body.webrtc)) {
        return res.status(400).json({ error: "webrtc must be masked or off" });
      }
      patch.webrtc = req.body.webrtc;
    }
    if (req.body.browser !== undefined) {
      let next;
      try {
        next = await require("./browsers").validId(req.body.browser);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
      if (next !== (current.browser || "stealth-firefox")) {
        const id = current.id;
        if (orchestrator.live.has(id) || orchestrator.starting.has(id) || orchestrator.queue.includes(id)) {
          return res.status(409).json({ error: "stop this profile before changing its browser" });
        }
        patch.browser = next;
      }
    }

    if (req.body.proxy !== undefined || req.body.proxyKey !== undefined) {
      const raw = req.body.proxy;
      let p;
      try {
        p = req.body.proxyKey !== undefined ? resolveProxyKey(req.body.proxyKey) : typeof raw === "string" ? parseProxy(raw) : raw;
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
      if (!p || !p.host || !Number.isInteger(Number(p.port)) || Number(p.port) < 1) {
        return res.status(400).json({ error: "proxy needs a host and port, and cannot be cleared" });
      }
      patch.proxy = {
        scheme: p.scheme || "http",
        host: p.host,
        port: Number(p.port),
        username: p.username || "",
        password: p.password || "",
      };
    }

    if (req.body.fingerprintFile !== undefined) {
      const { listFptFiles } = require("./fingerprint");
      if (!req.body.fingerprintFile || !listFptFiles().includes(req.body.fingerprintFile)) {
        return res.status(400).json({ error: "unknown fingerprint file" });
      }
      patch.fingerprintFile = req.body.fingerprintFile;
    }

    // Another profile may have claimed the resource since this editor was opened.
    const others = [...listSessions(), ...listTrash()].filter((s) => s.id !== current.id);
    const taken = (msg) => res.status(409).json({ error: msg });
    if (
      patch.proxy &&
      others.some((s) => s.proxy && `${s.proxy.host}:${s.proxy.port}` === `${patch.proxy.host}:${patch.proxy.port}`)
    ) {
      return taken("that proxy is already bound to another profile");
    }
    if (patch.fingerprintFile && others.some((s) => s.fingerprintFile === patch.fingerprintFile)) {
      return taken("that fingerprint is already bound to another profile");
    }

    const proxyChanged =
      Boolean(patch.proxy) &&
      (patch.proxy.host !== current.proxy?.host || patch.proxy.port !== Number(current.proxy?.port));
    const fptChanged = Boolean(patch.fingerprintFile) && patch.fingerprintFile !== current.fingerprintFile;
    const nextFile = patch.fingerprintFile || current.fingerprintFile;
    const nextProxy = patch.proxy || current.proxy;

    if (nextFile && (proxyChanged || fptChanged)) {
      const { buildFingerprint } = require("./fingerprint");
      const rebuilt = await buildFingerprint(nextFile, nextProxy);
      // Same proxy means the same region: keep the geo already resolved rather than
      // letting a flaky lookup silently move the profile's timezone.
      patch.fingerprint = proxyChanged
        ? rebuilt
        : {
            ...rebuilt,
            timezone: current.fingerprint?.timezone || rebuilt.timezone,
            locale: current.fingerprint?.locale || rebuilt.locale,
          };
      orchestrator.log("info", "FINGERPRINT", `Rebuilt fingerprint for ${current.id}`, current.id);
    }

    const updated = await saveSessionPatch(req.params.id, patch);
    res.json(publicRecord(updated));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete session
app.delete("/api/sessions/:id", async (req, res) => {
  try {
    const id = req.params.id;
    orchestrator.assertNotStarting(id);
    await orchestrator.stop(id);
    const ok = await trashSession(id);
    if (!ok) return res.status(404).json({ error: "Session not found" });
    orchestrator.log("warn", "SESSION", `Moved to trash (kept 48h): ${id}`, id);
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Inventory: Proxies, Fingerprints, Accounts
app.get("/api/resources", (req, res) => {
  res.json({
    proxies: listAllProxies(),
    fingerprints: listAllFingerprints(),
    accounts: parseCsvAccounts(),
  });
});

// Test a proxy
app.post("/api/proxies/test", async (req, res) => {
  try {
    let p = req.body;
    if (typeof p === "string" || p.url) {
      p = parseProxy(p.url || p);
    }
    if (!p.host || !p.port) {
      return res.status(400).json({ error: "Invalid proxy format" });
    }
    const result = await testProxy(p);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sync sheet
app.post("/api/sheet/sync", async (req, res) => {
  try {
    const result = await syncSheetEdits();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import accounts
app.post("/api/accounts/import", async (req, res) => {
  try {
    const { csvContent } = req.body;
    if (!csvContent || typeof csvContent !== "string") {
      return res.status(400).json({ error: "csvContent string required" });
    }
    // Validate before touching the file: a bad CSV must not replace a good one (every
    // resources/stats request reads it).
    const accounts = parseCsvText(csvContent);
    writeFileAtomic(ACCOUNT_FILE, csvContent.trim() + "\n");
    // A profile for every account without one (each gets a free proxy and fingerprint).
    // Trashed names are left alone; a row that can't be created is reported, not fatal.
    const trashed = new Set(listTrash().map((t) => t.id));
    const { created, existing, skipped } = await ensureSessions(accounts.filter((a) => !trashed.has(a)));
    orchestrator.log(
      skipped.length ? "warn" : "info",
      "SESSION",
      `CSV import: ${created.length} new, ${existing.length} existing${skipped.length ? `, ${skipped.length} skipped (${skipped[0].error})` : ""}`
    );
    res.json({ ok: true, count: accounts.length, created: created.length, existing: existing.length, skipped });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Event logs
app.get("/api/logs", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json(orchestrator.getLogs(limit));
});

// Thread pool status
app.get("/api/pool", (req, res) => {
  res.json(orchestrator.getStatus());
});

// Change the concurrency cap live; raising it promotes queued sessions at once.
app.post("/api/pool", (req, res) => {
  const threads = Number(req.body.threads);
  if (!Number.isInteger(threads) || threads < 1 || threads > MAX_THREADS) {
    return res.status(400).json({ error: `threads must be a whole number from 1 to ${MAX_THREADS}` });
  }
  orchestrator.threadLimit = threads;
  appSettings.write({ threadLimit: threads });
  orchestrator.log("info", "QUEUE", `Thread cap set to ${threads}`);
  orchestrator.emit("pool:update", orchestrator.getStatus());
  if (orchestrator.queue.length) orchestrator.fillPool();
  res.json(orchestrator.getStatus());
});


// ---------------- App (desktop launcher) ----------------

// App-wide settings live in data/app.json. Every key has a validator (a feature registers
// its own through deps.appSettings), so PATCH can never store an unknown or malformed value.
// closeBehavior is also read by the tray launcher: "tray" keeps running in the tray; "quit" exits,
// asking first when profiles are running (keep them in the tray, stop them and quit, or cancel).
const APP_FILE = path.join(DATA_DIR, "app.json");
const appSettings = {
  keys: new Map(),
  /**
   * `validate(value)` returns the cleaned value or throws a message fit for a 400.
   * A `readOnly` key (e.g. versions) always reads as its default and is never stored.
   */
  register(key, defaultValue, validate, { readOnly = false } = {}) {
    this.keys.set(key, { defaultValue, validate, readOnly });
  },
  stored() {
    try {
      return JSON.parse(fs.readFileSync(APP_FILE, "utf8"));
    } catch {
      return {}; // first run
    }
  },
  read() {
    const stored = this.stored();
    const out = {};
    for (const [key, { defaultValue, readOnly }] of this.keys) {
      out[key] = readOnly || stored[key] === undefined ? defaultValue : stored[key];
    }
    return out;
  },
  write(next) {
    // Keys no feature has registered (yet, or any more) are kept as they were: a feature that
    // loads later, or fails to load this time, must not lose its saved settings.
    const out = { ...this.stored() };
    for (const [key, value] of Object.entries(next)) {
      if (!this.keys.get(key)?.readOnly) out[key] = value;
    }
    for (const [key, def] of this.keys) if (def.readOnly) delete out[key];
    writeFileAtomic(APP_FILE, JSON.stringify(out, null, 2));
    return this.read();
  },
};
// Default "quit": closing a window closes the app, and running profiles are never stopped unasked.
appSettings.register("closeBehavior", "quit", (v) => {
  if (!["tray", "quit"].includes(v)) throw new Error("closeBehavior must be tray or quit");
  return v;
});
// How many browsers run at once. No product cap: 999 only guards against a typo.
const MAX_THREADS = 999;
appSettings.register("threadLimit", 5, (v) => {
  if (!Number.isInteger(v) || v < 1 || v > MAX_THREADS) throw new Error(`threadLimit must be a whole number from 1 to ${MAX_THREADS}`);
  return v;
});
const readApp = () => appSettings.read();
orchestrator.threadLimit = readApp().threadLimit;

app.get("/api/app", (req, res) => res.json(readApp()));

app.patch("/api/app", (req, res) => {
  // Only the keys sent are stored: a key never changed keeps following its default.
  const next = {};
  for (const [key, value] of Object.entries(req.body || {})) {
    const def = appSettings.keys.get(key);
    if (!def) return res.status(400).json({ error: `unknown setting: ${key}` });
    if (def.readOnly) return res.status(400).json({ error: `${key} is read-only` });
    try {
      next[key] = def.validate(value);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }
  const saved = appSettings.write(next);
  broadcast("app", saved);
  res.json(saved);
});

// Closes every browser (cookies are saved as each one closes), then exits. The tray
// launcher sees the server exit and quits with it.
let quitting = false;
app.post("/api/app/quit", (req, res) => {
  res.json({ ok: true });
  if (quitting) return;
  quitting = true;
  orchestrator.log("warn", "SESSION", "Quitting SessionManagerPro — closing all browsers");
  // Tell open panels first, so the dashboard window closes too (e.g. on a tray Quit).
  broadcast("quit", {});
  setImmediate(async () => {
    try {
      await orchestrator.stopAll();
    } catch {
      // closing anyway
    }
    setTimeout(() => process.exit(0), 300);
  });
});

// ---------------- Bulk actions ----------------

const BULK = {
  tag: (rec, value) => saveSessionPatch(rec.id, { tags: cleanTags([...(rec.tags || []), ...[].concat(value)]) }),
  untag: (rec, value) => {
    const drop = new Set(cleanTags(value));
    return saveSessionPatch(rec.id, { tags: (rec.tags || []).filter((t) => !drop.has(t)) });
  },
  label: (rec, value) => saveSessionPatch(rec.id, { label: String(value || "").trim().slice(0, 24) }),
  stop: (rec) => orchestrator.stop(rec.id),
  trash: async (rec) => {
    orchestrator.assertNotStarting(rec.id);
    await orchestrator.stop(rec.id);
    return trashSession(rec.id);
  },
};

app.post("/api/sessions/bulk", async (req, res) => {
  const { ids, action, value } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "No session IDs provided" });
  if (!BULK[action]) return res.status(400).json({ error: `unknown action: ${action}` });
  const results = await Promise.allSettled(
    ids.map(async (id) => {
      const rec = getSession(id);
      if (!rec) throw new Error("not found");
      return BULK[action](rec, value);
    })
  );
  const failed = results
    .map((r, i) => (r.status === "rejected" ? { id: ids[i], error: r.reason?.message || String(r.reason) } : null))
    .filter(Boolean);
  if (action === "trash") orchestrator.log("warn", "SESSION", `Moved ${ids.length - failed.length} profile(s) to trash`);
  res.json({ ok: ids.length - failed.length, failed });
});

// ---------------- Clone ----------------

app.post("/api/sessions/:id/clone", async (req, res) => {
  try {
    const src = req.params.id;
    const name = String(req.body.name || "").trim() || nextSessionIds(1, `${src}-copy`)[0];
    const copy = await cloneSession(src, name, { withCookies: Boolean(req.body.withCookies) });
    orchestrator.log("info", "SESSION", `Cloned ${src} → ${copy.id}`, copy.id);
    res.json(publicRecord(copy));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------- Cookies ----------------

app.get("/api/sessions/:id/cookies", async (req, res) => {
  const id = req.params.id;
  if (!getSession(id)) return res.status(404).json({ error: "Session not found" });
  const live = orchestrator.live.get(id);
  let cookies = null;
  if (live) {
    try {
      cookies = await live.handle.rpc("cookies", {}, 10_000);
    } catch {
      // fall back to the last on-disk snapshot
    }
  }
  res.json(cookies || readCookies(id));
});

app.post("/api/sessions/:id/cookies", async (req, res) => {
  try {
    const id = req.params.id;
    if (!getSession(id)) return res.status(404).json({ error: "Session not found" });
    const cookies = normalizeCookies(req.body.cookies);
    const live = orchestrator.live.get(id);
    if (live) {
      await live.handle.rpc("add_cookies", { cookies }, 15_000);
      // Report what the browser kept, not what we sent: it can reject cookies silently.
      const landed = countLanded(cookies, await live.handle.rpc("cookies", {}, 10_000));
      const level = landed === cookies.length ? "success" : "warn";
      orchestrator.log(level, "COOKIE", `Imported ${landed} of ${cookies.length} cookies`, id);
      return res.json({ count: landed, total: cookies.length, applied: "now" });
    }
    stageCookieImport(id, cookies);
    orchestrator.log("info", "COOKIE", `Staged ${cookies.length} cookies for next launch`, id);
    res.json({ count: cookies.length, total: cookies.length, applied: "next launch" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------- Trash ----------------

app.get("/api/trash", (req, res) => {
  res.json(
    listTrash().map((r) => ({
      id: r.id,
      email: r.email,
      notes: r.notes || "",
      tags: r.tags || [],
      label: r.label || "",
      cookieCount: r.cookieCount || 0,
      proxy: r.proxy ? { host: r.proxy.host, port: r.proxy.port } : null,
      fingerprintFile: r.fingerprintFile,
      deletedAt: r.deletedAt,
      purgeAt: new Date(new Date(r.deletedAt).getTime() + TRASH_TTL_MS).toISOString(),
    }))
  );
});

app.post("/api/trash/:id/restore", async (req, res) => {
  try {
    const rec = await restoreSession(req.params.id);
    orchestrator.log("success", "SESSION", `Restored from trash: ${rec.id}`, rec.id);
    res.json(publicRecord(rec));
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

app.delete("/api/trash/:id", async (req, res) => {
  const gone = await purgeTrash({ id: req.params.id });
  if (!gone.length) {
    const still = listTrash().some((t) => t.id === req.params.id);
    return still
      ? res.status(409).json({ error: "couldn't delete it — its files are in use; try again shortly" })
      : res.status(404).json({ error: "not in the trash" });
  }
  orchestrator.log("warn", "SESSION", `Permanently deleted ${gone[0]}`, gone[0]);
  res.json({ ok: true, purged: gone });
});

app.delete("/api/trash", async (req, res) => {
  const gone = await purgeTrash({ maxAgeMs: 0 });
  if (gone.length) orchestrator.log("warn", "SESSION", `Emptied trash (${gone.length} profile(s))`);
  res.json({ ok: true, purged: gone });
});

// ---------------- Scripts ----------------

const scriptDeps = { orchestrator, getSession };

app.get("/api/scripts", (req, res) => res.json(scripts.list()));

app.post("/api/scripts", (req, res) => {
  try {
    res.json(scripts.create(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch("/api/scripts/:id", (req, res) => {
  try {
    const s = scripts.update(req.params.id, req.body);
    if (!s) return res.status(404).json({ error: "script not found" });
    res.json(s);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/scripts/:id", (req, res) => {
  if (!scripts.remove(req.params.id)) return res.status(404).json({ error: "script not found" });
  res.json({ ok: true });
});

// Runs a saved script, or an unsaved draft straight from the editor. Returns at once;
// per-profile progress streams over the WebSocket as `run` events.
app.post("/api/scripts/run", (req, res) => {
  if (!req.is("application/json")) return res.status(415).json({ error: "JSON only" });
  const { scriptId, draft, ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "pick at least one profile" });
  let script;
  try {
    if (scriptId) {
      script = scripts.get(scriptId);
      if (!script) return res.status(404).json({ error: "script not found" });
    } else if (draft) {
      script = scripts.validate({ name: draft.name || "Untitled", mode: draft.mode, code: draft.code });
    } else {
      return res.status(400).json({ error: "scriptId or draft is required" });
    }
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!script.code.trim()) return res.status(400).json({ error: "script is empty" });
  res.json(scripts.startRun(script, [...new Set(ids.map(String))], scriptDeps));
});

app.post("/api/scripts/runs/:id/stop", (req, res) => {
  if (!scripts.stopRun(req.params.id)) return res.status(404).json({ error: "run not found" });
  res.json({ ok: true });
});

app.get("/api/scripts/runs", (req, res) => res.json(scripts.recentRuns()));

// Screenshots taken by automation scripts. express.static refuses path traversal.
app.use("/api/screenshots", express.static(scripts.SHOTS, { fallthrough: false }));

// ---------------- WebSocket ----------------

const server = http.createServer(app);
// WebSockets bypass CORS entirely, so the same Host/Origin check has to gate the upgrade.
const wss = new WebSocketServer({ server, path: "/ws", verifyClient: ({ req }) => trusted(req) });
// ws re-emits the HTTP server's errors (e.g. EADDRINUSE) on itself; without a listener that
// throws before the server's own handler can explain "already running".
wss.on("error", () => {});

const BOOT_ID = require("crypto").randomBytes(4).toString("hex");

wss.on("connection", (ws) => {
  // Outside the route wrapper: a throw here (e.g. an unreadable store) would be uncaught and
  // take the server, and every open browser, down with it.
  try {
    ws.send(JSON.stringify({ type: "hello", data: { bootId: BOOT_ID, runs: scripts.recentRuns() } }));
    ws.send(JSON.stringify({ type: "pool", data: orchestrator.getStatus() }));
    ws.send(JSON.stringify({ type: "logs", data: orchestrator.getLogs(50) }));
  } catch (err) {
    console.error("[ws] greeting failed:", err.message);
  }
});

function broadcast(type, data) {
  const payload = JSON.stringify({ type, data });
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

orchestrator.on("log", (logEntry) => broadcast("log", logEntry));
orchestrator.on("pool:update", (pool) => broadcast("pool", pool));
orchestrator.on("session:update", (session) => broadcast("session", session));
scripts.events.on("run", (run) => broadcast("run", run));

// ---------------- Features ----------------
// Each module in ./features registers its own routes, settings keys and bulk actions
// through `deps`. See features/README.md. They load before the frontend catch-all below.

const deps = {
  app,
  orchestrator,
  manager: require("./manager"),
  scripts,
  broadcast,
  appSettings,
  readApp,
  bulk: BULK,
  testProxy,
  isWebUrl,
  cleanTags,
  ROOT,
  DATA_DIR,
  PORT,
  log: (level, category, message, sessionId) => orchestrator.log(level, category, message, sessionId),
};

const FEATURES = ["engine", "browsers", "home", "proxies", "organize", "templates", "automation", "windows", "history", "apidocs", "importexport"];
for (const name of FEATURES) {
  try {
    require(`./features/${name}`)(app, deps);
  } catch (err) {
    // One broken feature must not take the whole panel down.
    console.error(`[features] ${name} failed to load:`, err);
  }
}

// Serve frontend static build if present (two levels up in frontend/dist)
const FRONTEND_DIST = path.resolve(__dirname, "..", "..", "frontend", "dist");
if (fs.existsSync(FRONTEND_DIST)) {
  app.use(express.static(FRONTEND_DIST));
  app.get("*", (req, res) => {
    res.sendFile(path.join(FRONTEND_DIST, "index.html"));
  });
} else {
  app.get("/", (req, res) => {
    res.send(`
      <html>
        <head><title>SessionManagerPro Backend</title></head>
        <body style="font-family:sans-serif;background:#0b0f19;color:#fff;padding:40px;text-align:center;">
          <h1 style="color:#06b6d4;">SessionManagerPro API Server Active</h1>
          <p>Frontend UI is running or compiling. Access Vite dev server or run <code>npm run build</code>.</p>
          <p><a href="/api/stats" style="color:#38bdf8;">View API Stats</a> | <a href="/api/sessions" style="color:#38bdf8;">View Sessions</a></p>
        </body>
      </html>
    `);
  });
}

// Last resort for anything a route threw. Keeps the process — and the browsers — alive.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || "internal error" });
});

function openBrowser(url) {
  if (process.argv.includes("--no-open")) return;
  try {
    if (process.platform === "win32") {
      require("child_process").execFile("cmd", ["/c", "start", "", url], { windowsHide: true });
    } else {
      require("child_process").execFile(process.platform === "darwin" ? "open" : "xdg-open", [url]);
    }
  } catch {}
}

// Launch external terminal logger console
function openTerminalLogger() {
  try {
    const loggerScript = path.join(__dirname, "terminal_logger.js");
    if (process.platform === "win32") {
      const { spawn } = require("child_process");
      spawn(
        "cmd.exe",
        ["/c", "start", "SessionManagerPro — Live Console", process.execPath, loggerScript],
        {
          detached: true,
          stdio: "ignore",
          windowsHide: false,
        }
      )
        .on("error", () => {})
        .unref();
      return true;
    } else if (process.platform === "darwin") {
      const { spawn } = require("child_process");
      spawn(
        "osascript",
        [
          "-e",
          `tell application "Terminal" to do script "${process.execPath} \\"${loggerScript}\\""`,
        ],
        { detached: true, stdio: "ignore" }
      ).on("error", () => {}).unref();
      return true;
    } else {
      const { spawn } = require("child_process");
      spawn(
        "xterm",
        ["-title", "SessionManagerPro — Live Console", "-e", process.execPath, loggerScript],
        { detached: true, stdio: "ignore" }
      ).on("error", () => {}).unref();
      return true;
    }
  } catch (e) {
    console.error("Failed to launch terminal logger:", e);
    return false;
  }
}

// Terminal open endpoint
app.post("/api/terminal/open", (req, res) => {
  const ok = openTerminalLogger();
  res.json({ ok });
});

process.on("unhandledRejection", (err) => console.error("[server] unhandled rejection:", err));

function startServer() {
  const { warmFingerprintsCache } = require("./fingerprint");
  setTimeout(() => warmFingerprintsCache(), 100);

  // Trash older than 48h is purged at start and hourly after.
  const purge = () =>
    purgeTrash({ maxAgeMs: TRASH_TTL_MS })
      .then((gone) => gone.length && orchestrator.log("info", "SESSION", `Trash: purged ${gone.length} expired profile(s)`))
      .catch(() => {});
  purge();
  setInterval(purge, 60 * 60 * 1000).unref();

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.log(`\n  SessionManagerPro is already running at http://127.0.0.1:${PORT}\n`);
      openBrowser(`http://127.0.0.1:${PORT}`);
      process.exit(0);
    }
    throw err;
  });

  server.listen(PORT, HOST, () => {
    console.log(`\n  ======================================================`);
    console.log(`    SessionManagerPro Professional GUI Panel`);
    console.log(`    Server running at: http://${HOST}:${PORT}`);
    console.log(`    WebSocket stream: ws://127.0.0.1:${PORT}/ws`);
    console.log(`  ======================================================\n`);
    openBrowser(`http://127.0.0.1:${PORT}`);
    if (!process.argv.includes("--no-terminal")) {
      setTimeout(() => openTerminalLogger(), 400);
    }
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { app, server, startServer, openTerminalLogger };
