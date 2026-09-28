const fs = require("fs");
const path = require("path");
const EventEmitter = require("events");
const {
  ensureSessions,
  openSession,
  getSession,
  saveSessionPatch,
} = require("./manager");

class Orchestrator extends EventEmitter {
  constructor() {
    super();
    this.live = new Map(); // id -> { id, handle, startedAt, url, headless, exitIp, country }
    this.queue = [];
    this.starting = new Set(); // ids between dequeue and a live handle
    // id -> the exit of a worker that reported closed but whose browser is still quitting: a
    // relaunch of that profile waits for it (the profile folder is locked until then).
    this.exiting = new Map();
    // id -> thread number (1, 2, 3...): the lowest free one, from launch until the profile
    // closes. On Stealth Firefox's taskbar icon and in the panel's running badge.
    this.slots = new Map();
    // Each queued profile keeps the options of the launch that queued it ({ url, headless,
    // prefs }), so a later launch can't rewrite how earlier queued profiles open.
    this.queueOpts = new Map();
    this.threadLimit = 5;
    this.defaultUrl = "";
    this.filling = false;
    this.stopping = false;
    this.logs = [];
    this.maxLogs = 500;
    this.logCounter = 0;

    // Point to root updates folder
    this.updatesDir = path.resolve(__dirname, "..", "..", "updates");
    this.logFilePath = path.join(this.updatesDir, "session_status.log");
  }

  log(level, category, message, sessionId = null) {
    // Script output and page text reach the console window and the log file; strip control
    // characters so they can't inject terminal escapes or forge extra log lines.
    message = String(message).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
    const entry = {
      id: ++this.logCounter,
      timestamp: new Date().toISOString(),
      level, // 'info' | 'success' | 'warn' | 'error'
      category, // 'SESSION' | 'PROXY' | 'FINGERPRINT' | 'BROWSER' | 'QUEUE' | 'COOKIE'
      message,
      sessionId,
    };
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
    this.emit("log", entry);

    try {
      if (!fs.existsSync(this.updatesDir)) {
        fs.mkdirSync(this.updatesDir, { recursive: true });
      }
      fs.appendFileSync(
        this.logFilePath,
        `[${entry.timestamp}] [${entry.category}] ${sessionId ? `${sessionId} : ` : ""}${entry.level.toUpperCase()} : ${entry.message}\n`
      );
    } catch {
      // ignore write errors
    }
    return entry;
  }

  getLogs(limit = 100) {
    return this.logs.slice(-Math.min(limit, this.logs.length));
  }

  getStatus() {
    const liveSessions = [];
    for (const [id, item] of this.live.entries()) {
      const s = getSession(id);
      liveSessions.push({
        id,
        startedAt: item.startedAt,
        url: item.url,
        headless: item.headless,
        exitIp: item.exitIp,
        country: item.country,
        slot: item.slot,
        // Broadcast to every panel and the console: never with the password.
        proxy: s?.proxy ? { scheme: s.proxy.scheme, host: s.proxy.host, port: s.proxy.port } : undefined,
        fingerprintFile: s?.fingerprintFile,
        browser: s?.browser || "stealth-firefox",
      });
    }
    return {
      live: liveSessions,
      queued: [...this.queue],
      threadLimit: this.threadLimit,
      defaultUrl: this.defaultUrl,
      activeCount: this.live.size,
      queuedCount: this.queue.length,
      isFilling: this.filling,
    };
  }

  async markResult(id, status, reason) {
    try {
      await saveSessionPatch(id, {
        lastResult: { status, reason, at: new Date().toISOString() },
      });
    } catch (err) {
      // ignore patch errors on deleted sessions
    }
    // Emitted even when the record is gone: launchAndWait() relies on it to report a failure.
    this.emit("session:update", { id, status, reason });
  }

