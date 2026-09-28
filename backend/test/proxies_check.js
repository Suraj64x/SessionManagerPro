// Checks features/proxies.js and manager.parseProxy against the real server in-process on
// port 3015. Adds only proxies named qa-proxies-* on 127.0.0.1 ports 1–6 (refused at once, so
// no network is needed), two qa-proxies-* profiles, and resources/proxies/qa-proxies-merge.txt;
// deletes all of them and drops their keys from data/proxies-removed.json.
//
//   node backend/test/proxies_check.js
const fs = require("fs");
const http = require("http");
const path = require("path");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "..", "..");
process.chdir(ROOT);
process.argv.push("--no-open", "--no-terminal");
const PORT = 3015;
let ROTATE_PORT = 0; // any free port: fixed ones collide with the other checks
process.env.PORT = String(PORT);

const { server } = require(path.join(ROOT, "backend/src/server.js"));
const manager = require(path.join(ROOT, "backend/src/manager.js"));
const WebSocket = require(path.join(ROOT, "backend/node_modules/ws"));

const TXT = path.join(ROOT, "resources", "proxies", "qa-proxies-merge.txt");
const REMOVED = path.join(ROOT, "data", "proxies-removed.json");
const KEYS = [1, 2, 3, 4, 6].map((p) => `127.0.0.1:${p}`);
const PROFILES = ["qa-proxies-p1", "qa-proxies-p2"];

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });

