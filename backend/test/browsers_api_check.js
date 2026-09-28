// The browser-choice API against the real server module: GET /api/browsers, custom builds,
// `browser` / `geolocation` on create and PATCH. Creates only qa- profiles and a qa custom
// build, all through the server's own API, and removes them the same way (trash + purge)
// whatever happens; data/browsers.json is restored to what it was.
//
//   node backend/test/browsers_api_check.js
process.chdir(require("path").resolve(__dirname, "..", ".."));
process.argv.push("--no-open", "--no-terminal");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { server } = require("../src/server.js");
const manager = require("../src/manager.js");
const orchestrator = require("../src/orchestrator.js");
const browsers = require("../src/browsers.js");

const PORT = 3995;
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
const PROFILES = ["qa-browser-a", "qa-browser-b"];
const hadCustomFile = fs.existsSync(browsers.CUSTOM_FILE);
const customBefore = hadCustomFile ? fs.readFileSync(browsers.CUSTOM_FILE) : null;

function req(p, { method = "GET", body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: `127.0.0.1:${PORT}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (method !== "GET") headers["X-SMP"] = "1";
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method, headers }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(d); } catch {}
        resolve({ code: res.statusCode, json, text: d });
      });
    });
    r.on("error", reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

async function main() {
  const g = await req("/api/browsers");
  const list = g.json?.browsers || [];
  check("GET /api/browsers { default, browsers[] }", g.code === 200 && g.json.default === "stealth-firefox" && list[0]?.id === "stealth-firefox", g.text.slice(0, 120));
  check("entries carry kind / installed / fingerprintBrowsers", list.every((b) => ["stealth", "chromium", "firefox-manual"].includes(b.kind) && typeof b.installed === "boolean" && Array.isArray(b.fingerprintBrowsers)));
  // What the panel offers: the stealth engine, engines-folder builds, manual Firefox, custom
  // builds. An installed Chrome/Edge/Brave and Playwright's Chromium are detected but not offered.
  check(
    "installed Chromium browsers are not offered",
    !list.some((b) => ["chrome", "chrome-beta", "chrome-dev", "chrome-canary", "chromium", "edge", "brave"].includes(b.id) || /^pw-chromium-/.test(b.id)),
    list.map((b) => b.id).join(",")
  );
  check("every offered entry is the stealth engine, an engines-folder build, manual Firefox or custom",
    list.every((b) => b.builtin || b.custom || b.engineFolder || b.kind === "firefox-manual"), list.map((b) => `${b.id}:${b.kind}`).join(","));
  const everything = await browsers.everyBrowser();
  const chrome = everything.find((b) => b.id === "chrome");
  check("Chrome is still detected, so a profile that names it keeps launching",
    chrome?.installed && chrome.automation && chrome.family === "chromium" && (await browsers.find("chrome"))?.id === "chrome");

  // ---- custom builds
  const post = (body) => req("/api/browsers/custom", { method: "POST", body });
  check("custom: relative path -> 400", (await post({ path: "chrome.exe" })).code === 400);
  check("custom: missing file -> 400", (await post({ path: "C:\\qa-nope\\chrome.exe" })).code === 400);
  const notepad = await post({ path: path.join(process.env.SystemRoot || "C:\\Windows", "System32", "notepad.exe") });
  check("custom: not a browser -> 400 with a reason", notepad.code === 400 && /Chromium or a Firefox/.test(notepad.json?.error), notepad.json?.error);
  // An offered build cannot be added twice. (A browser the panel does NOT offer may be added
  // on purpose: that is how someone puts their own Chrome back.)
  const offered = list.find((b) => b.path);
  const dup = await post({ path: offered.path });
  check("custom: an already-listed build -> 409", dup.code === 409 && new RegExp(`already listed as ${offered.name}`).test(dup.json?.error || ""), dup.json?.error);
  const readd = await post({ path: chrome.path, name: "QA Chrome Again" });
  check("custom: a browser the panel doesn't offer can still be added by hand", readd.code === 200 && readd.json?.custom === true, readd.text.slice(0, 120));
  if (readd.json?.id) await req(`/api/browsers/custom/${readd.json.id}`, { method: "DELETE" });
  const pw = everything.find((b) => /^pw-chromium-/.test(b.id));
  // Any exe inside a Chromium build folder is recognised by its chrome.dll (a stand-in for a real custom build).
  const added = await post({ path: path.join(path.dirname(pw.path), "chrome_proxy.exe"), name: "QA Custom Build" });
  const custom = added.json;
  check("custom: added { id: custom-<slug>, custom: true, family, version }", added.code === 200 && custom.id === "custom-qa-custom-build" && custom.custom === true && custom.family === "chromium" && custom.kind === "chromium" && custom.version, added.text.slice(0, 160));
  check("custom: listed by GET /api/browsers", (await req("/api/browsers")).json.browsers.some((b) => b.id === custom?.id));
  check("custom: data/browsers.json written", JSON.parse(fs.readFileSync(browsers.CUSTOM_FILE, "utf8")).some((c) => c.id === custom?.id));

  // ---- create / PATCH
  const bad = await req("/api/sessions/create", { method: "POST", body: { name: "qa-browser-x", browser: "netscape" } });
  check("create: unknown browser -> 400", bad.code === 400 && /unknown browser/.test(bad.json?.error), bad.json?.error);
  check("create: bad geolocation -> 400", (await req("/api/sessions/create", { method: "POST", body: { name: "qa-browser-x", geolocation: "maybe" } })).code === 400);
  check("create: nothing was created for the refused requests", !manager.getSession("qa-browser-x"));
  const a = await req("/api/sessions/create", { method: "POST", body: { name: "qa-browser-a", browser: custom.id, geolocation: "spoof" } });
  check("create with browser + geolocation", a.code === 200 && a.json.browser === custom.id && a.json.geolocation === "spoof", a.text.slice(0, 120));
  const inUse = await req(`/api/browsers/custom/${custom.id}`, { method: "DELETE" });
  check("custom: DELETE while a profile uses it -> 409 used by 1 profile", inUse.code === 409 && /used by 1 profile/.test(inUse.json?.error), inUse.json?.error);

  const patch = (body) => req("/api/sessions/qa-browser-a", { method: "PATCH", body });
  const p1 = await patch({ browser: "chrome", geolocation: "block" });
  check("PATCH browser + geolocation", p1.code === 200 && p1.json.browser === "chrome" && p1.json.geolocation === "block", p1.text.slice(0, 120));
  check("PATCH unknown browser -> 400", (await patch({ browser: "nope" })).code === 400);
  check("PATCH bad geolocation -> 400", (await patch({ geolocation: "on" })).code === 400);
  check("PATCH bad webrtc -> 400", (await patch({ webrtc: "altered" })).code === 400);
  const pwr = await patch({ webrtc: "off" });
  check("PATCH webrtc off", pwr.code === 200 && pwr.json.webrtc === "off", pwr.text.slice(0, 120));
  orchestrator.live.set("qa-browser-a", { id: "qa-browser-a", handle: {} }); // as if it were running
  const busy = await patch({ browser: "edge" });
  const same = await patch({ browser: "chrome" });
  orchestrator.live.delete("qa-browser-a");
  check("PATCH browser on a running profile -> 409", busy.code === 409 && /stop this profile/.test(busy.json?.error), busy.json?.error);
  check("PATCH the same browser on a running profile is a no-op, not a 409", same.code === 200);

  const b = await req("/api/sessions/create", { method: "POST", body: { name: "qa-browser-b", proxy: "http://qa:qa-secret@203.0.113.9:8080" } });
  const got = await req("/api/sessions/qa-browser-b");
  const all = await req("/api/sessions");
  check(
    "defaults: browser stealth-firefox, geolocation block, webrtc masked",
    b.code === 200 && got.json.browser === "stealth-firefox" && got.json.geolocation === "block" && got.json.webrtc === "masked",
    b.text.slice(0, 120)
  );
  // What the stealth worker is told: proxied profiles only use the proxy for WebRTC unless "altered".
  const { ENGINES } = require("../src/worker_runner.js");
  const noPing = { "invisible_firefox.usage_ping.enabled": false };
  const masked = { ...noPing, "media.peerconnection.use_document_iceservers": false, "media.peerconnection.default_iceservers": '[{"urls":["stun:127.0.0.1:3479"]}]' };
  const off = { ...noPing, "media.peerconnection.ice.proxy_only_if_behind_proxy": true };
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check(
    "stealth prefs: no launch ping; WebRTC masked by default (also for old values), off when asked, untouched without a proxy",
    eq(ENGINES.stealth.prefs({ proxy: { host: "h" } }), masked) &&
      eq(ENGINES.stealth.prefs({ proxy: { host: "h" }, webrtc: "proxy-only" }), masked) &&
      eq(ENGINES.stealth.prefs({ proxy: { host: "h" }, webrtc: "off" }), off) &&
      eq(ENGINES.stealth.prefs({}), noPing)
  );
  check("publicRecord still hides the proxy password", !got.text.includes("qa-secret") && !all.text.includes("qa-secret") && got.json.proxy?.hasPassword === true);

  // Old records (no field) read as Stealth Firefox and blocked geolocation.
  const old = manager.publicRecord({ id: "qa-old", proxy: { host: "h", port: 1, password: "pw" } });
  check("a record without `browser` reads as stealth-firefox / block / masked", old.browser === "stealth-firefox" && old.geolocation === "block" && old.webrtc === "masked" && !("password" in old.proxy));
}

async function cleanup() {
  for (const id of [...PROFILES, "qa-browser-x"]) {
    await req(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
    await req(`/api/trash/${id}`, { method: "DELETE" }).catch(() => {});
  }
  const custom = (await browsers.list()).find((x) => x.id === "custom-qa-custom-build");
  if (custom) {
    const del = await req(`/api/browsers/custom/${custom.id}`, { method: "DELETE" });
    check("custom: DELETE once unused -> 200", del.code === 200, del.text);
  }
  if (hadCustomFile) require("../src/fsutil").writeFileAtomic(browsers.CUSTOM_FILE, customBefore);
  else fs.rmSync(browsers.CUSTOM_FILE, { force: true });
}

server.listen(PORT, "127.0.0.1", async () => {
  try {
    await main();
  } catch (e) {
    check("UNCAUGHT", false, e.stack);
  } finally {
    await cleanup();
    const left = [...manager.listSessions(), ...manager.listTrash()].filter((s) => s.id.startsWith("qa-browser-")).length;
    check("cleanup left no qa-browser profiles", left === 0, `${left} left`);
    for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : "  — " + r.detail}`);
    console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }
});
