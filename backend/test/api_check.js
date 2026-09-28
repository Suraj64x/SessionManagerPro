// End-to-end API check against the real server module. Creates only `qa-*` profiles
// and removes all of them (including from trash) whatever happens.
process.chdir(require("path").resolve(__dirname, "..", ".."));
process.argv.push("--no-open", "--no-terminal");
const http = require("http");
const assert = require("assert");
const { server } = require("../src/server.js");
const manager = require("../src/manager.js");
const scripts = require("../src/scripts.js");
const WebSocket = require("ws");

const PORT = 3997;
const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond, detail });
};

function req(path, { method = "GET", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = { Host: `127.0.0.1:${PORT}`, ...headers };
    if (body !== undefined) h["Content-Type"] = "application/json";
    if (method !== "GET" && headers["x-smp"] === undefined && !headers.__noSmp) h["X-SMP"] = "1";
    delete h.__noSmp;
    const r = http.request({ host: "127.0.0.1", port: PORT, path, method, headers: h }, (res) => {
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

const wsOpens = (headers) =>
  new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers });
    ws.on("open", () => { ws.close(); resolve(true); });
    ws.on("error", () => resolve(false));
    ws.on("unexpected-response", () => resolve(false));
  });

const created = new Set();

async function main() {
  // ---------------- security ----------------
  check("GET from loopback allowed", (await req("/api/pool")).code === 200);
  check("foreign Origin rejected", (await req("/api/pool", { headers: { Origin: "https://evil.example" } })).code === 403);
  check("DNS-rebinding Host rejected", (await req("/api/pool", { headers: { Host: "evil.example:3997" } })).code === 403);
  check("POST without X-SMP rejected",
    (await req("/api/sessions/auto", { method: "POST", body: { count: 1 }, headers: { __noSmp: true } })).code === 403);
  check("localhost:3000 dev origin allowed", (await req("/api/pool", { headers: { Origin: "http://localhost:3000" } })).code === 200);
  check("WS from loopback opens", await wsOpens({}));
  check("WS from foreign origin refused", !(await wsOpens({ Origin: "https://evil.example" })));
  check("launch rejects file: URL",
    (await req("/api/sessions/launch", { method: "POST", body: { ids: ["x"], url: "file:///C:/Windows/win.ini" } })).code === 400);
  let dots;
  try { manager.safeId(".."); dots = false; } catch { dots = true; }
  check("safeId refuses '..'", dots);

  // ---------------- scripts CRUD ----------------
  const list = await req("/api/scripts");
  check("scripts seeded with examples", list.code === 200 && list.json.length >= 4, `${list.json?.length} scripts`);
  check("no example auto-runs", list.json.every((s) => !s.autoRun));
  const made = await req("/api/scripts", { method: "POST", body: { name: "qa script", mode: "page", code: "return 1+1", autoRun: true, match: "*://*.example.com/*" } });
  check("create script", made.code === 200 && made.json.id, made.text.slice(0, 80));
  const sid = made.json.id;
  const bad = await req("/api/scripts", { method: "POST", body: { name: "", mode: "page" } });
  check("create rejects empty name", bad.code === 400);
  const autoOff = await req(`/api/scripts/${sid}`, { method: "PATCH", body: { mode: "automation" } });
  check("automation mode forces autoRun off", autoOff.json?.autoRun === false);
  const reg = scripts.globToRegex("*://*.example.com/*");
  check("glob matches subdomain", new RegExp(reg).test("https://www.example.com/a"));
  check("glob rejects other host", !new RegExp(reg).test("https://example.org/"));
  const wrapped = scripts.wrapInit({ name: "t", code: "const s = `a${1}b`; return s;", match: "" });
  let parses = true;
  try { new Function(wrapped); } catch { parses = false; }
  check("init wrapper survives backticks and ${}", parses);

  // ---------------- profiles: create, patch whitelist ----------------
  const a = await req("/api/sessions/create", { method: "POST", body: { name: "qa-alpha" } });
  check("create profile", a.code === 200, a.text.slice(0, 120));
  if (a.code === 200) created.add("qa-alpha");
  const p1 = await req("/api/sessions/qa-alpha", { method: "PATCH",
    body: { tags: ["Warm", "warm", " US "], label: "Active", color: "#22c55e", startUrls: ["https://example.com"], userDataDir: "C:/x" } });
  check("PATCH saves tags (deduped, lowercased)", JSON.stringify(p1.json?.tags) === JSON.stringify(["warm", "us"]), JSON.stringify(p1.json?.tags));
  check("PATCH saves label + color + startUrls", p1.json?.label === "Active" && p1.json?.color === "#22c55e" && p1.json?.startUrls?.length === 1);
  check("PATCH still ignores userDataDir", !String(p1.json?.userDataDir).startsWith("C:/x"));
  check("PATCH rejects bad color", (await req("/api/sessions/qa-alpha", { method: "PATCH", body: { color: "red" } })).code === 400);
  check("PATCH rejects file: start page", (await req("/api/sessions/qa-alpha", { method: "PATCH", body: { startUrls: ["file:///etc"] } })).code === 400);

  // ---------------- bulk ----------------
  const b = await req("/api/sessions/create", { method: "POST", body: { name: "qa-beta" } });
  if (b.code === 200) created.add("qa-beta");
  const bulk = await req("/api/sessions/bulk", { method: "POST", body: { ids: ["qa-alpha", "qa-beta"], action: "tag", value: ["batch"] } });
  check("bulk tag", bulk.json?.ok === 2 && manager.getSession("qa-beta").tags.includes("batch"));
  const bl = await req("/api/sessions/bulk", { method: "POST", body: { ids: ["qa-alpha", "qa-beta"], action: "label", value: "Review" } });
  check("bulk label", bl.json?.ok === 2 && manager.getSession("qa-alpha").label === "Review");
  check("bulk rejects unknown action", (await req("/api/sessions/bulk", { method: "POST", body: { ids: ["qa-alpha"], action: "format-disk" } })).code === 400);

  // ---------------- cookies ----------------
  const netscape = "# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tTRUE\t1999999999\tsid\tabc\n#HttpOnly_.example.com\tTRUE\t/\tFALSE\t0\ttok\txyz\n";
  const ns = manager.normalizeCookies(netscape);
  check("Netscape parsed incl. #HttpOnly_, 2033 expiry clamped to 400d", ns.length === 2 && ns[1].httpOnly === true && Math.round((ns[0].expires - Date.now() / 1000) / 86400) === 400);
  const etc = manager.normalizeCookies([{ name: "a", value: "1", domain: ".x.com", expirationDate: 1999999999.5, sameSite: "no_restriction", secure: false }]);
  check("EditThisCookie mapped (expires, SameSite=None forces Secure)", Math.round((etc[0].expires - Date.now() / 1000) / 86400) === 400 && etc[0].sameSite === "None" && etc[0].secure === true);
  const imp = await req("/api/sessions/qa-alpha/cookies", { method: "POST", body: { cookies: netscape } });
  check("import to stopped profile is staged", imp.json?.applied === "next launch" && imp.json?.count === 2);
  const fs = require("fs");
  check("staged file written", fs.existsSync("data/cookies/qa-alpha.import.json"));
  check("import rejects junk", (await req("/api/sessions/qa-alpha/cookies", { method: "POST", body: { cookies: "not cookies" } })).code === 400);
  check("export returns array", Array.isArray((await req("/api/sessions/qa-alpha/cookies")).json));

  // ---------------- clone ----------------
  const cl = await req("/api/sessions/qa-alpha/clone", { method: "POST", body: { name: "qa-alpha-copy", withCookies: false } });
  if (cl.code === 200) created.add("qa-alpha-copy");
  const src = manager.getSession("qa-alpha");
  check("clone copies tags/label/start pages", cl.code === 200 && cl.json.label === "Review" && cl.json.startUrls?.length === 1, cl.text.slice(0, 100));
  check("clone gets its own proxy", cl.json?.proxy && `${cl.json.proxy.host}:${cl.json.proxy.port}` !== `${src.proxy.host}:${src.proxy.port}`);
  check("clone gets its own fingerprint", cl.json?.fingerprintFile && cl.json.fingerprintFile !== src.fingerprintFile);

  // ---------------- trash ----------------
  const proxyKey = `${src.proxy.host}:${src.proxy.port}`;
  const del = await req("/api/sessions/qa-alpha", { method: "DELETE" });
  check("delete moves to trash", del.code === 200 && !manager.getSession("qa-alpha"));
  const trash = await req("/api/trash");
  check("trash lists it with purge time", trash.json?.some((r) => r.id === "qa-alpha" && r.purgeAt));
  const res = await req("/api/resources");
  const px = res.json.proxies.find((p) => p.key === proxyKey);
  check("trashed profile keeps its proxy reserved", px?.isAssigned && /trash/.test(px.assignedTo), px?.assignedTo);
  check("creating a trashed name is refused (400)", (await req("/api/sessions/create", { method: "POST", body: { name: "qa-alpha" } })).code === 400);
  const rs = await req("/api/trash/qa-alpha/restore", { method: "POST" });
  check("restore brings it back", rs.code === 200 && manager.getSession("qa-alpha")?.label === "Review");
  check("restored profile dir is back", fs.existsSync(manager.getSession("qa-alpha").userDataDir));

  // ---------------- script run on a stopped profile ----------------
  const run = await req("/api/scripts/run", { method: "POST", body: { draft: { name: "d", mode: "page", code: "return 1" }, ids: ["qa-beta"] } });
  check("run returns immediately with an id", run.code === 200 && run.json.id);
  await new Promise((r) => setTimeout(r, 150));
  const runs = await req("/api/scripts/runs");
  const mine = runs.json.find((r) => r.id === run.json.id);
  check("run on stopped profile reports 'not running'", mine?.results["qa-beta"]?.state === "error" && /not running/.test(mine.results["qa-beta"].error));
  check("run rejects empty script", (await req("/api/scripts/run", { method: "POST", body: { draft: { name: "d", mode: "page", code: "  " }, ids: ["qa-beta"] } })).code === 400);

  await req(`/api/scripts/${sid}`, { method: "DELETE" });
}

async function cleanup() {
  for (const id of created) {
    try { await manager.trashSession(id); } catch {}
    try { await manager.purgeTrash({ id }); } catch {}
  }
  for (const f of ["qa-alpha", "qa-beta", "qa-alpha-copy"]) {
    require("fs").rmSync(`data/cookies/${f}.import.json`, { force: true });
    require("fs").rmSync(`data/cookies/${f}.json`, { force: true });
  }
}

server.listen(PORT, "127.0.0.1", async () => {
  try {
    await main();
  } catch (e) {
    results.push({ name: "UNCAUGHT", ok: false, detail: e.stack });
  } finally {
    await cleanup();
    const mine = (s) => ["qa-alpha", "qa-beta", "qa-alpha-copy"].includes(s.id);
    const left = manager.listSessions().filter(mine).length + manager.listTrash().filter(mine).length;
    results.push({ name: "cleanup left none of this test's profiles", ok: left === 0, detail: `${left} left` });
    for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : "  — " + r.detail}`);
    console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }
});