async function req(method, p, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method,
    headers: { Host: `127.0.0.1:${PORT}`, "X-SMP": "1", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { code: res.status, json, text };
}
const get = (p) => req("GET", p);
const post = (p, b = {}) => req("POST", p, b);
const patch = (p, b) => req("PATCH", p, b);
const del = (p) => req("DELETE", p);

// The change-IP endpoint: /ok answers 204, /bad 500.
let rotations = 0;
let owned = false; // cleanup touches 127.0.0.1:1–6 only once we know they are ours
const rotateServer = http.createServer((q, r) => {
  rotations += 1;
  r.writeHead(q.url === "/ok" ? 204 : 500).end();
});

async function main() {
  const before = (await get("/api/proxies")).json;
  check("GET /api/proxies lists the library", Array.isArray(before), String(before).slice(0, 120));
  if (before.some((p) => KEYS.includes(`${p.host}:${p.port}`))) throw new Error("127.0.0.1:1–6 are already in the library; not touching them");
  if (fs.existsSync(TXT)) throw new Error(`${TXT} already exists; not touching it`);
  owned = true;
  await new Promise((r, j) => rotateServer.once("error", j).listen(0, "127.0.0.1", r));
  ROTATE_PORT = rotateServer.address().port;

  // --- parse (no write)
  const text = [
    "http://qa:secret1@127.0.0.1:1 {qa-proxies-1}",
    `127.0.0.1:2:u2:secret2 [http://127.0.0.1:${ROTATE_PORT}/ok] {qa-proxies-2}`,
    "u3:secret3@127.0.0.1:3 {qa-proxies-3}",
    "127.0.0.1:4 {qa-proxies-4}",
    "# a comment",
    "not a proxy",
    "127.0.0.1:1",
  ].join("\n");
  const parsed = await post("/api/proxies/parse", { text, defaultScheme: "socks5" });
  const rows = parsed.json || [];
  check("parse previews every non-comment line", parsed.code === 200 && rows.length === 6, parsed.text.slice(0, 200));
  check("parse marks the junk line with an error", rows[4] && !rows[4].ok && /invalid proxy/.test(rows[4].error), rows[4]);
  check("parse flags the in-text duplicate", rows[5]?.ok && rows[5].duplicate === true, rows[5]);
  check("parse applies the default scheme to bare lines", rows[3]?.proxy?.scheme === "socks5" && rows[0]?.proxy?.scheme === "http", rows.map((r) => r.proxy?.scheme));
  check("parse reads [changeIpUrl] and {name}", rows[1]?.proxy?.changeIpUrl === `http://127.0.0.1:${ROTATE_PORT}/ok` && rows[1]?.proxy?.name === "qa-proxies-2", rows[1]);
  check("parse never returns a password", !/secret/.test(parsed.text) && rows[0]?.line === "http://qa:***@127.0.0.1:1 {qa-proxies-1}" && rows[1]?.line.startsWith("127.0.0.1:2:u2:*** ["), parsed.text.slice(0, 300));
  check("parse writes nothing", (await get("/api/proxies")).json.length === before.length);
  check("parse refuses a non-string", (await post("/api/proxies/parse", { text: 5 })).code === 400);

  // --- add
  const added = await post("/api/proxies", { text, defaultScheme: "socks5" });
  check("POST adds the new lines", added.code === 200 && added.json?.added === 4, added.text.slice(0, 200));
  check("POST counts duplicates and returns line errors", added.json?.duplicates === 1 && added.json?.errors?.length === 1 && added.json.errors[0].line === "not a proxy", added.json);
  const again = await post("/api/proxies", { text: "127.0.0.1:4" });
  check("POST twice adds nothing", again.json?.added === 0 && again.json?.duplicates === 1, again.json);

  // --- txt merge
  fs.writeFileSync(TXT, "127.0.0.1:6 {qa-proxies-6}\n127.0.0.1:1\n");
  let lib = (await get("/api/proxies")).json;
  const mine = () => Object.fromEntries(lib.filter((p) => KEYS.includes(`${p.host}:${p.port}`)).map((p) => [p.port, p]));
  let m = mine();
  check("resources/proxies/*.txt lines merge in", m[6]?.name === "qa-proxies-6" && /^[0-9a-f]{8}$/.test(m[6].id), m[6]);
  check("json entries win over txt lines", m[1]?.name === "qa-proxies-1" && lib.filter((p) => p.port === 1 && p.host === "127.0.0.1").length === 1);
  check("GET never sends passwords", !/secret/.test(JSON.stringify(lib)) && m[2]?.hasPassword === true && !("password" in m[2]), m[2]);
  check("GET entries carry check and isAssigned", m[1]?.check === null && m[1]?.isAssigned === false && m[1]?.assignedTo === null);
  const disk = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "proxies.json"), "utf8")).find((p) => p.id === m[2].id);
  check("stored entry keeps the documented shape", disk && ["id", "name", "scheme", "host", "port", "username", "password", "changeIpUrl", "notes", "createdAt", "check"].every((k) => k in disk) && disk.password === "secret2", Object.keys(disk || {}));

  // --- patch
  const p1 = m[1].id, p2 = m[2].id, p3 = m[3].id, p4 = m[4].id, p6 = m[6].id;
  const ed = await patch(`/api/proxies/${p4}`, { name: "qa-proxies-4b", notes: "qa note", scheme: "https", username: "qa", password: "secret4" });
  check("PATCH edits name, notes, scheme and auth", ed.code === 200 && ed.json?.name === "qa-proxies-4b" && ed.json.notes === "qa note" && ed.json.scheme === "https" && ed.json.hasPassword && !/secret/.test(ed.text), ed.text.slice(0, 200));
  check("PATCH refuses a bad scheme", (await patch(`/api/proxies/${p4}`, { scheme: "ftp" })).code === 400);
  check("PATCH refuses a non-http change-IP URL", (await patch(`/api/proxies/${p4}`, { changeIpUrl: "javascript:alert(1)" })).code === 400);
  check("PATCH 404s an unknown id", (await patch("/api/proxies/00000000", { name: "x" })).code === 404);

  // --- check (with the broadcast)
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Host: `127.0.0.1:${PORT}` } });
  const events = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === "proxy") events.push(msg.data);
  });
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  const checked = await post("/api/proxies/check", { ids: [p1, p3] });
  check("check returns the summary", checked.code === 200 && checked.json?.checked === 2 && checked.json.failed === 2, checked.json);
  await new Promise((r) => setTimeout(r, 200));
  check("check broadcasts a proxy event per id", events.filter((e) => [p1, p3].includes(e.id) && e.check?.ok === false).length === 2, events);
  lib = (await get("/api/proxies")).json;
  m = mine();
  check("check stores { ok, error, at }", m[1]?.check?.ok === false && m[1].check.error && Date.now() - Date.parse(m[1].check.at) < 60_000, m[1]?.check);
  check("check refuses an empty ids list", (await post("/api/proxies/check", { ids: [] })).code === 400);
  ws.close();

  // --- rotate
  check("rotate refuses a proxy without a change-IP URL", (await post(`/api/proxies/${p3}/rotate`)).code === 400);
  const rot = await post(`/api/proxies/${p2}/rotate`);
  check("rotate calls the URL, waits and re-checks", rot.code === 200 && rotations === 1 && rot.json?.check?.at && rot.json.check.ok === false, rot.text.slice(0, 200));
  await patch(`/api/proxies/${p2}`, { changeIpUrl: `http://127.0.0.1:${ROTATE_PORT}/bad` });
  const bad = await post(`/api/proxies/${p2}/rotate`);
  check("rotate reports a non-2xx answer", bad.code === 502 && /500/.test(bad.json?.error), bad.text);

  // --- assign: two qa profiles on proxies outside the library
  for (const [i, name] of PROFILES.entries()) {
    const c = await post("/api/sessions/create", { name, proxy: `127.0.0.1:${50 + i}` });
    check(`create ${name}`, c.code === 200, c.text.slice(0, 200));
  }
  check("assign refuses a bad source", (await post("/api/proxies/assign", { profiles: PROFILES, source: "bogus" })).code === 400);
  const plan = await post("/api/proxies/assign", { profiles: PROFILES, source: "ids", ids: [p1, p3], order: "sequential", dryRun: true });
  check("dry run plans one proxy per profile, in order", plan.code === 200 && plan.json?.plan?.[0]?.proxy?.id === p1 && plan.json.plan[1]?.proxy?.id === p3, plan.json);
  check("dry run writes nothing", manager.getSession(PROFILES[0]).proxy.port === 50);
  const okPlan = await post("/api/proxies/assign", { profiles: PROFILES, source: "unused-ok", order: "random", dryRun: true });
  const okIds = new Set(((await get("/api/proxies")).json || []).filter((p) => p.check?.ok).map((p) => p.id));
  check("unused-ok only plans checked proxies", okPlan.code === 200 && okPlan.json.plan.every((r) => (r.proxy ? okIds.has(r.proxy.id) : /no checked/.test(r.error))), okPlan.json);
  const bulk = await post("/api/sessions/bulk", { ids: PROFILES, action: "proxy", value: { source: "ids", ids: [p1, p3], order: "sequential" } });
  const s1 = manager.getSession(PROFILES[0]);
  const s2 = manager.getSession(PROFILES[1]);
  check("bulk proxy assigns each profile its own proxy", bulk.json?.ok === 2 && s1.proxy.port === 1 && s1.proxy.password === "secret1" && s2.proxy.port === 3, bulk.json);
  check("bulk proxy rebuilds the fingerprint", s1.fingerprint?.file === s1.fingerprintFile, s1.fingerprint?.file);
  check("library entries are not copied into the record", !("id" in s1.proxy) && !("check" in s1.proxy), s1.proxy);
  const short = await post("/api/sessions/bulk", { ids: PROFILES, action: "proxy", value: { source: "ids", ids: [p6], order: "sequential" } });
  check("bulk proxy reports profiles it could not serve", short.json?.ok === 1 && /no unused/.test(short.json.failed?.[0]?.error), short.json);
  lib = (await get("/api/proxies")).json;
  m = mine();
  check("GET shows the new binding", m[6]?.assignedTo === PROFILES[0] && m[3]?.assignedTo === PROFILES[1] && m[1]?.isAssigned === false, [m[6]?.assignedTo, m[3]?.assignedTo]);

  // --- delete
  const refused = await del(`/api/proxies/${p3}`);
  check("DELETE refuses a bound proxy with 409", refused.code === 409 && refused.json?.assignedTo === PROFILES[1], refused.text);
  const forced = await del(`/api/proxies/${p3}?force=1`);
  check("DELETE ?force=1 says the profile keeps its copy", forced.code === 200 && forced.json?.keptBy === PROFILES[1] && /keeps its copy/.test(forced.json?.note), forced.json);
  check("the profile still has the proxy", manager.getSession(PROFILES[1]).proxy.port === 3);
  check("DELETE 404s an unknown id", (await del("/api/proxies/00000000")).code === 404);

  // --- the old probe still answers
  const t = await post("/api/proxies/test", { url: "http://127.0.0.1:1" });
  check("POST /api/proxies/test still works", t.code === 200 && t.json?.ok === false, t.text);
}

