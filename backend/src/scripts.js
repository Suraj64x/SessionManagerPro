const fs = require("fs");
const { writeFileAtomic } = require("./fsutil");
const path = require("path");
const crypto = require("crypto");
const EventEmitter = require("events");
const { Worker } = require("worker_threads");

const ROOT = path.resolve(__dirname, "..", "..");
const DATA = path.join(ROOT, "data");
const FILE = path.join(DATA, "scripts.json");
const RUNTIME = path.join(DATA, "runtime");
const SHOTS = path.join(DATA, "screenshots");

// A profile that was just launched may still be loading its start pages; the worker holds
// ops for up to 30 s until they finish, so every deadline here carries that allowance.
const START_ALLOWANCE_MS = 35_000;
const PAGE_TIMEOUT_MS = 30_000 + START_ALLOWANCE_MS;
const AUTOMATION_TIMEOUT_MS = 10 * 60_000;
const MAX_CODE = 200_000;
const KEEP_RUNS = 30;
// Browsers a run launches itself can skip images and autoplay: a warm-up only needs the
// cookies, not the pixels. Never applied to a window the operator opened.
const SAVER_PREFS = { "permissions.default.image": 2, "media.autoplay.default": 5 };

/**
 * Built-in cookie robot. Read-only: it ships with the app and runs on the documented page
 * API only, with its settings arriving as `input` (see /api/warmup).
 */
const WARMUP = {
  id: "warmup",
  name: "Warm-up",
  mode: "automation",
  builtin: true,
  autoRun: false,
  match: "",
  tags: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  code: [
    "// Visits each site the way a person would, so the profile collects first-party",
    "// cookies and history before real use. Settings come from the Warm-up dialog.",
    "const sites = [...(input.sites || [])];",
    "if (!sites.length) throw new Error('no sites to visit');",
    "if (input.shuffle) for (let i = sites.length - 1; i > 0; i--) { const j = random(0, i); [sites[i], sites[j]] = [sites[j], sites[i]]; }",
    "const [dmin, dmax] = input.dwell || [20, 60];",
    "const hops = Math.min(3, Math.max(0, Number(input.links) || 0));",
    "const cookiesBefore = (await page.cookies()).length;",
    "",
    "// Reading like a person, with the human cursor: eased wheel flicks (mostly down), now and then",
    "// a scroll burst or the mouse wandering off; without scrolling, the mouse still moves. A step",
    "// that fails while a page is still changing is skipped, not fatal.",
    "const browse = async (until) => {",
    "  while (Date.now() < until) {",
    "    if (input.scroll !== false) {",
    "      await cursor.scroll(random(1, 5) * (random(0, 5) ? 1 : -1)).catch(() => {});",
    "      await cursor.scrollBurst(false).catch(() => {});",
    "    }",
    "    await cursor.wander(false).catch(() => {});",
    "    await sleep(Math.min(random(700, 2400), until - Date.now()));",
    "  }",
    "};",
    "// A random link that stays on the same host and isn't the current page, preferring one on",
    "// screen; `path` (a CSS path) when it can be clicked here: same tab, has a box, not a download.",
    "const pickLink = (host) => {",
    "  const here = location.href.split('#')[0];",
    "  const cssPath = (el) => { const p = []; for (; el.parentElement; el = el.parentElement) p.unshift(`${el.localName}:nth-child(${[...el.parentElement.children].indexOf(el) + 1})`); return p.join(' > '); };",
    "  const all = [];",
    "  for (const a of document.links) {",
    "    const u = a.href;",
    "    if (!/^https?:/.test(u) || u.split('#')[0] === here) continue;",
    "    let url;",
    "    try { url = new URL(u); } catch { continue; }",
    "    if (url.host !== host) continue;",
    "    const r = a.getBoundingClientRect();",
    "    const ok = a.localName === 'a' && (!a.target || a.target === '_self') && !a.hasAttribute('download') && r.width > 2 && r.height > 2 && !/\\.(pdf|zip|exe|msi|dmg|apk|mp[34])$/i.test(url.pathname);",
    "    all.push({ href: u, path: ok ? cssPath(a) : null, onScreen: ok && r.bottom > 0 && r.top < innerHeight });",
    "  }",
    "  const onScreen = all.filter((l) => l.onScreen);",
    "  const list = onScreen.length ? onScreen : all;",
    "  return list.length ? list[Math.floor(Math.random() * list.length)] : null;",
    "};",
    "// Clicked like a person (scrolled to, aimed at, pressed). A click that doesn't leave the page",
    "// (a script took it, it opened elsewhere) falls back to going there directly.",
    "const follow = async (link) => {",
    "  const from = await page.url();",
    "  const url = () => page.url().catch(() => from); // mid-navigation the tab may not answer yet",
    "  if (link.path) {",
    "    await cursor.click(link.path, { timeout: 5000 }).catch(() => {});",
    "    for (let i = 0; i < 20 && (await url()) === from; i++) await sleep(200);",
    "  }",
    "  if ((await url()) === from) await page.goto(link.href, { timeout: 45000 });",
    "  else await page.waitFor('body', { state: 'attached', timeout: 45000 });",
    "};",
    "",
    "let done = 0;",
    "for (const site of sites) {",
    "  const started = Date.now();",
    "  const until = started + random(dmin, dmax) * 1000;",
    "  try {",
    "    await page.goto(site, { timeout: 45000 });",
    "    for (let hop = 0; hop < hops; hop++) {",
    "      // Split the dwell across the landing page and each followed link.",
    "      await browse(started + ((until - started) * (hop + 1)) / (hops + 1));",
    "      const link = await page.evaluate(pickLink, new URL(await page.url()).host);",
    "      if (!link) break;",
    "      await follow(link);",
    "    }",
    "    await browse(until);",
    "    done++;",
    "    log(`${site} · ${Math.round((Date.now() - started) / 1000)}s`);",
    "  } catch (e) {",
    "    log(`${site} · ${e.message}`);",
    "  }",
    "}",
    "// Nothing opened is a failure, so Re-run failed picks this profile up.",
    "if (!done) throw new Error('no site could be opened');",
    "return { sites: done, cookiesBefore, cookiesAfter: (await page.cookies()).length };",
  ].join("\n"),
};

