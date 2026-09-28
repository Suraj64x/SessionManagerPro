// apidocs feature: the checkPages/trafficSaver settings, POST /api/sessions/:id/op and
// POST /api/sessions/:id/cdp. Starts the server in-process on port 3013 with a fake live handle
// for /op (the real handle.rpc is covered by rpc_check.js) and one real headless Chromium
// worker for /cdp (a qa- profile under os.tmpdir(); its records are faked in memory, never
// written). Restores data/app.json and removes its screenshots and the worker's cookie dump.
//
//   node backend/test/apidocs_check.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const ROOT = path.resolve(__dirname, "..", "..");
process.chdir(ROOT);
process.argv.push("--no-open", "--no-terminal");
const PORT = 3013;
process.env.PORT = String(PORT);
const { server } = require(path.join(ROOT, "backend/src/server.js"));
const orchestrator = require(path.join(ROOT, "backend/src/orchestrator.js"));
const manager = require(path.join(ROOT, "backend/src/manager.js"));
const browsers = require(path.join(ROOT, "backend/src/browsers.js"));
const { launchWorker } = require(path.join(ROOT, "backend/src/worker_runner.js"));

const APP = path.join(ROOT, "data", "app.json");
const appBackup = fs.existsSync(APP) ? fs.readFileSync(APP) : null;
const LIVE_ID = "qa-apidocs-live";
const SHOTS = path.join(ROOT, "data", "screenshots", LIVE_ID);
const DEFAULTS = ["https://pixelscan.net", "https://www.browserscan.net", "https://abrahamjuliot.github.io/creepjs/", "https://ipinfo.io"];
const CDP_ID = "qa-apidocs-cdp";
const CDP_DIR = path.join(os.tmpdir(), CDP_ID);
const CDP_COOKIES = path.join(ROOT, "data", "cookies", `${CDP_ID}.json`);