  watchHandle(handle, url) {
    handle.closedByUser = false;
    handle.error = null;
    // On the handle, not only in `live`: a worker can die before startOne reaches live.set.
    handle.startedAt = new Date().toISOString();

    const flag = (why) => {
      if (!handle.error) handle.error = why;
    };

    handle.on("error", (err) => {
      const msg = err?.message || String(err);
      flag(msg);
      this.log("error", "BROWSER", `Browser worker error in ${handle.id}: ${msg}`, handle.id);
    });

    const proc = handle.process || (typeof handle.browser?.process === "function" ? handle.browser.process() : null);
    if (proc) {
      proc.on("exit", (code, signal) => {
        if (code && code !== 0) {
          flag(`Worker exit code ${code}${signal ? ` ${signal}` : ""}`);
        }
      });
    }

    const emitter = typeof handle.once === "function" ? handle : handle.browser;
    emitter.once("disconnected", async (reasonMsg) => {
      this.live.delete(handle.id);
      this.slots.delete(handle.id);
      if (handle.exited) {
        const gone = handle.exited;
        this.exiting.set(handle.id, gone);
        gone.then(() => this.exiting.get(handle.id) === gone && this.exiting.delete(handle.id));
      }
      let status, reason;
      if (handle.closedByUser || reasonMsg === "closed by user" || reasonMsg === "browser closed") {
        status = "success";
        reason = "closed by user";
      } else if (handle.error) {
        status = "error";
        reason = handle.error;
      } else {
        status = "success";
        reason = reasonMsg || "browser terminated normally";
      }

      await this.markResult(handle.id, status, reason);
      this.log(
        status === "error" ? "error" : "success",
        "SESSION",
        `Session finished: ${status} (${reason})`,
        handle.id
      );
      const endedAt = new Date();
      const durationMs = Math.max(0, endedAt - new Date(handle.startedAt));
      this.emit("session:closed", {
        id: handle.id,
        status,
        reason,
        startedAt: handle.startedAt,
        endedAt: endedAt.toISOString(),
        durationMs,
        closedByUser: reason === "closed by user",
      });
      try {
        const rec = getSession(handle.id);
        if (rec) await saveSessionPatch(handle.id, { workSeconds: (rec.workSeconds || 0) + Math.round(durationMs / 1000) });
      } catch {
        // deleted meanwhile
      }
      this.emit("pool:update", this.getStatus());

      // Auto refill the pool with next queued item
      this.fillPool();
    });
  }

  async startOne(name, customUrl = null) {
    this.starting.add(name);
    try {
      this.log("info", "QUEUE", `Initializing session: ${name}`, name);
      await ensureSessions([name]);
      const rec = getSession(name);

      if (rec?.proxy?.host) {
        this.log(
          "info",
          "PROXY",
          `Assigned sticky proxy: ${rec.proxy.host}:${rec.proxy.port}${rec.proxy.username ? " (authenticated)" : ""}`,
          name
        );
      } else {
        this.log("warn", "PROXY", "No proxy attached or direct connection", name);
      }

      const vp = rec?.fingerprint?.viewport || {};
      this.log(
        "info",
        "FINGERPRINT",
        `Applied fingerprint: ${rec?.fingerprintFile || "Bayesian Profile"} (seed ${rec?.seed || "auto"}, ${vp.width || 1920}x${vp.height || 1080}, timezone from exit IP)`,
        name
      );

      // The engine's name for the log: records without `browser` run Stealth Firefox.
      const engineName = require("./browsers").nameOf(rec?.browser || "stealth-firefox");
      await this.markResult(name, "running", `launching ${engineName}`);
      const queued = this.queueOpts.get(name) || {};
      this.queueOpts.delete(name);
      const url = customUrl || (queued.url !== undefined ? queued.url : this.defaultUrl) || undefined;
      const quitting = this.exiting.get(name);
      if (quitting) await Promise.race([quitting, new Promise((r) => setTimeout(r, 20000))]);
      const taken = new Set(this.slots.values());
      let slot = 1;
      while (taken.has(slot)) slot++;
      this.slots.set(name, slot);
      const handle = await openSession(name, { url, headless: queued.headless, prefs: queued.prefs, slot });

      this.watchHandle(handle, url);
      for (const note of handle.launchNotes || []) {
        if (note.event === "init_scripts") this.log("info", "SCRIPT", `Auto-run: ${note.count} script(s) injected`, name);
        else if (note.event === "cookies_imported")
          this.log(note.count === note.total ? "success" : "warn", "COOKIE", `Imported ${note.count} of ${note.total} staged cookies`, name);
        else this.log("error", "COOKIE", `Cookie import failed: ${note.error}`, name);
      }
      const item = {
        id: name,
        handle,
        startedAt: handle.startedAt,
        url: url || "restore tabs",
        headless: Boolean(handle.headless),
        exitIp: handle.exitIp,
        country: handle.country,
        slot: this.slots.get(name),
      };
      this.live.set(name, item);
      this.emit("session:launched", {
        id: name,
        startedAt: item.startedAt,
        headless: item.headless,
        ...(item.exitIp ? { exitIp: item.exitIp } : {}),
        ...(item.country ? { country: item.country } : {}),
      });
      try {
        await saveSessionPatch(name, {
          launchCount: (getSession(name)?.launchCount || 0) + 1,
          ...(item.exitIp ? { lastExitIp: item.exitIp } : {}),
          ...(item.country ? { lastCountry: item.country } : {}),
        });
      } catch {
        // deleted meanwhile
      }

      this.log(
        "success",
        "BROWSER",
        `${engineName} opened (${this.live.size}/${this.threadLimit} live)`,
        name
      );
      this.emit("pool:update", this.getStatus());
    } catch (err) {
      const reason = err.message || String(err);
      this.slots.delete(name);
      this.log("error", "SESSION", `Failed to launch ${name}: ${reason}`, name);
      await this.markResult(name, "error", reason);
      this.emit("pool:update", this.getStatus());
    } finally {
      this.starting.delete(name);
    }
  }