// Seeded once, on first read. None auto-run: nothing executes that the operator didn't ask for.
const EXAMPLES = [
  {
    name: "Page info",
    mode: "page",
    code: "return { title: document.title, url: location.href, links: document.links.length };",
  },
  {
    name: "Check exit IP",
    mode: "automation",
    code: [
      "await page.goto('https://ipinfo.io/json');",
      "const info = await page.evaluate(() => JSON.parse(document.body.innerText));",
      "log(`${info.ip} · ${info.city}, ${info.country}`);",
      "return info;",
    ].join("\n"),
  },
  {
    name: "Human scroll",
    mode: "automation",
    code: [
      "// Scrolls the current tab in uneven steps with pauses, like a person reading.",
      "for (let i = 0; i < random(6, 12); i++) {",
      "  await page.scroll(random(250, 700));",
      "  await sleep(random(600, 1800));",
      "}",
      "return await page.title();",
    ].join("\n"),
  },
  {
    name: "Hide cookie banners",
    mode: "page",
    autoRun: false,
    match: "",
    code: [
      "const sel = '[id*=cookie i],[class*=cookie i],[id*=consent i],[class*=consent i]';",
      "document.querySelectorAll(sel).forEach((el) => {",
      "  if (getComputedStyle(el).position === 'fixed') el.remove();",
      "});",
    ].join("\n"),
  },
].map((s) => ({ ...stamp(s), id: slugId(s.name) }));

function stamp(s) {
  const now = new Date().toISOString();
  return { autoRun: false, match: "", tags: [], ...s, createdAt: now, updatedAt: now };
}

function slugId(name) {
  return (
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32) || "script"
  ) + "-" + crypto.randomBytes(3).toString("hex");
}

/* ------------------------------------------------------------------ *
 * Store
 * ------------------------------------------------------------------ */