// Records for the /cdp route, in memory only: qa- ids answer from here, every other id as usual.
const FAKE = {};
const realGetSession = manager.getSession;
manager.getSession = (id) => FAKE[id] || realGetSession(id);
let cdpHandle = null;

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(p, { method = "GET", body } = {}) {
  const headers = { Host: `127.0.0.1:${PORT}`, "X-SMP": "1" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { code: res.status, json, text, type: res.headers.get("content-type") || "" };
}

// Records every call; `window` fails like the worker does on a headless profile.
const calls = [];
const fakeHandle = {
  rpc: async (op, payload, timeoutMs) => {
    calls.push({ op, payload, timeoutMs });
    if (op === "window") throw new Error("no browser window found");
    if (op === "screenshot") {
      fs.mkdirSync(path.dirname(payload.path), { recursive: true });
      fs.writeFileSync(payload.path, Buffer.from("89504e470d0a1a0a", "hex"));
      return payload.path;
    }
    if (op === "info") return { url: "about:blank", title: "", pageId: "p1", headless: true };
    return null;
  },
};

async function main() {
  // --- settings: defaults, validation, persistence
  // First-run defaults for my keys only; the user's other settings stay in place for any
  // other server that reads app.json while this runs.
  if (appBackup) {
    const { checkPages, trafficSaver, ...rest } = JSON.parse(appBackup);
    fs.writeFileSync(APP, JSON.stringify(rest, null, 2));
  }
  const a0 = await req("/api/app");
  check("GET /api/app: checkPages defaults to the 4 check sites", JSON.stringify(a0.json?.checkPages) === JSON.stringify(DEFAULTS), a0.text.slice(0, 200));
  check("GET /api/app: trafficSaver defaults to false", a0.json?.trafficSaver === false);

  const t1 = await req("/api/app", { method: "PATCH", body: { trafficSaver: true } });
  check("PATCH trafficSaver=true persists", t1.json?.trafficSaver === true && JSON.parse(fs.readFileSync(APP, "utf8")).trafficSaver === true, t1.text.slice(0, 120));
  check("PATCH trafficSaver='yes' is refused", (await req("/api/app", { method: "PATCH", body: { trafficSaver: "yes" } })).code === 400);

  const c1 = await req("/api/app", { method: "PATCH", body: { checkPages: [" https://example.com/a ", "https://example.com/a", "http://127.0.0.1:8080/x"] } });
  check("PATCH checkPages trims and dedupes", JSON.stringify(c1.json?.checkPages) === JSON.stringify(["https://example.com/a", "http://127.0.0.1:8080/x"]), c1.text.slice(0, 160));
  for (const [label, bad] of [
    ["an empty list", []],
    ["11 URLs", Array.from({ length: 11 }, (_, i) => `https://example.com/${i}`)],
    ["a non-http URL", ["ftp://example.com"]],
    ["about:blank", ["about:blank"]],
    ["a string", "https://example.com"],
  ]) {
    const r = await req("/api/app", { method: "PATCH", body: { checkPages: bad } });
    check(`PATCH checkPages refuses ${label}`, r.code === 400 && /checkPages/.test(r.json?.error || ""), `HTTP ${r.code} ${r.json?.error || ""}`);
  }
  check("a refused PATCH left the stored list alone", JSON.stringify((await req("/api/app")).json?.checkPages) === JSON.stringify(["https://example.com/a", "http://127.0.0.1:8080/x"]));

  // --- op: guards
  const noOp = await req(`/api/sessions/${LIVE_ID}/op`, { method: "POST", body: { url: "https://example.com" } });
  check("op missing → 400 listing the allowed ops", noOp.code === 400 && /goto/.test(noOp.json?.error || ""), noOp.text.slice(0, 120));
  check("op outside the allow-list → 400", (await req(`/api/sessions/${LIVE_ID}/op`, { method: "POST", body: { op: "shell" } })).code === 400);
  const down = await req(`/api/sessions/${LIVE_ID}/op`, { method: "POST", body: { op: "info" } });
  check("op on a profile that is not running → 404", down.code === 404 && /not running/.test(down.json?.error || ""), down.text.slice(0, 120));
  check("no X-SMP header → 403", (await fetch(`http://127.0.0.1:${PORT}/api/sessions/${LIVE_ID}/op`, { method: "POST", headers: { Host: `127.0.0.1:${PORT}`, "Content-Type": "application/json" }, body: "{}" })).status === 403);

  // --- op: forwarding through a live handle
  orchestrator.live.set(LIVE_ID, { id: LIVE_ID, handle: fakeHandle, startedAt: new Date().toISOString(), url: "about:blank" });

  const info = await req(`/api/sessions/${LIVE_ID}/op`, { method: "POST", body: { op: "info" } });
  check("info → { ok: true, value }", info.code === 200 && info.json?.ok === true && info.json?.value?.pageId === "p1", info.text.slice(0, 120));
  check("default RPC deadline is 30 s + 35 s start-page allowance, payload untouched", calls.at(-1)?.timeoutMs === 65_000 && calls.at(-1)?.op === "info" && !("timeout" in calls.at(-1).payload), JSON.stringify(calls.at(-1)));

  await req(`/api/sessions/${LIVE_ID}/op`, { method: "POST", body: { op: "goto", url: "https://example.com", waitUntil: "load", timeout: 500_000 } });
  const g = calls.at(-1);
  check("payload fields are forwarded (url, waitUntil)", g?.op === "goto" && g.payload.url === "https://example.com" && g.payload.waitUntil === "load", JSON.stringify(g));
  check("timeout is capped at 120 s in both the payload and the RPC deadline", g?.payload.timeout === 120_000 && g.timeoutMs === 155_000, JSON.stringify(g));

  await req(`/api/sessions/${LIVE_ID}/op`, { method: "POST", body: { op: "wait_for", selector: "#x", timeout: 2000 } });
  check("a short timeout is honoured", calls.at(-1)?.payload.timeout === 2000 && calls.at(-1)?.timeoutMs === 37_000, JSON.stringify(calls.at(-1)));

  const shot = await req(`/api/sessions/${LIVE_ID}/op`, { method: "POST", body: { op: "screenshot", fullPage: true } });
  const shotCall = calls.at(-1);
  check("screenshot writes under data/screenshots/<id>/ and returns its /api/screenshots URL",
    shot.json?.ok === true && /^\/api\/screenshots\/qa-apidocs-live\/\d+\.png$/.test(shot.json?.value || "") && shotCall?.payload.path?.startsWith(SHOTS) && shotCall.payload.fullPage === true,
    `${shot.text.slice(0, 120)} path=${shotCall?.payload.path}`);
  const served = shot.json?.value ? await req(shot.json.value) : { code: 0 };
  check("the screenshot URL is served", served.code === 200 && /image\/png/.test(served.type), `HTTP ${served.code} ${served.type}`);

  const win = await req(`/api/sessions/${LIVE_ID}/op`, { method: "POST", body: { op: "window", action: "focus" } });
  check("a failing op → 400 { ok: false, error } with the worker's message", win.code === 400 && win.json?.ok === false && /no browser window/.test(win.json?.error || ""), win.text.slice(0, 120));
  check("server still alive afterwards", (await req("/api/pool")).code === 200);

  await cdpChecks();
}

/** One CDP command over its own websocket, sent with no Origin header like Playwright's and Puppeteer's. */
function cdpCall(wsUrl, method) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => (ws.terminate(), reject(new Error(`${method} timed out`))), 5000);
    ws.on("open", () => ws.send(JSON.stringify({ id: 1, method })));
    ws.on("message", (data) => {
      const m = JSON.parse(data);
      if (m.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    });
    ws.on("error", (err) => (clearTimeout(timer), reject(err)));
  });
}

