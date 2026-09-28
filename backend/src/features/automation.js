// Warm-up (cookie robot), schedules, re-run failed. See README.md in this folder for deps.
const fs = require("fs");
const { writeFileAtomic } = require("../fsutil");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_SETS = [
  {
    name: "General",
    urls: [
      "https://www.google.com",
      "https://www.youtube.com",
      "https://en.wikipedia.org",
      "https://www.amazon.com",
      "https://www.reddit.com",
      "https://www.bbc.com",
      "https://weather.com",
      "https://www.imdb.com",
    ],
  },
];
const TICK_MS = 30_000;
// A run due longer ago than this was missed (PC asleep, a stalled tick): skipped, not
// backfilled. Anything already due when the app starts was missed while it was closed.
const GRACE_MS = 2 * 60_000;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

/** One URL per entry; a bare host gets https://. Throws on anything that isn't http(s). */
function cleanUrls(list, max = 50) {
  if (!Array.isArray(list)) throw bad("urls must be a list");
  const out = [];
  for (const raw of list) {
    const s = String(raw).trim();
    if (!s) continue;
    const u = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
    let url;
    try {
      url = new URL(u);
    } catch {
      throw bad(`not a web address: ${s.slice(0, 100)}`);
    }
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname) throw bad(`not a web address: ${s.slice(0, 100)}`);
    if (!out.includes(url.href)) out.push(url.href);
  }
  if (!out.length) throw bad("add at least one site");
  if (out.length > max) throw bad(`at most ${max} sites`);
  return out;
}