function readAll() {
  if (!fs.existsSync(FILE)) {
    writeAll(EXAMPLES);
    return EXAMPLES;
  }
  return JSON.parse(fs.readFileSync(FILE, "utf8"));
}

function writeAll(list) {
  writeFileAtomic(FILE, JSON.stringify(list, null, 2));
}

/** Returns a clean script object or throws with a message fit for a 400. */
function validate(input, base = {}) {
  const s = { ...base };
  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (!name || name.length > 80) throw new Error("name must be 1–80 characters");
    s.name = name;
  }
  if (input.mode !== undefined) {
    if (!["page", "automation"].includes(input.mode)) throw new Error("mode must be page or automation");
    s.mode = input.mode;
  }
  if (input.code !== undefined) {
    if (typeof input.code !== "string" || input.code.length > MAX_CODE) {
      throw new Error(`code must be text under ${MAX_CODE / 1000}k characters`);
    }
    s.code = input.code;
  }
  if (input.autoRun !== undefined) s.autoRun = Boolean(input.autoRun);
  if (input.match !== undefined) s.match = String(input.match).trim().slice(0, 500);
  if (input.tags !== undefined) s.tags = cleanTags(input.tags);

  if (!s.name) throw new Error("name is required");
  if (!s.mode) s.mode = "page";
  if (typeof s.code !== "string") s.code = "";
  // Auto-run means "inject into every page at launch" — only meaningful in-page.
  if (s.mode !== "page") s.autoRun = false;
  return s;
}

function cleanTags(tags) {
  if (!Array.isArray(tags)) throw new Error("tags must be a list");
  return [...new Set(tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 20).map((t) => t.slice(0, 24));
}

const list = () => [...readAll(), WARMUP];
const get = (id) => (id === WARMUP.id ? WARMUP : readAll().find((s) => s.id === id) || null);
const refuseBuiltin = (id) => {
  if (id !== WARMUP.id) return;
  const err = new Error("the built-in Warm-up script is read-only");
  err.status = 400; // server.js's last-resort handler answers with it
  throw err;
};

function create(input) {
  const all = readAll();
  const s = { ...stamp(validate(input)), id: slugId(input.name) };
  all.push(s);
  writeAll(all);
  return s;
}

function update(id, patch) {
  refuseBuiltin(id);
  const all = readAll();
  const i = all.findIndex((s) => s.id === id);
  if (i < 0) return null;
  all[i] = { ...validate(patch, all[i]), id, createdAt: all[i].createdAt, updatedAt: new Date().toISOString() };
  writeAll(all);
  return all[i];
}

function remove(id) {
  refuseBuiltin(id);
  const all = readAll();
  const next = all.filter((s) => s.id !== id);
  if (next.length === all.length) return false;
  writeAll(next);
  return true;
}

/* ------------------------------------------------------------------ *
 * Auto-run: injected on every page of matching profiles at launch
 * ------------------------------------------------------------------ */

const PAGE_HELPERS =
  "const __smpLogs = [];\n" +
  "const log = (...a) => { __smpLogs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };\n" +
  "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));\n" +
  "const random = (min, max) => Math.floor(min + Math.random() * (max - min + 1));\n";

/** In-page wrapper for a run: the user's body plus helpers, returning value and logs. */
function wrapPage(code) {
  return (
    "async () => {\n" +
    PAGE_HELPERS +
    "const __smpValue = await (async () => {\n" +
    code +
    "\n})();\n" +
    "return { __smp: 1, value: __smpValue, logs: __smpLogs };\n}"
  );
}

/** `*://*.example.com/*` → anchored RegExp source. Empty glob matches everything. */
function globToRegex(glob) {
  if (!glob) return "";
  return "^" + glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, "\\$&")).join(".*") + "$";
}

