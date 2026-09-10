const http = require("http");
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const { WebSocketServer } = require("ws");

const {
  listSessions,
  getSession,
  createSessionRecord,
  deleteSession,
  saveSessionPatch,
  ensureSessions,
  parseProxy,
  listAllProxies,
  listAllFingerprints,
  getSystemStats,
  parseCsvAccounts,
  nextSessionIds,
  syncSheetEdits,
  ACCOUNT_FILE,
} = require("./manager");

const orchestrator = require("./orchestrator");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Helper: Test proxy connectivity
function testProxy(p) {
  return new Promise((resolve) => {
    const start = Date.now();
    const headers = { Host: "api.ipify.org" };
    if (p.username) {
      headers["Proxy-Authorization"] =
        "Basic " + Buffer.from(`${p.username}:${p.password || ""}`).toString("base64");
    }
    const req = http.request(
      {
        host: p.host,
        port: Number(p.port),
        method: "GET",
        path: "http://api.ipify.org?format=json",
        headers,
        timeout: 6000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          const latency = Date.now() - start;
          try {
            const parsed = JSON.parse(data);
            resolve({ ok: true, latency, ip: parsed.ip });
          } catch {
            resolve({ ok: true, latency, ip: data.trim() || p.host });
          }
        });
      }
    );
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "Connection timed out (6s)" });
    });
    req.end();
  });
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
      ...s,
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
  res.json(s);
});

// Create single session
app.post("/api/sessions/create", async (req, res) => {
  try {
    const { name, proxy, fingerprintFile } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Session name is required" });
    }
    // The proxy pool is published as URLs; the record needs the parsed parts.
    let parsedProxy = proxy;
    if (typeof proxy === "string" && proxy.trim()) {
      try {
        parsedProxy = parseProxy(proxy);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }
    const session = await createSessionRecord(name.trim(), {
      proxy: parsedProxy,
      fingerprintFile,
    });
    orchestrator.log("info", "SESSION", `Created profile: ${session.id}`, session.id);
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    res.json({ created, existing });
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
    if (typeof req.body.notes === "string") patch.notes = req.body.notes;

    if (req.body.proxy !== undefined) {
      const raw = req.body.proxy;
      const p = typeof raw === "string" ? parseProxy(raw) : raw;
      if (!p || !p.host || !Number.isInteger(Number(p.port)) || Number(p.port) < 1) {
        return res.status(400).json({ error: "proxy needs a host and port, and cannot be cleared" });
      }
      patch.proxy = {
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
    const others = listSessions().filter((s) => s.id !== current.id);
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
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete session
app.delete("/api/sessions/:id", async (req, res) => {
  try {
    const id = req.params.id;
    await orchestrator.stop(id);
    const ok = await deleteSession(id);
    if (!ok) return res.status(404).json({ error: "Session not found" });
    orchestrator.log("warn", "SESSION", `Deleted profile data for ${id}`, id);
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
app.post("/api/accounts/import", (req, res) => {
  try {
    const { csvContent } = req.body;
    if (!csvContent || typeof csvContent !== "string") {
      return res.status(400).json({ error: "csvContent string required" });
    }
    fs.writeFileSync(ACCOUNT_FILE, csvContent.trim() + "\n", "utf8");
    const accounts = parseCsvAccounts();
    orchestrator.log("info", "QUEUE", `Imported ${accounts.length} account names from CSV`);
    res.json({ ok: true, count: accounts.length, accounts });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
  if (!Number.isInteger(threads) || threads < 1 || threads > 50) {
    return res.status(400).json({ error: "threads must be an integer between 1 and 50" });
  }
  orchestrator.threadLimit = threads;
  orchestrator.log("info", "QUEUE", `Thread cap set to ${threads}`);
  orchestrator.emit("pool:update", orchestrator.getStatus());
  if (orchestrator.queue.length) orchestrator.fillPool();
  res.json(orchestrator.getStatus());
});

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

// Create HTTP and WebSocket server
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "pool", data: orchestrator.getStatus() }));
  ws.send(JSON.stringify({ type: "logs", data: orchestrator.getLogs(50) }));
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

const PORT = process.env.PORT || 3001;

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

function startServer() {
  const { warmFingerprintsCache } = require("./fingerprint");
  setTimeout(() => warmFingerprintsCache(), 100);

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`\n  ======================================================`);
    console.log(`    SessionManagerPro Professional GUI Panel`);
    console.log(`    Server running at: http://127.0.0.1:${PORT}`);
    console.log(`    WebSocket stream: ws://127.0.0.1:${PORT}/ws`);
    console.log(`  ======================================================\n`);
    openBrowser(`http://127.0.0.1:${PORT}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { app, server, startServer };
