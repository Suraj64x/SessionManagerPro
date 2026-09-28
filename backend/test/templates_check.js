// Checks features/templates.js against the real server in-process on port 3012. Creates only
// qa-templates-* profiles and templates, trashes + purges them, and restores data/templates.json.
// The proxy-library branch reads a scratch file (SMP_TEMPLATES_PROXIES_FILE), never data/proxies.json.
//
//   node backend/test/templates_check.js
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
process.chdir(ROOT);
process.argv.push("--no-open", "--no-terminal");
const PORT = 3012;
process.env.PORT = String(PORT);
const SCRATCH = path.join(os.tmpdir(), "smp-templates-check");
const LIB = path.join(SCRATCH, "proxies.json");
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
process.env.SMP_TEMPLATES_PROXIES_FILE = LIB; // absent until the library test writes it

const TEMPLATES = path.join(ROOT, "data", "templates.json");
const backup = fs.existsSync(TEMPLATES) ? fs.readFileSync(TEMPLATES) : null;
fs.rmSync(TEMPLATES, { force: true }); // so the seed path runs

const { server } = require(path.join(ROOT, "backend/src/server.js"));
const manager = require(path.join(ROOT, "backend/src/manager.js"));

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
const PREFIX = "qa-templates-";
const today = new Date().toISOString().slice(0, 10);

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