function wrapInit(s) {
  const re = globToRegex(s.match);
  // Plain concatenation, never a template: user code may contain backticks and ${}.
  return (
    "(() => {\n" +
    "  if (window.top !== window) return;\n" +
    (re ? "  if (!new RegExp(" + JSON.stringify(re) + ").test(location.href)) return;\n" : "") +
    "  const log = (...a) => console.log(" + JSON.stringify("[" + s.name + "]") + ", ...a);\n" +
    "  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));\n" +
    "  const random = (min, max) => Math.floor(min + Math.random() * (max - min + 1));\n" +
    "  const run = async () => {\n" +
    "    try {\n" +
    s.code +
    "\n    } catch (e) {\n" +
    "      console.warn(" + JSON.stringify("[SessionManager] " + s.name + ":") + ", e);\n" +
    "    }\n" +
    "  };\n" +
    "  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });\n" +
    "  else run();\n" +
    "})();"
  );
}

/** Writes this profile's auto-run bundle and returns its path, or null when there is none. */
function writeInitScripts(record) {
  const profileTags = new Set(record.tags || []);
  const scripts = readAll().filter(
    (s) => s.autoRun && s.mode === "page" && s.code.trim() && (!s.tags?.length || s.tags.some((t) => profileTags.has(t)))
  );
  const file = path.join(RUNTIME, `${record.id}.init.json`);
  if (!scripts.length) {
    fs.rmSync(file, { force: true });
    return null;
  }
  fs.mkdirSync(RUNTIME, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(scripts.map(wrapInit)));
  return file;
}

/* ------------------------------------------------------------------ *
 * Runs
 * ------------------------------------------------------------------ */

const events = new EventEmitter();
const runs = new Map();

/** A short, display-safe rendering of whatever a script returned. */
function preview(value) {
  if (value === undefined) return null;
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return text && text.length > 4000 ? text.slice(0, 4000) + "\n…truncated" : text;
}

function snapshot(run) {
  return {
    id: run.id,
    scriptId: run.scriptId,
    scriptName: run.scriptName,
    mode: run.mode,
    startedAt: run.startedAt,
    cancelled: run.cancelled,
    options: run.options,
    scheduleId: run.scheduleId,
    results: run.results,
  };
}