async function cdpChecks() {
  const cdp = (id) => req(`/api/sessions/${id}/cdp`, { method: "POST" });
  const none = await cdp("qa-apidocs-none");
  check("cdp: unknown profile → 404", none.code === 404 && /not found/.test(none.json?.error || ""), none.text.slice(0, 120));
  check("cdp: no X-SMP header → 403", (await fetch(`http://127.0.0.1:${PORT}/api/sessions/${CDP_ID}/cdp`, { method: "POST", headers: { Host: `127.0.0.1:${PORT}` } })).status === 403);

  FAKE["qa-apidocs-stealth"] = { id: "qa-apidocs-stealth" }; // no `browser`: Stealth Firefox
  const stealth = await cdp("qa-apidocs-stealth");
  check("cdp: Stealth Firefox profile → 409 that points to /op", stealth.code === 409 && /^Stealth Firefox has no CDP endpoint/.test(stealth.json?.error || "") && /\/op$/.test(stealth.json.error), stealth.text.slice(0, 160));
  const running = await cdp(LIVE_ID); // the fake live handle: no cdpPort, no record
  check("cdp: a running Stealth Firefox profile → 409 as well", running.code === 409 && /Stealth Firefox/.test(running.json?.error || ""), running.text.slice(0, 160));

  const list = await browsers.list();
  const ff = list.find((b) => b.kind === "firefox-manual" && b.installed);
  if (ff) {
    FAKE["qa-apidocs-ff"] = { id: "qa-apidocs-ff", browser: ff.id };
    const r = await cdp("qa-apidocs-ff");
    check(`cdp: manual Firefox profile (${ff.name}) → 409`, r.code === 409 && r.json?.error === `${ff.name} has no CDP endpoint: it is a manual-only browser`, r.text.slice(0, 160));
  } else check("cdp: manual Firefox profile → 409 (skipped: none installed)", true);

  const chrome = list.find((b) => b.id === "chrome" && b.installed) || list.find((b) => b.kind === "chromium" && b.installed && !b.limited);
  if (!chrome) return check("cdp: running Chromium profile (skipped: no Chromium browser installed)", true);
  FAKE[CDP_ID] = { id: CDP_ID, browser: chrome.id };
  const idle = await cdp(CDP_ID);
  check("cdp: Chromium profile that is not running → 409", idle.code === 409 && /not running/.test(idle.json?.error || ""), idle.text.slice(0, 120));

  // A real headless worker, held live the way the orchestrator holds one.
  const page = "data:text/html," + encodeURIComponent("<title>qa cdp</title>");
  const t0 = Date.now();
  cdpHandle = await launchWorker({ id: CDP_ID, userDataDir: CDP_DIR, tabs: [], seed: 7, browser: chrome.id }, { headless: true, url: page });
  check(`worker (${chrome.name}, headless): ready carries cdpPort, kept on the handle`, Number.isInteger(cdpHandle.cdpPort) && cdpHandle.cdpPort > 0, `port ${cdpHandle.cdpPort}, ready in ${Date.now() - t0} ms`);
  orchestrator.live.set(CDP_ID, { id: CDP_ID, handle: cdpHandle, startedAt: new Date().toISOString(), url: page });
  const before = await cdpHandle.rpc("info", {}, 40_000).catch((e) => ({ error: e.message })); // also waits for the start page

  const ok = await cdp(CDP_ID);
  const ws = ok.json?.wsEndpoint || "";
  check("cdp: running Chromium profile → { wsEndpoint } on 127.0.0.1", ok.code === 200 && new RegExp(`^ws://127\\.0\\.0\\.1:${cdpHandle.cdpPort}/devtools/browser/[\\w-]+$`).test(ws), ok.text.slice(0, 160));
  const version = await fetch(`http://127.0.0.1:${cdpHandle.cdpPort}/json/version`).then((r) => r.json()).catch(() => ({}));
  check("the browser's /json/version answers with that endpoint", version.webSocketDebuggerUrl === ws, JSON.stringify(version).slice(0, 160));
  // What connectOverCDP does first: open the websocket, ask for the version and the targets.
  const product = await cdpCall(ws, "Browser.getVersion").then((r) => r.product, (e) => e.message);
  const targets = await cdpCall(ws, "Target.getTargets").then((r) => r.targetInfos, () => []);
  check("a CDP client connects to wsEndpoint and sees the profile's tab", /Chrome\//.test(product) && targets.some((t) => t.type === "page" && t.title === "qa cdp"), `${product} ${JSON.stringify(targets.map((t) => t.title))}`);
  const after = await cdpHandle.rpc("info", {}, 15_000).catch((e) => ({ error: e.message }));
  check("the worker still drives the profile once the client has gone", before.title === "qa cdp" && after.title === "qa cdp", `${JSON.stringify(before)} ${JSON.stringify(after)}`);

  await cdpHandle.close();
  await Promise.race([cdpHandle.exited, sleep(15_000)]);
  orchestrator.live.delete(CDP_ID);
  check("worker closed", cdpHandle.process.exitCode !== null);
  const stopped = await cdp(CDP_ID);
  check("cdp: once it has stopped → 409 not running", stopped.code === 409 && /not running/.test(stopped.json?.error || ""), stopped.text.slice(0, 120));
}

server.listen(PORT, "127.0.0.1", async () => {
  try {
    await main();
  } catch (e) {
    check("UNCAUGHT", false, e.stack);
  } finally {
    orchestrator.live.delete(LIVE_ID);
    orchestrator.live.delete(CDP_ID);
    if (cdpHandle && cdpHandle.process.exitCode === null) {
      await cdpHandle.close().catch(() => {});
      await Promise.race([cdpHandle.exited, sleep(15_000)]);
    }
    manager.getSession = realGetSession;
    fs.rmSync(CDP_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    fs.rmSync(CDP_COOKIES, { force: true });
    fs.rmSync(SHOTS, { recursive: true, force: true });
    if (appBackup) fs.writeFileSync(APP, appBackup); else fs.rmSync(APP, { force: true });
    check("cleanup: app.json restored, screenshots, qa profile folder and cookie dump removed",
      !fs.existsSync(SHOTS) && !fs.existsSync(CDP_DIR) && !fs.existsSync(CDP_COOKIES) && (!appBackup || fs.readFileSync(APP).equals(appBackup)));
    for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${!r.ok && r.detail ? "  — " + r.detail : ""}`);
    console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }
});