const int = (v, min, max, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} must be a whole number from ${min} to ${max}`);
  return n;
};

/** The Warm-up script's `input`. Accepts `urls` (the dialog) or `sites` (a stored schedule). */
function cleanWarmupInput(b = {}) {
  const dwell = b.dwell === undefined ? [20, 60] : b.dwell;
  if (!Array.isArray(dwell) || dwell.length !== 2) throw bad("dwell must be [min, max] seconds");
  const min = int(dwell[0], 1, 600, "dwell");
  const max = int(dwell[1], 1, 600, "dwell");
  if (min > max) throw bad("dwell minimum is above its maximum");
  return {
    sites: cleanUrls(b.sites ?? b.urls),
    dwell: [min, max],
    scroll: b.scroll === undefined ? true : Boolean(b.scroll),
    links: b.links === undefined ? 1 : int(b.links, 0, 3, "links"),
    shuffle: b.shuffle === undefined ? true : Boolean(b.shuffle),
  };
}

function cleanSets(v) {
  if (!Array.isArray(v) || v.length > 20) throw new Error("warmupSets must be a list of at most 20 sets");
  const seen = new Set();
  return v.map((set) => {
    const name = String(set?.name ?? "").trim();
    if (!name || name.length > 40) throw new Error("a site set needs a name of 1–40 characters");
    if (seen.has(name.toLowerCase())) throw new Error(`two sets are named "${name}"`);
    seen.add(name.toLowerCase());
    return { name, urls: cleanUrls(set.urls) };
  });
}

/* ------------------------------------------------------------------ *
 * Schedules
 * ------------------------------------------------------------------ */

/** Next fire time strictly after `after`, in local time; null when there is none. */
function nextRunOf(rule, after = new Date()) {
  const t = after.getTime();
  if (rule.kind === "once") {
    const at = Date.parse(rule.at);
    return at > t ? new Date(at).toISOString() : null;
  }
  if (rule.kind === "every") return new Date(t + rule.minutes * 60_000).toISOString();
  const [h, m] = rule.time.split(":").map(Number);
  // Eight days covers "same weekday, but today's time has passed".
  for (let i = 0; i <= 7; i++) {
    const d = new Date(after);
    d.setDate(d.getDate() + i);
    d.setHours(h, m, 0, 0);
    if (d.getTime() > t && (rule.kind === "daily" || rule.days.includes(d.getDay()))) return d.toISOString();
  }
  return null;
}

function cleanRule(r = {}) {
  if (r.kind === "every") return { kind: "every", minutes: int(r.minutes, 5, 10_080, "minutes") };
  if (r.kind === "daily" || r.kind === "weekly") {
    if (!TIME.test(String(r.time))) throw bad("time must be HH:MM");
    if (r.kind === "daily") return { kind: "daily", time: r.time };
    if (!Array.isArray(r.days)) throw bad("days must be a list of weekdays 0–6");
    const days = [...new Set(r.days.map((d) => int(d, 0, 6, "days")))].sort();
    if (!days.length) throw bad("pick at least one day");
    return { kind: "weekly", days, time: r.time };
  }
  if (r.kind === "once") {
    const at = Date.parse(r.at);
    if (!Number.isFinite(at)) throw bad("at must be a date and time");
    return { kind: "once", at: new Date(at).toISOString() };
  }
  throw bad("rule kind must be every, daily, weekly or once");
}

function cleanTargets(t = {}) {
  if (t.kind === "all") return { kind: "all", value: null };
  if (["tag", "status", "folder"].includes(t.kind)) {
    const value = String(t.value ?? "").trim();
    if (!value || value.length > 80) throw bad(`pick a ${t.kind}`);
    return { kind: t.kind, value: t.kind === "tag" ? value.toLowerCase() : value };
  }
  if (t.kind === "ids") {
    if (!Array.isArray(t.value) || !t.value.length || t.value.length > 1000) throw bad("pick 1–1000 profiles");
    return { kind: "ids", value: [...new Set(t.value.map(String))] };
  }
  throw bad("targets kind must be all, tag, status, folder or ids");
}

module.exports = function register(app, deps) {
  const { orchestrator, manager, scripts, broadcast, appSettings, readApp, DATA_DIR, log } = deps;
  const FILE = path.join(DATA_DIR, "schedules.json");
  const runDeps = { orchestrator, getSession: (id) => manager.getSession(id), readApp };

  appSettings.register("warmupSets", DEFAULT_SETS, cleanSets);
  scripts.setWarmupDefaults(() => ({
    sites: readApp().warmupSets?.[0]?.urls || [],
    dwell: [20, 60],
    scroll: true,
    links: 1,
    shuffle: true,
  }));

  /* ---------------- warm-up ---------------- */

  const cleanIds = (ids) => {
    if (!Array.isArray(ids) || !ids.length) throw bad("pick at least one profile");
    const out = [...new Set(ids.map(String))];
    if (out.length > 1000) throw bad("at most 1000 profiles");
    const unknown = out.find((id) => !manager.getSession(id));
    if (unknown) throw bad(`unknown profile: ${unknown}`);
    return out;
  };

  app.post("/api/warmup", (req, res) => {
    const b = req.body || {};
    const ids = cleanIds(b.ids);
    const input = cleanWarmupInput(b);
    res.json(
      scripts.startRun(scripts.WARMUP, ids, runDeps, {
        launch: true,
        headless: Boolean(b.hidden),
        stopAfter: Boolean(b.stopAfter),
        // Left out, the app's trafficSaver setting decides (scripts.js).
        saveTraffic: typeof b.saveTraffic === "boolean" ? b.saveTraffic : undefined,
        limitMs: scripts.warmupLimit(input),
        input,
      })
    );
  });

  app.post("/api/scripts/runs/:id/rerun-failed", (req, res) => {
    let run;
    try {
      run = scripts.rerunFailed(req.params.id, runDeps);
    } catch (err) {
      return res.status(409).json({ error: err.message });
    }
    if (!run) return res.status(404).json({ error: "run not found" });
    res.json(run);
  });

  /* ---------------- schedule store ---------------- */

  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(FILE, "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err; // a damaged file must not be overwritten with an empty list
    }
  };
  const write = (list) => {
    writeFileAtomic(FILE, JSON.stringify(list, null, 2));
    broadcast("schedule", list);
  };

  function cleanScript(s = {}) {
    if (s.builtin === "warmup" || s.scriptId === scripts.WARMUP.id) {
      return { builtin: "warmup", input: cleanWarmupInput(s.input) };
    }
    const id = String(s.scriptId ?? "");
    if (!id || !scripts.get(id)) throw bad("pick a script");
    return { scriptId: id };
  }

  function cleanSchedule(b, base = {}) {
    const s = { ...base };
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (!name || name.length > 80) throw bad("name must be 1–80 characters");
      s.name = name;
    }
    if (b.enabled !== undefined) s.enabled = Boolean(b.enabled);
    if (b.script !== undefined) s.script = cleanScript(b.script);
    if (b.targets !== undefined) s.targets = cleanTargets(b.targets);
    if (b.rule !== undefined) s.rule = cleanRule(b.rule);
    if (b.options !== undefined || !s.options) {
      const o = { ...s.options, ...b.options };
      s.options = {
        launch: Boolean(o.launch),
        stopAfter: Boolean(o.stopAfter),
        hidden: o.hidden === undefined ? true : Boolean(o.hidden),
        skipIfRunning: o.skipIfRunning === undefined ? true : Boolean(o.skipIfRunning),
      };
    }
    for (const key of ["name", "script", "targets", "rule"]) if (!s[key]) throw bad(`${key} is required`);
    if (s.enabled === undefined) s.enabled = true;
    // A warm-up without its own browser has nothing to drive.
    if (s.script.builtin) s.options.launch = true;
    if (b.rule !== undefined && s.rule.kind === "once" && Date.parse(s.rule.at) <= Date.now()) {
      throw bad("pick a time in the future");
    }
    return s;
  }

  /* ---------------- firing ---------------- */

  const tally = (run) => {
    const rs = Object.values(run.results);
    return {
      ok: rs.filter((r) => r.state === "ok").length,
      failed: rs.filter((r) => r.state === "error").length,
      done: !rs.some((r) => r.state === "pending" || r.state === "running"),
    };
  };

  function resolveTargets(t) {
    const all = manager.listSessions();
    const lc = (v) => String(v || "").toLowerCase();
    if (t.kind === "ids") {
      const exist = new Set(all.map((s) => s.id));
      return t.value.filter((id) => exist.has(id));
    }
    const match = {
      all: () => true,
      tag: (s) => (s.tags || []).includes(t.value),
      status: (s) => lc(s.label) === lc(t.value),
      folder: (s) => lc(s.folder) === lc(t.value),
    }[t.kind];
    return all.filter(match).map((s) => s.id);
  }

  /** Starts the schedule's run and returns its snapshot, or throws the reason it was skipped. */
  function startScheduled(s) {
    const prev = s.lastRun?.runId && scripts.recentRuns().find((r) => r.id === s.lastRun.runId);
    if (prev && !tally(prev).done) throw Object.assign(new Error("its previous run is still going"), { stillRunning: true });
    const script = s.script.builtin ? scripts.WARMUP : scripts.get(s.script.scriptId);
    if (!script) throw new Error("its script was deleted");
    if (!script.code.trim()) throw new Error("its script is empty");
    const busy = (id) => orchestrator.live.has(id) || orchestrator.queue.includes(id) || orchestrator.starting.has(id);
    let ids = resolveTargets(s.targets);
    // Without launching, only open profiles can run; with it, skip-if-running spares windows in use.
    if (!s.options.launch) ids = ids.filter((id) => orchestrator.live.has(id));
    else if (s.options.skipIfRunning) ids = ids.filter((id) => !busy(id));
    if (!ids.length) throw new Error(s.options.launch ? "no matching profiles" : "none of its profiles are running");
    const input = s.script.builtin ? s.script.input : undefined;
    return scripts.startRun(script, ids, runDeps, {
      launch: s.options.launch,
      headless: s.options.hidden,
      stopAfter: s.options.stopAfter,
      input,
      limitMs: input ? scripts.warmupLimit(input) : undefined,
      scheduleId: s.id,
    });
  }

  /** Fires one schedule. `manual` (Run now) keeps its timetable and reports a skip as an error. */
  function fire(id, manual) {
    const list = read();
    const s = list.find((x) => x.id === id);
    if (!s) return null;
    const at = new Date().toISOString();
    let run = null;
    let note = null;
    let stillRunning = false;
    try {
      run = startScheduled(s);
    } catch (err) {
      note = err.message;
      stillRunning = Boolean(err.stillRunning);
    }
    if (manual && !run) return { schedule: s, run: null, note };
    // Seeded from the snapshot: profiles that fail at once report before this line. A skip
    // while the previous run is still going keeps that run as lastRun — overwriting it would
    // drop the overlap guard, and the next tick would start a second run on top of it.
    if (run) s.lastRun = { at, runId: run.id, ...tally(run) };
    else if (!stillRunning) s.lastRun = { at, runId: null, ok: 0, failed: 0, done: true, note };
    if (!manual) s.nextRun = nextRunOf(s.rule, new Date());
    write(list);
    const n = run ? Object.keys(run.results).length : 0;
    log(
      run ? "info" : "warn",
      "SCRIPT",
      run ? `Schedule "${s.name}": started "${run.scriptName}" on ${n} profile(s)` : `Schedule "${s.name}": skipped, ${note}`
    );
    return { schedule: s, run, note };
  }

  function tick() {
    let list;
    try {
      list = read();
    } catch (err) {
      return log("error", "SCRIPT", `Schedules: can't read schedules.json: ${err.message}`);
    }
    const now = Date.now();
    let missed = false;
    for (const s of list) {
      if (!s.enabled || !s.nextRun || Date.parse(s.nextRun) > now) continue;
      if (Date.parse(s.nextRun) < bootAt || now - Date.parse(s.nextRun) > GRACE_MS) {
        log("info", "SCRIPT", `Schedule "${s.name}": missed ${new Date(s.nextRun).toLocaleString()}, skipped`);
        s.nextRun = nextRunOf(s.rule, new Date(now));
        missed = true;
      }
    }
    if (missed) write(list);
    for (const s of list) {
      if (s.enabled && s.nextRun && Date.parse(s.nextRun) <= now) fire(s.id, false);
    }
  }
  const bootAt = Date.now();
  // Outside any route: an exception here (e.g. EPERM writing schedules.json while antivirus
  // holds it) would be uncaught and take the server — and every browser — down with it.
  const safeTick = () => {
    try {
      tick();
    } catch (err) {
      log("error", "SCRIPT", `Schedules: tick failed: ${err.message}`);
    }
  };
  safeTick();
  setInterval(safeTick, TICK_MS).unref();

  // Keep lastRun's counts current while its run progresses.
  scripts.events.on("run", (run) => {
    if (!run.scheduleId) return;
    try {
      const list = read();
      const s = list.find((x) => x.id === run.scheduleId);
      if (!s || s.lastRun?.runId !== run.id) return;
      const t = tally(run);
      if (t.ok === s.lastRun.ok && t.failed === s.lastRun.failed && t.done === s.lastRun.done) return;
      Object.assign(s.lastRun, t);
      write(list);
    } catch {
      // the run carries on; the counts catch up on its next event
    }
  });

  /* ---------------- routes ---------------- */

  app.get("/api/schedules", (req, res) => res.json(read()));

  app.post("/api/schedules", (req, res) => {
    const list = read();
    if (list.length >= 100) return res.status(400).json({ error: "at most 100 schedules" });
    const s = cleanSchedule(req.body || {});
    const out = { id: crypto.randomBytes(4).toString("hex"), ...s, lastRun: null };
    out.nextRun = out.enabled ? nextRunOf(out.rule) : null;
    list.push(out);
    write(list);
    res.json(out);
  });

  app.patch("/api/schedules/:id", (req, res) => {
    const list = read();
    const i = list.findIndex((x) => x.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: "schedule not found" });
    const b = req.body || {};
    const next = { ...cleanSchedule(b, list[i]), id: list[i].id };
    if (b.rule !== undefined || b.enabled !== undefined) next.nextRun = next.enabled ? nextRunOf(next.rule) : null;
    list[i] = next;
    write(list);
    res.json(next);
  });

  app.delete("/api/schedules/:id", (req, res) => {
    const list = read();
    const next = list.filter((x) => x.id !== req.params.id);
    if (next.length === list.length) return res.status(404).json({ error: "schedule not found" });
    write(next);
    res.json({ ok: true });
  });

  app.post("/api/schedules/:id/run", (req, res) => {
    const out = fire(req.params.id, true);
    if (!out) return res.status(404).json({ error: "schedule not found" });
    if (!out.run) return res.status(409).json({ error: `Skipped: ${out.note}` });
    res.json(out);
  });
};

// For the self-check.
module.exports.nextRunOf = nextRunOf;
module.exports.cleanWarmupInput = cleanWarmupInput;