const publish = (run) => events.emit("run", snapshot(run));
const isActive = (run) => Object.values(run.results).some((r) => r.state === "pending" || r.state === "running");
const safeSegment = (id) => String(id).replace(/[<>:"/\\|?*]/g, "_");

/**
 * Automation runs in its own worker thread. A synchronous infinite loop in user code
 * would otherwise freeze the whole server — and with it every open browser — and
 * neither Stop nor the timeout could interrupt it. terminate() always can.
 * The thread has no browser access of its own: every page.* call is posted to the
 * main thread, which forwards it to the Python worker over RPC.
 */
const THREAD_SRC = String.raw`
const { parentPort, workerData } = require("worker_threads");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const pending = new Map();
let seq = 0;
parentPort.on("message", (m) => {
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  m.ok ? p.res(m.value) : p.rej(new Error(m.error));
});
const call = (op, payload = {}) =>
  new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    parentPort.postMessage({ type: "rpc", id, op, payload });
  });
const show = (x) => {
  if (typeof x === "string") return x;
  if (x instanceof Error) return x.stack || x.message;
  try { return JSON.stringify(x, null, 2); } catch { return String(x); }
};
// Batched: a log() in a tight loop must not flood the server with one message per line.
let logBuf = [];
let logTimer = null;
const flushLogs = () => {
  clearTimeout(logTimer);
  logTimer = null;
  if (logBuf.length) parentPort.postMessage({ type: "logs", lines: logBuf });
  logBuf = [];
};
const log = (...a) => {
  logBuf.push(a.map(show).join(" "));
  if (logBuf.length > 50) logBuf = logBuf.slice(-50);
  if (!logTimer) logTimer = setTimeout(flushLogs, 100);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));
const random = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const page = {
  goto: (url, o = {}) => call("goto", { url: String(url), waitUntil: o.waitUntil, timeout: o.timeout }),
  click: (selector, o = {}) => call("click", { selector, timeout: o.timeout }),
  fill: (selector, value, o = {}) => call("fill", { selector, value, timeout: o.timeout }),
  type: (selector, text, o = {}) => call("type", { selector, text, delay: o.delay, timeout: o.timeout }),
  press: (a, b) => (b === undefined ? call("press", { key: a }) : call("press", { selector: a, key: b })),
  waitFor: (selector, o = {}) => call("wait_for", { selector, state: o.state, timeout: o.timeout }),
  evaluate: (fn, arg) => call("eval", { code: typeof fn === "function" ? fn.toString() : String(fn), arg }),
  scroll: (dy = 600) => call("scroll", { dy }),
  newTab: (url) => call("new_tab", { url }),
  url: () => call("info").then((i) => i.url),
  title: () => call("info").then((i) => i.title),
  cookies: () => call("cookies"),
  screenshot: (o = {}) => call("screenshot", { fullPage: o.fullPage }),
};
page.waitForSelector = page.waitFor;
// The human cursor (ENGINE.md §1, human_* ops): curved, paced pointer paths, eased wheel flicks,
// human clicks and WPM typing, all real input events. Names and defaults as in humanCursor.js.
// Globals rather than parameters, so a script may also say const cursor = createHumanCursor(page).
const cursor = {
  ensureIntro: () => call("human_move", {}),
  moveTo: (x, y) => call("human_move", typeof x === "string" ? { selector: x } : { x, y }),
  click: (selector, o = {}) => call("human_click", { ...o, selector }),
  clickAt: (x, y, o = {}) => call("human_click", { ...o, x, y }),
  type: (text, o = {}) => call("human_type", { ...o, text: String(text) }),
  scroll: (notches, cfg = {}) => call("human_scroll", { ...cfg, notches }),
  scrollPx: (px, cfg = {}) => call("human_scroll", { ...cfg, px }),
  scrollTo: (selector, o = {}) => call("human_scroll", { ...o, selector }),
  wander: (force = false) => call("human_wander", { force: Boolean(force) }),
  scrollBurst: (force = false) => call("human_scroll_burst", { force: Boolean(force) }),
};
cursor.clickElement = cursor.click;
cursor.scrollToSelector = cursor.scrollTo;
cursor.wanderMouse = cursor.wander;
Object.assign(globalThis, {
  cursor,
  createHumanCursor: () => cursor,
  ghostHumanScroll: (_page, _ghost, notches, opts = {}, cfg = {}) => cursor.scroll(notches, { ...opts, ...cfg }),
  smoothScrollPx: (_page, _ghost, px, opts = {}, cfg = {}) => cursor.scrollPx(px, { ...opts, ...cfg }),
});
(async () => {
  const fn = new AsyncFunction("page", "profile", "log", "sleep", "random", "input", workerData.code);
  const value = await fn(page, workerData.profile, log, sleep, random, workerData.input || {});
  flushLogs();
  parentPort.postMessage({ type: "done", value: value === undefined ? undefined : show(value) });
})().catch((e) => {
  flushLogs();
  parentPort.postMessage({ type: "error", error: (e && e.message) || String(e) });
});
`;

/** Per-op timeout: `timeout: 0` means "no limit" (bounded by the run's own limit); typing scales with the text. */
function opTimeout(op, payload, limitMs) {
  if (payload.timeout != null) {
    const t = Number(payload.timeout);
    return Number.isFinite(t) && t > 0 ? t : limitMs;
  }
  if (op === "type") return 30_000 + String(payload.text ?? "").length * ((payload.delay ?? 70) + 50);
  // Human typing runs at the profile's WPM (22-78) with pauses and fixed slips: up to ~1 s a key.
  if (op === "human_type") return 30_000 + String(payload.text ?? "").length * 1_000;
  return 30_000;
}

function runAutomation(run, script, sessionId, live, profile, onLog) {
  return new Promise((resolve, reject) => {
    // By design this is host-level code execution, reachable only from the local panel:
    // server.js pins the Host, the Origin and the peer address to loopback.
    const thread = new Worker(THREAD_SRC, { eval: true, workerData: { code: script.code, profile, input: run.options.input } });
    let pinned = null; // the tab this execution drives; it survives navigations
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run.threads.delete(thread);
      thread.terminate();
      fn(arg);
    };
    const limitMs = run.options.limitMs;
    const timer = setTimeout(() => finish(reject, new Error(`timed out after ${Math.round(limitMs / 60_000)} minutes`)), limitMs);
    thread.stop = () => finish(reject, new Error("stopped"));
    run.threads.add(thread);

    thread.on("message", async (m) => {
      if (settled) return;
      if (m.type === "logs") return onLog(m.lines);
      if (m.type === "done") return finish(resolve, m.value);
      if (m.type === "error") return finish(reject, new Error(m.error));
      if (m.type !== "rpc") return;
      try {
        const payload = { ...m.payload };
        payload.timeout = opTimeout(m.op, payload, limitMs);
        let shotUrl;
        if (m.op === "screenshot") {
          const name = `${Date.now()}.png`;
          payload.path = path.join(SHOTS, safeSegment(sessionId), name);
          shotUrl = `/api/screenshots/${encodeURIComponent(safeSegment(sessionId))}/${name}`;
        }
        // Pin the tab on first use, so a popup or a background tab navigating mid-run
        // can't redirect the script's clicks somewhere else.
        if (m.op !== "new_tab") {
          if (pinned == null) pinned = (await live.handle.rpc("info", {}, 10_000 + START_ALLOWANCE_MS)).pageId;
          if (settled) return; // stopped while pinning: don't touch the browser any more
          payload.pageId = pinned;
        }
        let value = await live.handle.rpc(m.op, payload, payload.timeout + START_ALLOWANCE_MS);
        if (m.op === "new_tab") {
          pinned = value.pageId;
          value = value.url;
        }
        if (shotUrl) value = shotUrl;
        if (!settled) thread.postMessage({ id: m.id, ok: true, value });
      } catch (err) {
        if (!settled) thread.postMessage({ id: m.id, ok: false, error: err.message });
      }
    });
    thread.on("error", (err) => finish(reject, err));
    thread.on("exit", () => finish(reject, new Error("script ended without a result")));
  });
}

async function execute(run, script, sessionId, deps) {
  const { orchestrator, getSession } = deps;
  const result = run.results[sessionId];
  if (run.cancelled) return;
  const live = orchestrator.live.get(sessionId);
  if (!live) {
    Object.assign(result, { state: "error", error: "not running — launch it first" });
    return publish(run);
  }
  try {
    await executeLive(run, script, sessionId, live, getSession, orchestrator);
  } finally {
    // The run opened (or was told to close) this window; the operator asked for it to go.
    if (run.options.stopAfter) orchestrator.stop(sessionId).catch(() => {});
  }
}

async function executeLive(run, script, sessionId, live, getSession, orchestrator) {
  const result = run.results[sessionId];

  const say = (level, msg) => orchestrator.log(level, "SCRIPT", `${script.name}: ${msg}`, sessionId);
  Object.assign(result, { state: "running", startedAt: new Date().toISOString(), logs: [] });
  publish(run);

  const t0 = Date.now();
  try {
    let value;
    if (script.mode === "page") {
      // Playwright calls a string that evaluates to a function, so a body with `return`
      // and `await` works like a DevTools snippet. log/sleep/random match automation mode.
      const out = await live.handle.rpc("eval", { code: wrapPage(script.code) }, PAGE_TIMEOUT_MS);
      if (run.cancelled) throw new Error("stopped");
      value = out?.__smp ? out.value : out;
      if (out?.__smp && out.logs?.length) {
        result.logs = out.logs.slice(-50);
        for (const line of result.logs) say("info", line);
      }
    } else {
      const rec = getSession(sessionId) || {};
      const profile = {
        id: rec.id,
        email: rec.email,
        notes: rec.notes || "",
        tags: rec.tags || [],
        proxy: rec.proxy ? { host: rec.proxy.host, port: rec.proxy.port } : null,
      };
      value = await runAutomation(run, script, sessionId, live, profile, (lines) => {
        result.logs = [...(result.logs || []), ...lines].slice(-50);
        for (const line of lines) say("info", line);
        publish(run);
      });
    }
    Object.assign(result, { state: "ok", value: preview(value), ms: Date.now() - t0 });
    say("success", `finished in ${result.ms} ms`);
  } catch (err) {
    const stopped = run.cancelled || err?.message === "stopped";
    Object.assign(result, {
      state: stopped ? "stopped" : "error",
      error: stopped ? "stopped" : err?.message || String(err),
      ms: Date.now() - t0,
    });
    say(stopped ? "warn" : "error", result.error);
  }
  publish(run);
}

/**
 * Queues `ids` once and reports each one as soon as it is live or has failed, with the
 * same outcomes as orchestrator.launchAndWait. Per id, not all at once: with more targets
 * than the thread cap, the pool only frees a slot once an earlier profile's script has run
 * and closed it, so waiting for the whole batch would never finish.
 */
function launchEach(orchestrator, ids, opts, timeoutMs, onSettled) {
  const pending = new Set(ids);
  // One timer per profile, started when it leaves the queue: waiting for a free slot is not
  // a failed launch (with more targets than the thread cap, later waves wait a long time).
  const timers = new Map();
  const settle = (id, result) => {
    if (!pending.delete(id)) return;
    clearTimeout(timers.get(id));
    timers.delete(id);
    onSettled(id, result);
    if (!pending.size) cleanup();
  };
  const onLaunched = ({ id }) => settle(id, { ok: true });
  const onUpdate = ({ id, status, reason }) => status === "error" && settle(id, { ok: false, error: reason });
  const onPool = () => {
    for (const id of [...pending]) {
      if (orchestrator.starting.has(id) && !timers.has(id)) {
        const t = setTimeout(() => {
          settle(id, { ok: false, error: "timed out waiting for the launch" });
          // Take it out of the pool, so a late window doesn't hold a slot nobody uses.
          orchestrator.stop(id).catch(() => {});
        }, timeoutMs);
        t.unref?.();
        timers.set(id, t);
      } else if (!orchestrator.live.has(id) && !orchestrator.queue.includes(id) && !orchestrator.starting.has(id)) {
        // Dropped from the queue by stop()/stopAll() before it started: nothing else reports it.
        settle(id, { ok: false, error: "removed from queue" });
      }
    }
  };
  const cleanup = () => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    orchestrator.off("session:launched", onLaunched);
    orchestrator.off("session:update", onUpdate);
    orchestrator.off("pool:update", onPool);
  };
  orchestrator.on("session:launched", onLaunched);
  orchestrator.on("session:update", onUpdate);
  orchestrator.on("pool:update", onPool);
  orchestrator.launch(ids, opts);
  onPool();
  return cleanup;
}

