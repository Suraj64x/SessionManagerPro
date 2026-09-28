// The Chromium engine end to end, headless only: browser detection; a qa- Chrome profile driven
// through the same RPC checks rpc_check.js runs on Firefox (plus close_tab); a Chrome
// fingerprint applied coherently; a proxied launch through local fake HTTP (with auth) and
// SOCKS5 proxies whose "internet" is served in-process (geo, language, DNS, auth, geolocation);
// an automation script and the orchestrator path; the manual Firefox wrapper on Playwright's
// Firefox build. Profiles live under os.tmpdir(); nothing under data/ is touched except the
// workers' cookie dumps, removed at the end.
//
//   node backend/test/chromium_check.js
const fs = require("fs");
const os = require("os");
const net = require("net");
const http = require("http");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
process.chdir(ROOT);
const { launchWorker } = require(path.join(ROOT, "backend/src/worker_runner.js"));
const browsers = require(path.join(ROOT, "backend/src/browsers.js"));
const scripts = require(path.join(ROOT, "backend/src/scripts.js"));

// In-memory session store for the orchestrator (swapped in before it is required).
const manager = require(path.join(ROOT, "backend/src/manager.js"));
const records = {};
Object.assign(manager, {
  getSession: (id) => records[id] || null,
  ensureSessions: async () => ({ created: [], existing: [], skipped: [] }),
  saveSessionPatch: async (id, patch) => Object.assign(records[id] || {}, patch),
  openSession: async (id, opts) => {
    if (!records[id]) throw new Error("unknown session");
    return launchWorker(records[id], opts);
  },
});
const orchestrator = require(path.join(ROOT, "backend/src/orchestrator.js"));

const SCRATCH = path.join(os.tmpdir(), "qa-chromium-check");
const IDS = ["qa-chromium-ops", "qa-chromium-fp", "qa-chromium-http", "qa-chromium-socks", "qa-chromium-orch", "qa-firefox-manual", "qa-chromium-gone", "qa-chromium-grizz"];
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rec = (id, extra = {}) => (records[id] = { id, userDataDir: path.join(SCRATCH, id), tabs: [], seed: 11, browser: "chrome", ...extra });

const PAGE = "data:text/html," + encodeURIComponent(
  "<title>RPC test</title><input id=q><button id=b onclick=\"document.title='clicked'\">go</button><div style='height:3000px'></div>"
);