async function main() {
  // --- seed
  const seeded = await get("/api/templates");
  check("GET seeds one Default template (pattern profile-{n}, isDefault)", seeded.code === 200 && seeded.json?.length === 1 && seeded.json[0].name === "Default" && seeded.json[0].pattern === "profile-{n}" && seeded.json[0].isDefault === true, seeded.text.slice(0, 200));
  const defaultId = seeded.json?.[0]?.id;

  // --- validation
  for (const [what, body] of [
    ["a bad start URL", { name: "x", pattern: "x-{n}", startUrls: ["ftp://nope"] }],
    ["an unknown proxy strategy", { name: "x", pattern: "x-{n}", proxyStrategy: "random" }],
    ["specific proxy without a URL", { name: "x", pattern: "x-{n}", proxyStrategy: "specific" }],
    ["a malformed specific proxy", { name: "x", pattern: "x-{n}", proxyStrategy: "specific", proxy: "not a proxy" }],
    ["specific fingerprint without a file", { name: "x", pattern: "x-{n}", fptStrategy: "specific" }],
    ["an unknown fingerprint file", { name: "x", pattern: "x-{n}", fptStrategy: "specific", fingerprintFile: "nope.json.gz" }],
    ["an unknown placeholder", { name: "x", pattern: "x-{foo}" }],
    ["illegal name characters", { name: "x", pattern: "x/{n}" }],
    ["an empty name", { name: " ", pattern: "x-{n}" }],
    ["an empty pattern", { name: "x", pattern: "" }],
  ]) {
    const r = await post("/api/templates", body);
    check(`POST refuses ${what}`, r.code === 400 && r.json?.error, `HTTP ${r.code} ${r.json?.error || ""}`);
  }

  // --- create + patch
  const a = await post("/api/templates", {
    name: "qa-templates-a",
    pattern: `${PREFIX}{n:03}-{date}`,
    folder: "qa-templates-folder",
    tags: ["QA", "qa", " Templates "],
    status: "warming",
    startUrls: ["https://example.com", "about:blank"],
    notes: "from template",
  });
  check("POST creates a template with cleaned tags", a.code === 200 && a.json?.id && a.json.isDefault === false && JSON.stringify(a.json.tags) === '["qa","templates"]' && a.json.status === "warming", a.text.slice(0, 200));
  const aId = a.json?.id;

  const d1 = await patch(`/api/templates/${aId}`, { isDefault: true });
  const listAfter = (await get("/api/templates")).json || [];
  check("PATCH isDefault moves the default (exactly one)", d1.json?.isDefault === true && listAfter.filter((t) => t.isDefault).length === 1 && listAfter.find((t) => t.id === defaultId)?.isDefault === false);
  const d2 = await patch(`/api/templates/${aId}`, { isDefault: false });
  check("PATCH isDefault:false on the default is ignored", d2.json?.isDefault === true);

  const p1 = await patch(`/api/templates/${aId}`, { proxyStrategy: "specific", proxy: "http://qa:s3cret@10.0.0.1:8080" });
  const stored = () => JSON.parse(fs.readFileSync(TEMPLATES, "utf8")).find((t) => t.id === aId);
  check("PATCH stores the proxy but the response redacts the password", p1.json?.proxy === "http://qa:***@10.0.0.1:8080" && stored().proxy === "http://qa:s3cret@10.0.0.1:8080", p1.json?.proxy);
  check("GET never contains the password", !(await get("/api/templates")).text.includes("s3cret"));
  const p2 = await patch(`/api/templates/${aId}`, { proxy: "http://qa:***@10.0.0.1:8080", notes: "edited" });
  check("PATCH with the redacted URL keeps the stored password", p2.code === 200 && stored().proxy === "http://qa:s3cret@10.0.0.1:8080" && stored().notes === "edited");
  const p3 = await patch(`/api/templates/${aId}`, { proxyStrategy: "unused" });
  check("PATCH back to 'unused' clears the proxy", p3.json?.proxy === "" && stored().proxy === "");
  check("PATCH unknown id → 404", (await patch("/api/templates/nope", { name: "x" })).code === 404);

  // --- create profiles: names, counters, record fields
  const c1 = await post(`/api/templates/${aId}/create`, { count: 2 });
  const names1 = (c1.json?.created || []).map((r) => r.id);
  check("create count=2 → two profiles named by the pattern ({n:03}, {date})", c1.code === 200 && JSON.stringify(names1) === JSON.stringify([`${PREFIX}001-${today}`, `${PREFIX}002-${today}`]) && c1.json.skipped.length === 0, c1.text.slice(0, 300));
  const rec = manager.getSession(names1[0]);
  check("created record carries tags, label, folder, start pages, notes and a pool proxy + fingerprint", rec && JSON.stringify(rec.tags) === '["qa","templates"]' && rec.label === "warming" && rec.folder === "qa-templates-folder" && rec.startUrls?.length === 2 && rec.notes === "edited" && rec.proxy?.host && rec.fingerprintFile, rec && JSON.stringify({ tags: rec.tags, label: rec.label, folder: rec.folder, startUrls: rec.startUrls, notes: rec.notes }));

  const c2 = await post(`/api/templates/${aId}/create`, { count: 1, folder: "qa-templates-other" });
  check("the counter skips existing ids and the folder override lands", c2.json?.created?.[0]?.id === `${PREFIX}003-${today}` && manager.getSession(`${PREFIX}003-${today}`)?.folder === "qa-templates-other", c2.text.slice(0, 200));

  await del(`/api/sessions/${encodeURIComponent(`${PREFIX}002-${today}`)}`); // trash it
  const c3 = await post(`/api/templates/${aId}/create`, {});
  check("a trashed name stays taken (count defaults to 1)", c3.json?.created?.[0]?.id === `${PREFIX}004-${today}`, c3.text.slice(0, 200));

  check("create count=0 → 400", (await post(`/api/templates/${aId}/create`, { count: 0 })).code === 400);
  check("create count=101 → 400", (await post(`/api/templates/${aId}/create`, { count: 101 })).code === 400);
  check("create on unknown template → 404", (await post("/api/templates/nope/create", {})).code === 404);

  // --- a fixed pattern (no {n}) creates once, then reports the clash
  const fixed = await post("/api/templates", { name: "qa-templates-fixed", pattern: `${PREFIX}fixed` });
  const f1 = await post(`/api/templates/${fixed.json.id}/create`, {});
  const f2 = await post(`/api/templates/${fixed.json.id}/create`, {});
  check("fixed pattern: first create works, second is skipped with a reason", f1.json?.created?.[0]?.id === `${PREFIX}fixed` && f2.json?.created?.length === 0 && /already exists/.test(f2.json?.skipped?.[0]?.error || ""), f2.text.slice(0, 200));
  check("fixed pattern with count>1 → 400", (await post(`/api/templates/${fixed.json.id}/create`, { count: 2 })).code === 400);

  // --- specific proxy and fingerprint
  const freeFpt = manager.listAllFingerprints().find((f) => !f.isAssigned && !f.error)?.file;
  const spec = await post("/api/templates", {
    name: "qa-templates-specific",
    pattern: `${PREFIX}spec-{n}`,
    proxyStrategy: "specific",
    proxy: "socks5://qa:pw@10.0.0.2:1080",
    fptStrategy: "specific",
    fingerprintFile: freeFpt,
  });
  check("POST accepts a specific proxy + a free fingerprint", spec.code === 200 && spec.json?.fingerprintFile === freeFpt, spec.text.slice(0, 200));
  const s1 = await post(`/api/templates/${spec.json?.id}/create`, {});
  const srec = s1.json?.created?.[0] && manager.getSession(s1.json.created[0].id);
  check("create uses the specific proxy (scheme kept) and fingerprint", srec?.proxy?.scheme === "socks5" && srec.proxy.host === "10.0.0.2" && srec.proxy.password === "pw" && srec.fingerprintFile === freeFpt, s1.text.slice(0, 200));
  check("specific resources with count>1 → 400", (await post(`/api/templates/${spec.json?.id}/create`, { count: 2 })).code === 400);
  const s2 = await post(`/api/templates/${spec.json?.id}/create`, {});
  check("a second create is skipped: the proxy is already bound", s2.json?.created?.length === 0 && /already bound/.test(s2.json?.skipped?.[0]?.error || ""), s2.text.slice(0, 200));

  // --- unused-ok: falls back without a library, picks a checked unbound one with it
  const ok = await post("/api/templates", { name: "qa-templates-ok", pattern: `${PREFIX}ok-{n}`, proxyStrategy: "unused-ok" });
  const o1 = await post(`/api/templates/${ok.json.id}/create`, {});
  check("unused-ok without a proxy library falls back to the pool", o1.json?.created?.length === 1 && manager.getSession(o1.json.created[0].id)?.proxy?.host, o1.text.slice(0, 200));
  const boundHost = rec.proxy; // bound by our own first profile
  fs.writeFileSync(LIB, JSON.stringify([
    { url: "http://u:p@10.0.0.9:9000", check: { ok: false } },
    { url: `http://${boundHost.username}:${boundHost.password}@${boundHost.host}:${boundHost.port}`, check: { ok: true } },
    { scheme: "http", host: "10.0.0.10", port: 9010, username: "lib", password: "pw", check: { ok: true } },
    { url: "not a proxy", check: { ok: true } },
  ]));
  const o2 = await post(`/api/templates/${ok.json.id}/create`, {});
  const orec = o2.json?.created?.[0] && manager.getSession(o2.json.created[0].id);
  check("unused-ok picks the checked, unbound library proxy (skips failed, bound and malformed entries)", orec?.proxy?.host === "10.0.0.10" && orec.proxy.port === 9010 && orec.proxy.username === "lib", o2.text.slice(0, 200));
  const o3 = await post(`/api/templates/${ok.json.id}/create`, {});
  check("unused-ok with nothing left is skipped with a reason", o3.json?.created?.length === 0 && /no checked/.test(o3.json?.skipped?.[0]?.error || ""), o3.text.slice(0, 200));

  // --- duplicate, delete
  await patch(`/api/templates/${spec.json.id}`, { isDefault: true });
  const dup = await post(`/api/templates/${spec.json.id}/duplicate`);
  const dupStored = JSON.parse(fs.readFileSync(TEMPLATES, "utf8")).find((t) => t.id === dup.json?.id);
  check("duplicate copies every field with ' copy', keeps the password, is not default", dup.code === 200 && dup.json.name === "qa-templates-specific copy" && dup.json.isDefault === false && dup.json.proxy === "socks5://qa:***@10.0.0.2:1080" && dupStored?.proxy === "socks5://qa:pw@10.0.0.2:1080", dup.text.slice(0, 200));

  const delDefault = await del(`/api/templates/${spec.json.id}`);
  const afterDel = (await get("/api/templates")).json || [];
  check("deleting the default makes the first remaining one default", delDefault.code === 200 && afterDel.length && afterDel[0].isDefault === true && afterDel.filter((t) => t.isDefault).length === 1 && delDefault.json.default === afterDel[0].id, delDefault.text);
  check("DELETE unknown id → 404", (await del("/api/templates/nope")).code === 404);
  for (const t of afterDel.slice(1)) await del(`/api/templates/${t.id}`);
  const last = await del(`/api/templates/${afterDel[0].id}`);
  check("the last template cannot be deleted (409)", last.code === 409 && (await get("/api/templates")).json?.length === 1, last.text);
}

server.listen(PORT, "127.0.0.1", async () => {
  try {
    await main();
  } catch (e) {
    check("UNCAUGHT", false, e.stack);
  } finally {
    const mine = () => [...manager.listSessions(), ...manager.listTrash()].filter((s) => s.id.startsWith(PREFIX)).map((s) => s.id);
    for (const id of mine()) {
      try { await manager.trashSession(id); } catch {}
      try { await manager.purgeTrash({ id }); } catch {}
    }
    if (backup) fs.writeFileSync(TEMPLATES, backup); else fs.rmSync(TEMPLATES, { force: true });
    fs.rmSync(SCRATCH, { recursive: true, force: true });
    const leftover = mine().length;
    check("cleanup: no qa-templates-* profiles left, templates.json restored", leftover === 0 && (backup ? fs.readFileSync(TEMPLATES).equals(backup) : !fs.existsSync(TEMPLATES)), `${leftover} left`);
    for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${!r.ok && r.detail ? "  — " + r.detail : ""}`);
    console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
    server.close();
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }
});