// Set by the automation feature, which owns the saved site sets.
let warmupDefaults = () => ({ sites: [] });
const setWarmupDefaults = (fn) => (warmupDefaults = fn);

/** Every site's longest dwell plus a page-load allowance, plus the launch's worst case. */
const warmupLimit = (input) => (input?.sites?.length || 0) * ((input?.dwell?.[1] || 60) + 15) * 1000 + 120_000;

/** The run options as stored on the run: every field present, nothing unserialisable. */
function cleanOptions(o = {}, deps) {
  const launch = Boolean(o.launch);
  // An explicit choice (the Warm-up dialog's checkbox) wins; otherwise the app setting.
  const saveTraffic = typeof o.saveTraffic === "boolean" ? o.saveTraffic : Boolean(deps.readApp?.()?.trafficSaver);
  const limitMs = Number(o.limitMs);
  return {
    launch,
    stopAfter: Boolean(o.stopAfter),
    headless: Boolean(o.headless),
    saveTraffic,
    prefs: launch && saveTraffic ? { ...(o.prefs || {}), ...SAVER_PREFS } : o.prefs && typeof o.prefs === "object" ? o.prefs : undefined,
    limitMs: Number.isFinite(limitMs) && limitMs > 0 ? Math.min(limitMs, 24 * 60 * 60_000) : AUTOMATION_TIMEOUT_MS,
    input: o.input && typeof o.input === "object" ? o.input : undefined,
  };
}