  /** Throws if the profile's browser is being launched right now (it can't be closed yet). */
  assertNotStarting(id) {
    if (this.starting.has(id)) throw new Error(`${id} is still launching — try again in a moment`);
  }

  async fillPool() {
    if (this.stopping || this.filling) return;
    this.filling = true;
    try {
      const jobs = [];
      while (this.live.size + jobs.length < this.threadLimit && this.queue.length) {
        const name = this.queue.shift();
        if (!name || this.live.has(name)) continue;
        jobs.push(this.startOne(name));
        if (this.live.size + jobs.length < this.threadLimit && this.queue.length) {
          await new Promise((r) => setTimeout(r, 800));
        }
      }
      this.emit("pool:update", this.getStatus());
      await Promise.all(jobs);
    } finally {
      this.filling = false;
      if (!this.stopping && this.live.size < this.threadLimit && this.queue.length) {
        this.fillPool();
      }
    }
  }

  async launch(names, opts = {}) {
    // A profile between dequeue and "live" is in `starting`: queueing it again would spawn
    // a second worker on the same locked profile folder.
    const list = [...new Set(names)].filter(
      (n) => n && !this.live.has(n) && !this.queue.includes(n) && !this.starting.has(n)
    );
    if (!list.length) return false;

    if (opts.threads && Number(opts.threads) > 0) {
      this.threadLimit = Number(opts.threads);
    }
    if (opts.url !== undefined) {
      this.defaultUrl = String(opts.url).trim();
    }

    for (const name of list) this.queueOpts.set(name, { url: this.defaultUrl, headless: opts.headless, prefs: opts.prefs });
    this.queue.push(...list);
    this.log(
      "info",
      "QUEUE",
      `Queued ${list.length} sessions (Thread cap: ${this.threadLimit})`
    );
    this.emit("pool:update", this.getStatus());

    this.fillPool();
    return true;
  }

  /**
   * Queues `ids` like launch() and resolves once each one is live or has failed:
   * { id: { ok, error? } }. Ids already live resolve ok at once. The timeout only marks
   * what is still pending as `timed out`; those launches carry on in the background.
   */
  launchAndWait(ids, opts = {}, { timeoutMs = 120_000 } = {}) {
    const out = {};
    const pending = new Set([...new Set(ids)].filter(Boolean));
    for (const id of [...pending]) {
      if (this.live.has(id)) {
        out[id] = { ok: true };
        pending.delete(id);
      }
    }
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.off("session:launched", onLaunched);
        this.off("session:update", onUpdate);
        this.off("pool:update", onPool);
        resolve(out);
      };
      const settle = (id, result) => {
        if (!pending.delete(id)) return;
        out[id] = result;
        if (!pending.size) finish();
      };
      const onLaunched = ({ id }) => settle(id, { ok: true });
      const onUpdate = ({ id, status, reason }) => {
        if (status === "error") settle(id, { ok: false, error: reason });
      };
      // Dropped from the queue by stop()/stopAll() before it started: nothing else reports it.
      const onPool = () => {
        for (const id of [...pending]) {
          if (!this.live.has(id) && !this.queue.includes(id) && !this.starting.has(id)) {
            settle(id, { ok: false, error: "removed from queue" });
          }
        }
      };
      const timer = setTimeout(() => {
        for (const id of pending) out[id] = { ok: false, error: "timed out" };
        pending.clear();
        finish();
      }, timeoutMs);
      timer.unref?.();
      this.on("session:launched", onLaunched);
      this.on("session:update", onUpdate);
      this.on("pool:update", onPool);
      if (!pending.size) return finish();
      this.launch([...pending], opts);
    });
  }

  async stop(id) {
    const item = this.live.get(id);
    if (!item) {
      // Remove from queue if present
      const qIdx = this.queue.indexOf(id);
      if (qIdx >= 0) {
        this.queue.splice(qIdx, 1);
        this.queueOpts.delete(id);
        this.log("info", "QUEUE", `Removed from queue: ${id}`, id);
        this.emit("pool:update", this.getStatus());
        return true;
      }
      return false;
    }
    this.log("info", "BROWSER", `Closing browser window for ${id}...`, id);
    item.handle.closedByUser = true;
    try {
      await item.handle.close();
    } catch {
      // browser may already be closing
    }
    return true;
  }

  async stopAll() {
    this.stopping = true;
    this.queue = [];
    this.queueOpts.clear();
    this.log("warn", "QUEUE", "Stopping all running browsers and clearing queue");
    const handles = [...this.live.values()];
    await Promise.all(
      handles.map((item) => {
        item.handle.closedByUser = true;
        return Promise.resolve(item.handle.close()).catch(() => {});
      })
    );
    this.live.clear();
    this.stopping = false;
    this.emit("pool:update", this.getStatus());
    return true;
  }
}

const orchestrator = new Orchestrator();
module.exports = orchestrator;