// ---- a fake internet: ip-api.com answers Berlin; any other host gets a page echoing what it saw
const seen = { auth: [], lang: [], socksHosts: [], socksLogins: [] };
const GEO = { status: "success", query: "203.0.113.7", countryCode: "DE", timezone: "Europe/Berlin", lat: 52.52, lon: 13.4 };
function answer(req, res) {
  const host = String(req.headers.host || "").split(":")[0];
  seen.lang.push(req.headers["accept-language"] || "");
  if (host === "ip-api.com") return res.end(JSON.stringify(GEO));
  if (req.url.includes("/frame")) {
    // A cross-site iframe (its own process): it reports what it sees to the parent.
    return res.end("<script>const c = document.createElement('canvas').getContext('webgl'); parent.postMessage({ hc: navigator.hardwareConcurrency, r: c && c.getParameter(0x9246) }, '*');</script>");
  }
  res.setHeader("content-type", "text/html");
  res.end(`<title>via ${host}</title><p>${req.headers["accept-language"] || ""}</p>` +
    (req.url.includes("/parent") ? `<script>addEventListener('message', (e) => (window.__frame = e.data));</script><iframe src="http://localhost:${internet.address().port}/frame"></iframe>` : ""));
}
const internet = http.createServer(answer);
// HTTP proxy with Basic auth: plain http only (absolute-URI requests), which is all the test needs.
const httpProxy = http.createServer((req, res) => {
  const auth = req.headers["proxy-authorization"];
  seen.auth.push(auth || null);
  if (auth !== "Basic " + Buffer.from("qa-user:qa-secret").toString("base64")) {
    res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="qa"' });
    return res.end();
  }
  answer(req, res);
});
httpProxy.on("connect", (req, sock) => sock.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
// SOCKS5, no auth: records the requested host (remote DNS sends the name) and tunnels to `internet`.
const socks = net.createServer((c) => {
  c.once("data", () => {
    c.write(Buffer.from([5, 0]));
    c.once("data", (d) => {
      const atyp = d[3];
      seen.socksHosts.push(atyp === 3 ? d.slice(5, 5 + d[4]).toString() : `atyp${atyp}`);
      const up = net.connect(internet.address().port, "127.0.0.1", () => {
        c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        c.pipe(up).pipe(c);
      });
      up.on("error", () => c.destroy());
    });
  });
  c.on("error", () => {});
});
// SOCKS5 that requires a username/password (RFC 1929): what Chrome alone cannot log in to.
const socksAuth = net.createServer((c) => {
  c.once("data", () => {
    c.write(Buffer.from([5, 2]));
    c.once("data", (a) => {
      const user = a.slice(2, 2 + a[1]).toString();
      const pass = a.slice(3 + a[1], 3 + a[1] + a[2 + a[1]]).toString();
      seen.socksLogins.push(`${user}:${pass}`);
      if (user !== "qa-user" || pass !== "qa-secret") return c.end(Buffer.from([1, 1]));
      c.write(Buffer.from([1, 0]));
      c.once("data", (d) => {
        seen.socksHosts.push(d[3] === 3 ? d.slice(5, 5 + d[4]).toString() : `atyp${d[3]}`);
        const up = net.connect(internet.address().port, "127.0.0.1", () => {
          c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          c.pipe(up).pipe(c);
        });
        up.on("error", () => c.destroy());
      });
    });
  });
  c.on("error", () => {});
});
const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", r));

async function opsChecks() {
  const initFile = path.join(SCRATCH, "init.json");
  fs.writeFileSync(initFile, JSON.stringify([scripts.wrapInit({ name: "t", match: "data:*", code: "window.__smpAutoRan = (window.__smpAutoRan || 0) + 1;" })]));
  const t0 = Date.now();
  const handle = await launchWorker(rec("qa-chromium-ops"), { headless: true, url: PAGE, initScriptsFile: initFile });
  check("chrome worker ready (headless)", true, `${Date.now() - t0} ms`);
  check("spawned chromium_worker.py -E -s with --browser-path", handle.process.spawnargs[1] === "-E" && /chromium_worker\.py$/.test(handle.process.spawnargs[3]) && handle.process.spawnargs.some((a) => /^--browser-path=.*chrome\.exe$/i.test(a)));
  check("init_scripts note buffered", handle.launchNotes?.some((n) => n.event === "init_scripts" && n.count === 1), JSON.stringify(handle.launchNotes));
  const info = await handle.rpc("info");
  check("info {url, title, pageId, headless}", info.title === "RPC test" && info.url === PAGE && info.pageId && info.headless === true && !("exitIp" in info), JSON.stringify(info).slice(0, 120));
  check("auto-run script ran exactly once", (await handle.rpc("eval", { code: "window.__smpAutoRan" })) === 1);
  const v = await handle.rpc("eval", { code: "async () => {\nawait new Promise(r => setTimeout(r, 50));\nreturn { t: document.title, n: 6 * 7 };\n}" });
  check("eval: function body with await/return", v?.n === 42 && v?.t === "RPC test", JSON.stringify(v));
  check("eval: expression with arg-less function source", (await handle.rpc("eval", { code: "(x) => x * 2", arg: 21 })) === 42);
  await handle.rpc("fill", { selector: "#q", value: "hello" });
  check("fill", (await handle.rpc("eval", { code: "document.querySelector('#q').value" })) === "hello");
  await handle.rpc("type", { selector: "#q", text: " World", delay: 5 });
  check("type (real key events, Shift for capitals)", (await handle.rpc("eval", { code: "document.querySelector('#q').value" })) === "hello World");
  await handle.rpc("press", { selector: "#q", key: "Control+a" });
  await handle.rpc("press", { key: "Backspace" });
  check("press Control+a then Backspace clears the field", (await handle.rpc("eval", { code: "document.querySelector('#q').value" })) === "");
  await handle.rpc("click", { selector: "#b" });
  check("click (trusted mouse events)", (await handle.rpc("info")).title === "clicked");
  await handle.rpc("scroll", { dy: 800 });
  await sleep(400);
  check("scroll", (await handle.rpc("eval", { code: "window.scrollY" })) > 0);
  const shot = path.join(SCRATCH, "shot.png");
  await handle.rpc("screenshot", { path: shot, fullPage: true });
  check("screenshot (fullPage) written", fs.existsSync(shot) && fs.statSync(shot).size > 1000);

  let err = null;
  try { await handle.rpc("wait_for", { selector: "#nope", timeout: 800 }); } catch (e) { err = e.message; }
  check("failing op rejects readably", /#nope/.test(err || "") && /timeout/i.test(err), err);
  err = null;
  try { await handle.rpc("eval", { code: "async () => { throw new Error('boom from page'); }" }); } catch (e) { err = e.message; }
  check("page exceptions come back as errors", /boom from page/.test(err || ""), err);
  err = null;
  try { await handle.rpc("eval", { code: "NaN" }); } catch (e) { err = e.message; }
  check("NaN result rejects at once", /not JSON-serialisable/.test(err || ""), err);
  const slow = handle.rpc("eval", { code: "new Promise(r => setTimeout(() => r('slow'), 1500))" });
  const t1 = Date.now();
  await handle.rpc("info");
  check("RPCs run concurrently", Date.now() - t1 < 1000, `${Date.now() - t1} ms`);
  check("slow op still resolves", (await slow) === "slow");

  const count = await handle.rpc("add_cookies", { cookies: [{ name: "smp", value: "1", domain: ".example.com", path: "/", sameSite: "Lax", expires: Math.floor(Date.now() / 1000) + 3600 }] });
  const jar = await handle.rpc("cookies");
  const c = jar.find((x) => x.name === "smp");
  check("add_cookies / cookies (Playwright shape)", c && c.domain === ".example.com" && c.sameSite === "Lax" && c.expires > 0 && typeof count === "number" && count >= 1, JSON.stringify(c));

  await handle.rpc("eval", { code: "(() => { const q = document.querySelector('#q'); q.focus(); q.select(); })()" });
  check("keyboard_type into the focused element", (await handle.rpc("keyboard_type", { text: "xyz", delay: 5 })) === true && (await handle.rpc("eval", { code: "document.querySelector('#q').value" })) === "xyz");
  await handle.rpc("eval", { code: "window.__gone = 1, 1" });
  const reloaded = await handle.rpc("reload");
  check("reload returns the url and a fresh document", reloaded === PAGE && (await handle.rpc("eval", { code: "window.__gone === undefined" })) === true);

  const first = (await handle.rpc("info")).pageId;
  const tabA = await handle.rpc("new_tab", { url: PAGE });
  const tabB = await handle.rpc("new_tab", { url: PAGE });
  const tabs = await handle.rpc("tabs");
  check("tabs lists every page, one active", tabs.length === 3 && tabs.every((t) => t.pageId && t.url === PAGE && t.title === "RPC test") && tabs.find((t) => t.active)?.pageId === tabB.pageId, JSON.stringify(tabs).slice(0, 160));
  await handle.rpc("eval", { code: "window.__mark = 'A', 1", pageId: tabA.pageId });
  check("pageId pins an op to its tab", (await handle.rpc("eval", { code: "window.__mark || null", pageId: tabA.pageId })) === "A" && (await handle.rpc("eval", { code: "window.__mark || null" })) === null);
  check("auto-run script also ran in a new tab", (await handle.rpc("eval", { code: "window.__smpAutoRan", pageId: tabB.pageId })) === 1);
  check("close_tab closes the pinned tab", (await handle.rpc("close_tab", { pageId: tabB.pageId })) === true && (await handle.rpc("tabs")).length === 2);
  err = null;
  try { await handle.rpc("eval", { code: "1", pageId: tabB.pageId }); } catch (e) { err = e.message; }
  check("a closed pinned tab rejects", /has been closed/.test(err || ""), err);
  err = null;
  try { await handle.rpc("close_tab", {}); } catch (e) { err = e.message; }
  check("close_tab without pageId refuses", /needs the pageId/.test(err || ""), err);
  const closedN = await handle.rpc("close_other_tabs", { pageId: first });
  const after = await handle.rpc("tabs");
  check("close_other_tabs keeps only the pinned page", closedN === 1 && after.length === 1 && after[0].pageId === first && after[0].active, JSON.stringify(after));
  err = null;
  try { await handle.rpc("close_tab", { pageId: first }); } catch (e) { err = e.message; }
  check("close_tab refuses the last open tab", /last open tab/.test(err || ""), err);
  err = null;
  try { await handle.rpc("window", { action: "bounds" }); } catch (e) { err = e.message; }
  check("window op refuses headless", /no browser window found/.test(err || ""), err);

  const ua = await handle.rpc("eval", { code: "navigator.userAgent" });
  check("headless UA does not say HeadlessChrome", /Chrome\/153\./.test(ua) && !/Headless/.test(ua), ua);
  check("headless screen is not 800x600", (await handle.rpc("eval", { code: "screen.width + 'x' + screen.height" })) === "1920x1080");
  check("no navigator.webdriver", (await handle.rpc("eval", { code: "navigator.webdriver" })) === false);

  // Automation mode through the real Node wrapper (page proxy -> rpc with pageId pinning).
  const deps = { orchestrator: { live: new Map([["qa-chromium-ops", { handle }]]), log: () => {} }, getSession: () => ({ id: "qa-chromium-ops", email: "x", tags: [] }) };
  const snap = scripts.startRun({ name: "auto", mode: "automation", code: "await page.fill('#q', profile.id); log('filled'); return (await page.evaluate(() => document.querySelector('#q').value)) + ':' + (await page.title());" }, ["qa-chromium-ops"], deps);
  let done;
  for (let i = 0; i < 60 && !["ok", "error"].includes(done?.state); i++) {
    await sleep(100);
    done = scripts.recentRuns().find((r) => r.id === snap.id).results["qa-chromium-ops"];
  }
  check("automation script runs via scripts.startRun", done.state === "ok" && done.value === "qa-chromium-ops:RPC test" && done.logs?.includes("filled"), JSON.stringify(done).slice(0, 160));

  const cookieFile = path.join(ROOT, "data", "cookies", "qa-chromium-ops.json");
  fs.rmSync(cookieFile, { force: true });
  await handle.close();
  const dumped = fs.existsSync(cookieFile) && JSON.parse(fs.readFileSync(cookieFile, "utf8"));
  check("cookie jar dumped on close", Array.isArray(dumped) && dumped.some((x) => x.name === "smp"));
  err = null;
  try { await handle.rpc("info", {}, 2000); } catch (e) { err = e.message; }
  check("RPC after close fails fast", /not running|closed/.test(err || ""), err);
  check("persistent profile: Chrome's own Cookies db exists", fs.existsSync(path.join(SCRATCH, "qa-chromium-ops", "Default", "Network", "Cookies")));
}

async function fingerprintChecks() {
  const port = internet.address().port;
  const fingerprint = {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    platform: "Win32", hardwareConcurrency: 6, deviceMemory: 4, languages: ["en-GB", "en"],
    screen: { width: 1600, height: 900, availWidth: 1600, availHeight: 860, colorDepth: 24, pixelDepth: 24 },
    viewport: { width: 1600, height: 900, deviceScaleFactor: 1.25 },
    webgl: { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)" },
    userAgentData: { platform: "Windows", platformVersion: "10.0.0", architecture: "x86", bitness: "64", model: "", mobile: false, wow64: false,
      brands: [{ brand: "Brave", version: "141" }] },
  };
  const h = await launchWorker(rec("qa-chromium-fp", { fingerprint }), { headless: true, url: `http://127.0.0.1:${port}/parent` });
  await sleep(800);
  const s = await h.rpc("eval", { code: `async () => {
    const hi = await navigator.userAgentData.getHighEntropyValues(['platformVersion', 'fullVersionList']);
    const gl = document.createElement('canvas').getContext('webgl');
    return { ua: navigator.userAgent, brands: navigator.userAgentData.brands, pv: hi.platformVersion, hc: navigator.hardwareConcurrency,
      dm: navigator.deviceMemory, sw: screen.width, sh: screen.height, ah: screen.availHeight, dpr: devicePixelRatio,
      langs: navigator.languages, platform: navigator.platform, gl: gl && gl.getParameter(0x9246),
      glStr: gl && gl.getParameter.toString(), tsStr: Function.prototype.toString.toString(),
      dmGetter: Object.getOwnPropertyDescriptor(Navigator.prototype, 'deviceMemory').get.toString(),
      illegal: (() => { try { Navigator.prototype.deviceMemory; return 'no throw'; } catch (e) { return e.constructor.name; } })(),
      frame: window.__frame };
  }` });
  check("fp: real major version kept (153), never the dump's 141", /Chrome\/153\./.test(s.ua) && s.brands.some((b) => b.brand === "Google Chrome" && b.version === "153") && !s.brands.some((b) => b.brand === "Brave"), JSON.stringify(s.brands));
  check("fp: OS client hints from the dump (platformVersion 10.0.0)", s.pv === "10.0.0" && s.platform === "Win32", s.pv);
  check("fp: hardwareConcurrency / deviceMemory", s.hc === 6 && s.dm === 4, `${s.hc}/${s.dm}`);
  check("fp: screen, availHeight, devicePixelRatio (headless)", s.sw === 1600 && s.sh === 900 && s.ah === 860 && s.dpr === 1.25, `${s.sw}x${s.sh} avail ${s.ah} dpr ${s.dpr}`);
  check("fp: languages", JSON.stringify(s.langs) === '["en-GB","en"]', JSON.stringify(s.langs));
  check("fp: WebGL renderer (when WebGL exists headless)", s.gl === null || s.gl === fingerprint.webgl.renderer, String(s.gl));
  check("fp: patched functions still look native", s.glStr === null || (s.glStr === "function getParameter() { [native code] }" && s.tsStr === "function toString() { [native code] }" && s.dmGetter === "function get deviceMemory() { [native code] }"), `${s.glStr} | ${s.dmGetter}`);
  check("fp: wrong receiver still throws Illegal invocation", s.illegal === "TypeError", s.illegal);
  check("fp: a cross-site iframe (own process) gets the same patches", s.frame && s.frame.hc === 6 && (s.frame.r === null || s.frame.r === fingerprint.webgl.renderer), JSON.stringify(s.frame));
  await h.close();
}

async function proxyChecks() {
  // HTTP proxy with a password: the local tunnel logs in, geo from the exit IP, no local DNS.
  seen.auth.length = 0;
  process.env.SMP_TEST_UNUSED = "";
  const r = rec("qa-chromium-http", { proxy: { scheme: "http", host: "127.0.0.1", port: httpProxy.address().port, username: "qa-user", password: "qa-secret" } });
  const t0 = Date.now();
  const h = await launchWorker(r, { headless: true });
  check("proxied chrome ready, exitIp/country from the proxy's exit", h.exitIp === GEO.query && h.country === "DE", `${h.exitIp} ${h.country} in ${Date.now() - t0} ms`);
  const args = h.process.spawnargs.join(" ");
  check("the proxy password is not on the worker command line", !args.includes("qa-secret"));
  await h.rpc("goto", { url: "http://qa.test/" });
  const s = await h.rpc("eval", { code: "({ t: document.title, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, lang: navigator.language, langs: navigator.languages, loc: Intl.DateTimeFormat().resolvedOptions().locale })" });
  const login = "Basic " + Buffer.from("qa-user:qa-secret").toString("base64");
  check("page loads through the authenticated HTTP proxy (the tunnel logs in; Chrome never gets a 407)", s.t === "via qa.test" && seen.auth.length > 0 && seen.auth.every((a) => a === login), JSON.stringify(seen.auth.slice(0, 3)));
  check("timezone follows the exit IP", s.tz === "Europe/Berlin", s.tz);
  check("language follows the exit IP (navigator + Intl + Accept-Language)", s.lang === "de-DE" && s.langs[0] === "de-DE" && /^de/.test(s.loc) && seen.lang.some((l) => /^de-DE/.test(l)), `${JSON.stringify(s.langs)} ${s.loc} ${seen.lang.slice(-1)}`);
  const port = internet.address().port;
  await h.rpc("goto", { url: `http://127.0.0.1:${port}/` });
  const geo = await h.rpc("eval", { code: "navigator.permissions.query({ name: 'geolocation' }).then((p) => p.state)" });
  check("geolocation blocked by default", geo === "denied", geo);
  const prefs = JSON.parse(fs.readFileSync(path.join(SCRATCH, "qa-chromium-http", "Default", "Preferences"), "utf8"));
  check("prefs: WebRTC ip_handling_policy + accept_languages written", prefs.webrtc?.ip_handling_policy === "disable_non_proxied_udp" && /^de-DE/.test(prefs.intl?.accept_languages), JSON.stringify(prefs.webrtc));
  const chrome = await chromeCommandLine(h);
  check("chrome flags: proxy, no local DNS, no QUIC, WebRTC policy, no automation flags",
    h.tunnel && chrome.includes(`--proxy-server=http://127.0.0.1:${h.tunnel.port}`) && chrome.includes("--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1") &&
    chrome.includes("--disable-quic") && chrome.includes("--force-webrtc-ip-handling-policy=disable_non_proxied_udp") &&
    !/--enable-automation|--remote-allow-origins|IsolateOrigins|qa-secret|--disable-web-security/.test(chrome), chrome.slice(0, 200));
  await h.close();

  // SOCKS5 (no password): remote DNS, and a spoofed position when the profile asks for one.
  seen.socksHosts.length = 0;
  const h2 = await launchWorker(rec("qa-chromium-socks", { geolocation: "spoof", proxy: { scheme: "socks5", host: "127.0.0.1", port: socks.address().port } }), { headless: true });
  await h2.rpc("goto", { url: "http://qa-socks.test/" });
  check("page loads through SOCKS5 with the NAME sent to the proxy (remote DNS)", (await h2.rpc("info")).title === "via qa-socks.test" && seen.socksHosts.includes("qa-socks.test") && seen.socksHosts.includes("ip-api.com"), JSON.stringify(seen.socksHosts));
  await h2.rpc("goto", { url: `http://127.0.0.1:${port}/` });
  const pos = await h2.rpc("eval", { code: "new Promise((ok) => navigator.geolocation.getCurrentPosition((p) => ok([p.coords.latitude, p.coords.longitude]), (e) => ok(e.message), { timeout: 5000 }))" });
  check("geolocation 'spoof': granted at the exit IP's coordinates", Array.isArray(pos) && pos[0] === GEO.lat && pos[1] === GEO.lon, JSON.stringify(pos));
  await h2.close();

  // SOCKS5 with a password: Chrome can't log in to one, the tunnel does.
  seen.socksHosts.length = 0;
  const h3 = await launchWorker(rec("qa-chromium-socks", { proxy: { scheme: "socks5", host: "127.0.0.1", port: socksAuth.address().port, username: "qa-user", password: "qa-secret" } }), { headless: true });
  await h3.rpc("goto", { url: "http://qa-socks-auth.test/" });
  check(
    "SOCKS5 with a password works through the tunnel (names resolved by the proxy)",
    h3.exitIp === GEO.query && (await h3.rpc("info")).title === "via qa-socks-auth.test" && seen.socksLogins.length > 0 && seen.socksLogins.every((l) => l === "qa-user:qa-secret") && seen.socksHosts.includes("qa-socks-auth.test"),
    JSON.stringify({ exitIp: h3.exitIp, logins: seen.socksLogins.length, hosts: seen.socksHosts })
  );
  await h3.close();

  // A proxy that refuses the login: the launch fails readably, nothing goes out directly.
  let err = null;
  try { await launchWorker(rec("qa-chromium-socks", { proxy: { scheme: "socks5", host: "127.0.0.1", port: socksAuth.address().port, username: "qa-user", password: "wrong" } }), { headless: true }); } catch (e) { err = e.message; }
  check("a SOCKS5 login the proxy refuses stops the launch", Boolean(err) && !/qa-secret|wrong/.test(err), err);
}

/** The Chrome browser process's command line, via its parent (the worker). */
function chromeCommandLine(h) {
  const { execFileSync } = require("child_process");
  // The venv's python.exe is a redirector: the browser is a grandchild of the worker process.
  const ps = `$w = Get-CimInstance Win32_Process -Filter "ParentProcessId=${h.process.pid}"; if ($w) { $w = @($w.ProcessId) } else { $w = @() }; $w += ${h.process.pid}; ` +
    `Get-CimInstance Win32_Process | Where-Object { $w -contains $_.ParentProcessId -and $_.Name -eq 'chrome.exe' } | Select-Object -ExpandProperty CommandLine`;
  return Promise.resolve(execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" }));
}

async function orchestratorChecks() {
  rec("qa-chromium-orch");
  const launched = [];
  orchestrator.on("session:launched", (e) => launched.push(e));
  const res = await orchestrator.launchAndWait(["qa-chromium-orch"], { headless: true, url: PAGE }, { timeoutMs: 60000 });
  check("orchestrator.launchAndWait launches a Chromium profile", res["qa-chromium-orch"]?.ok === true, JSON.stringify(res));
  check("session:launched fired", launched.some((e) => e.id === "qa-chromium-orch" && e.headless === true));
  const live = orchestrator.getStatus().live.find((s) => s.id === "qa-chromium-orch");
  check("getStatus().live[] carries browser", live?.browser === "chrome", JSON.stringify(live));
  const closed = new Promise((r) => orchestrator.once("session:closed", r));
  await orchestrator.stop("qa-chromium-orch");
  const ce = await Promise.race([closed, sleep(10000).then(() => null)]);
  check("stop -> session:closed closedByUser", ce?.closedByUser === true && ce.status === "success", JSON.stringify(ce));
}

async function engineFolderChecks(list) {
  const g = list.find((b) => b.id === "grizz");
  if (!g) return check("engines folder: GrizzEngine (skipped: not installed)", true);
  check("engines folder: GrizzEngine listed as a chromium engine", g.name === "GrizzEngine" && g.kind === "chromium" && /worker\.exe$/i.test(g.path) && g.version, `${g.version}`);
  const h = await launchWorker(rec("qa-chromium-grizz", { browser: "grizz" }), { headless: true, url: PAGE });
  const info = await h.rpc("info");
  const ua = await h.rpc("eval", { code: "navigator.userAgent" });
  await h.rpc("add_cookies", { cookies: [{ name: "g", value: "1", domain: ".example.com", path: "/" }] });
  check("GrizzEngine: info / eval / cookies through the Chromium worker", info.title === "RPC test" && /Chrome\/149\./.test(ua) && !/Headless/.test(ua) && (await h.rpc("cookies")).some((c) => c.name === "g"), ua);
  await h.close();
  // close() resolves once the worker reports closed; the process exit is `exited`.
  await Promise.race([h.exited, sleep(15000)]);
  check("GrizzEngine: closed", h.process.exitCode !== null);
}

async function manualFirefoxChecks(list) {
  const pw = list.find((b) => /^pw-firefox-/.test(b.id));
  if (!pw) return check("manual Firefox wrapper (Playwright Firefox build)", false, "no Playwright Firefox build found");
  const r = rec("qa-firefox-manual", { browser: pw.id, proxy: { scheme: "http", host: "127.0.0.1", port: 9, username: "u", password: "p" } });
  const t0 = Date.now();
  const h = await launchWorker(r, { headless: true });
  check("manual Firefox wrapper ready (headless Playwright Firefox)", /firefox_manual\.py$/.test(h.process.spawnargs[3]), `${Date.now() - t0} ms`);
  let err = null;
  try { await h.rpc("eval", { code: "1" }); } catch (e) { err = e.message; }
  check("manual wrapper refuses every op", /manual-only: scripts, warm-up and broadcast need Stealth Firefox or a Chromium browser/.test(err || ""), err);
  err = null;
  try { await h.rpc("close_tab", { pageId: 1 }); } catch (e) { err = e.message; }
  check("manual wrapper refuses close_tab too", /manual-only/.test(err || ""), err);
  const userJs = fs.readFileSync(path.join(SCRATCH, "qa-firefox-manual", "user.js"), "utf8");
  check("user.js: proxy, remote DNS, no IPv6, TRR off, WebRTC proxy-only, geo off, no telemetry, no password",
    /"network.proxy.http", "127.0.0.1"/.test(userJs) && /"network.proxy.socks_remote_dns", true/.test(userJs) && /"network.dns.disableIPv6", true/.test(userJs) &&
    /"network.trr.mode", 5/.test(userJs) && /"media.peerconnection.ice.proxy_only", true/.test(userJs) && /"geo.enabled", false/.test(userJs) &&
    /"toolkit.telemetry.enabled", false/.test(userJs) && !/"p"\)|password/.test(userJs));
  const gone = new Promise((res) => h.once("disconnected", res));
  await h.close();
  const reported = await Promise.race([gone, sleep(6000).then(() => "timeout")]);
  await Promise.race([h.exited, sleep(15000)]);
  check("manual wrapper closes and reports it", reported !== "timeout" && h.process.exitCode !== null);
}

(async () => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  orchestrator.updatesDir = SCRATCH;
  orchestrator.logFilePath = path.join(SCRATCH, "status.log");
  await Promise.all([listen(internet), listen(httpProxy), listen(socks), listen(socksAuth)]);
  try {
    const list = await browsers.list();
    const ids = list.map((b) => b.id);
    check("detection: Stealth Firefox first, builtin", list[0].id === "stealth-firefox" && list[0].builtin && list[0].kind === "stealth");
    // Detection still finds every browser; the panel only OFFERS the engines it drives well.
    const every = await browsers.everyBrowser();
    check("detection: Chrome, Edge, Brave found with versions", ["chrome", "edge", "brave"].every((id) => every.find((b) => b.id === id)?.version && every.find((b) => b.id === id).installed), every.map((b) => b.id).join(","));
    check("detection: Playwright builds found (chromium driven, firefox manual)", every.some((b) => /^pw-chromium-\d+$/.test(b.id) && b.kind === "chromium") && every.some((b) => /^pw-firefox-\d+$/.test(b.id) && b.kind === "firefox-manual" && !b.automation), every.map((b) => b.id).join(","));
    check("offered: no installed Chromium browser and no Playwright Chromium", !ids.some((id) => ["chrome", "edge", "brave"].includes(id) || /^pw-chromium-/.test(id)), ids.join(","));
    check("detection: every entry has the documented shape", list.every((b) => ["id", "name", "family", "kind", "path", "version", "automation", "installed", "fingerprintBrowsers"].every((k) => k in b)));
    const t = Date.now();
    await browsers.list();
    check("detection is cached", Date.now() - t < 50, `${Date.now() - t} ms`);

    let err = null;
    try { await launchWorker(rec("qa-chromium-gone", { browser: "chrome-canary" }), { headless: true }); } catch (e) { err = e.message; }
    check("a browser that is not installed rejects readably", err === "Chrome Canary is not installed any more — pick another browser for this profile", err);

    await opsChecks();
    await fingerprintChecks();
    await proxyChecks();
    await orchestratorChecks();
    await engineFolderChecks(list);
    await manualFirefoxChecks(list);
  } catch (e) {
    check("UNCAUGHT", false, e.stack);
  } finally {
    try { await orchestrator.stopAll(); } catch {}
    for (const s of [internet, httpProxy, socks, socksAuth]) s.close();
    await sleep(500);
    fs.rmSync(SCRATCH, { recursive: true, force: true });
    for (const id of IDS) fs.rmSync(path.join(ROOT, "data", "cookies", `${id}.json`), { force: true });
    for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail && (!r.ok || / ms$/.test(r.detail)) ? "  — " + r.detail : ""}`);
    console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }
})();