/**
 * Starts a run and returns immediately; progress arrives through `events`.
 * `script` is either a saved script or an unsaved draft from the editor.
 * `options`: { launch, stopAfter, headless, prefs, saveTraffic, limitMs, input, scheduleId }.
 */
function startRun(script, sessionIds, deps, options = {}) {
  if (script.id === WARMUP.id) {
    // Started from a plain script menu: the Warm-up uses the first saved site set.
    const input = options.input || warmupDefaults();
    options = { ...options, input, limitMs: options.limitMs || warmupLimit(input) };
  }
  const run = {
    id: crypto.randomBytes(4).toString("hex"),
    script,
    scriptId: script.id || null,
    scriptName: script.name || "Untitled",
    mode: script.mode,
    startedAt: new Date().toISOString(),
    cancelled: false,
    options: cleanOptions(options, deps),
    scheduleId: options.scheduleId ? String(options.scheduleId) : null,
    threads: new Set(),
    results: Object.fromEntries(sessionIds.map((id) => [id, { state: "pending" }])),
  };
  runs.set(run.id, run);
  // Forget the oldest finished runs, never one still running — Stop must be able to find it.
  for (const [id, old] of runs) {
    if (runs.size <= KEEP_RUNS) break;
    if (!isActive(old)) runs.delete(id);
  }

  const { orchestrator } = deps;
  const { launch, headless, prefs } = run.options;
  const toLaunch = launch ? sessionIds.filter((id) => !orchestrator.live.has(id)) : [];
  orchestrator.log(
    "info",
    "SCRIPT",
    `Running "${run.scriptName}" on ${sessionIds.length} profile(s)${toLaunch.length ? `, launching ${toLaunch.length}` : ""}`
  );
  publish(run);
  for (const id of sessionIds) if (!toLaunch.includes(id)) execute(run, script, id, deps);
  if (toLaunch.length) {
    run.launching = new Set(toLaunch);
    run.orchestrator = orchestrator;
    // Each launch gets the engine's worst case once it leaves the queue (ENGINE.md §2).
    run.stopLaunch = launchEach(orchestrator, toLaunch, { headless, prefs }, 120_000, (id, r) => {
      if (run.cancelled) return;
      if (r.ok) return execute(run, script, id, deps);
      Object.assign(run.results[id], { state: "error", error: `launch failed: ${r.error}` });
      orchestrator.log("error", "SCRIPT", `${run.scriptName}: launch failed: ${r.error}`, id);
      publish(run);
    });
  }
  return snapshot(run);
}