async function cleanup() {
  if (!owned) return;
  for (const id of PROFILES) {
    try { await manager.trashSession(id); } catch {}
    try { await manager.purgeTrash({ id }); } catch {}
  }
  fs.rmSync(TXT, { force: true });
  const lib = (await get("/api/proxies")).json || [];
  for (const p of lib.filter((x) => KEYS.includes(`${x.host}:${x.port}`))) await del(`/api/proxies/${p.id}?force=1`);
  try {
    const kept = JSON.parse(fs.readFileSync(REMOVED, "utf8")).filter((k) => !KEYS.includes(k));
    if (kept.length) fs.writeFileSync(REMOVED, JSON.stringify(kept, null, 2));
    else fs.rmSync(REMOVED, { force: true });
  } catch {}
}

/** The formats parseProxy accepts, without a server. */
function parserSelfCheck() {
  const P = manager.parseProxy;
  const base = { username: "", password: "", changeIpUrl: "", name: "" };
  assert.deepStrictEqual(P("socks5://a:b@h.io:1080"), { ...base, scheme: "socks5", host: "h.io", port: 1080, username: "a", password: "b" });
  assert.deepStrictEqual(P("h.io:8080"), { ...base, scheme: "http", host: "h.io", port: 8080 });
  assert.deepStrictEqual(P("h.io:8080", "socks5").scheme, "socks5");
  assert.deepStrictEqual(P("h.io:8080:u:p:w"), { ...base, scheme: "http", host: "h.io", port: 8080, username: "u", password: "p:w" });
  assert.deepStrictEqual(P("u:p@h.io:8080"), { ...base, scheme: "http", host: "h.io", port: 8080, username: "u", password: "p" });
  assert.deepStrictEqual(P("h.io:1 [https://x.io/r?k=1] {Home 1}"), { ...base, scheme: "http", host: "h.io", port: 1, changeIpUrl: "https://x.io/r?k=1", name: "Home 1" });
  assert.deepStrictEqual(P("h.io:1 {n} [http://x.io]").changeIpUrl, "http://x.io");
  for (const junk of ["", "h.io", "h.io:0", "h.io:99999", "h.io:1:u", "h.io:1 [ftp://x]", "http://:8080", "a b:1"]) {
    assert.throws(() => P(junk), /invalid proxy/, junk);
  }
  for (const [line, secret] of [["http://u:hunter2@h.io:x", "hunter2"], ["u:hun:ter2@h.io:x", "ter2"], ["h.io:1:u:hunter2:x [x]", "hunter2"]]) {
    assert.throws(() => P(line), (err) => !err.message.includes(secret), line);
  }
}

(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  let crashed = null;
  try {
    await main();
  } catch (err) {
    crashed = err;
  } finally {
    await cleanup();
    if (rotateServer.listening) rotateServer.close();
  }
  try {
    parserSelfCheck();
    check("parseProxy self-check", true);
  } catch (err) {
    check("parseProxy self-check", false, err.message);
  }
  if (crashed) check("check ran to the end", false, crashed.stack);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  — ${r.detail}`}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