/** A new run of the same script and options on the profiles that failed. */
function rerunFailed(runId, deps) {
  const run = runs.get(runId);
  if (!run) return null;
  const ids = Object.entries(run.results)
    .filter(([, r]) => r.state === "error")
    .map(([id]) => id);
  if (!ids.length) throw new Error("no failed profiles in that run");
  return startRun(run.script, ids, deps, { ...run.options, scheduleId: run.scheduleId });
}

function stopRun(runId) {
  const run = runs.get(runId);
  if (!run) return false;
  run.cancelled = true;
  for (const [id, r] of Object.entries(run.results)) {
    if (r.state !== "pending") continue;
    r.state = "stopped";
    // Still queued by this run: it would open a window nobody asked to keep.
    if (run.options.stopAfter && run.launching?.has(id)) run.orchestrator.stop(id).catch(() => {});
  }
  for (const thread of [...run.threads]) thread.stop();
  run.stopLaunch?.(); // queued launches carry on in the pool; only the waiting ends
  publish(run);
  return true;
}

const recentRuns = () => [...runs.values()].map(snapshot).reverse();

module.exports = {
  list,
  get,
  create,
  update,
  remove,
  validate,
  writeInitScripts,
  startRun,
  stopRun,
  rerunFailed,
  recentRuns,
  events,
  SHOTS,
  WARMUP,
  SAVER_PREFS,
  setWarmupDefaults,
  warmupLimit,
  // exported for the self-check
  globToRegex,
  wrapInit,
  wrapPage,
};
