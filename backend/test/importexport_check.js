// Import/export feature: row import, cookie files, .smp export + download, import round trip,
// hostile archives. In-process server on 3014; creates only qa-importexport-* profiles and
// removes them (trash → purge) at the end.
//
//   node backend/test/importexport_check.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
process.chdir(ROOT);
process.argv.push("--no-open", "--no-terminal");
const PORT = 3014;
process.env.PORT = String(PORT);
const { server } = require(path.join(ROOT, "backend/src/server.js"));
const manager = require(path.join(ROOT, "backend/src/manager.js"));
const orchestrator = require(path.join(ROOT, "backend/src/orchestrator.js"));

const DATA = path.join(ROOT, "data");
const FPTS = path.join(ROOT, "resources", "fpts");
const SCRATCH = path.join(os.tmpdir(), "smp-importexport-check");
const P = "qa-importexport";
const TAR = fs.existsSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"))
  ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
  : "tar";

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });

async function call(route, { method = "GET", body, raw, type } = {}) {
  const headers = { Host: `127.0.0.1:${PORT}` };
  if (method !== "GET") headers["X-SMP"] = "1";
  if (raw !== undefined) headers["Content-Type"] = type || "application/zip";
  else if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`http://127.0.0.1:${PORT}${route}`, {
    method,
    headers,
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try {
    json = JSON.parse(buf.toString("utf8"));
  } catch {}
  return { code: res.status, json, buf, headers: res.headers };
}

const list = (archive) => execFileSync(TAR, ["-tf", archive]).toString().split(/\r?\n/).filter(Boolean);
function extract(archive) {
  const dir = path.join(SCRATCH, `x-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync(TAR, ["-xf", archive, "-C", dir]);
  return dir;
}
/** Zips `dir` into an .smp; `extraArgs` lets a test smuggle in a hostile entry with -P. */
function pack(dir, extraArgs = []) {
  const out = path.join(SCRATCH, `pack-${Date.now()}-${Math.random().toString(16).slice(2, 6)}.smp`);
  execFileSync(TAR, ["--format", "zip", "-cf", out, ...extraArgs, "-C", dir, "."]);
  return fs.readFileSync(out);
}

const COOKIE = [{ name: "sid", value: "abc", domain: ".example.com", path: "/", expires: 2000000000 }];
const NETSCAPE = "# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tFALSE\t2000000000\tsid\tabc\n";
const cookieFile = (id) => path.join(DATA, "cookies", `${id}.json`);
const stagedFile = (id) => path.join(DATA, "cookies", `${id}.import.json`);
const countStaged = (id) => (fs.existsSync(stagedFile(id)) ? JSON.parse(fs.readFileSync(stagedFile(id), "utf8")).length : 0);

async function main() {
  // --- rows import: every field lands, bad rows are reported not fatal
  const rows = [
    { name: `${P}-a`, tags: "Alpha, beta", status: "warming", folder: "qa", notes: "hello", startUrl: "https://example.com https://example.org", cookies: JSON.stringify(COOKIE) },
    { name: `${P}-b`, proxy: "http://qa:pw@10.9.8.7:3128" },
    { name: "", proxy: "" },
    { name: `${P}-a` },
    { name: `${P}-c`, proxy: "not a proxy" },
    { name: `${P}-d`, cookies: "nonsense text" },
  ];
  const r1 = await call("/api/import/profiles", { method: "POST", body: { rows } });
  check("POST /api/import/profiles creates 2 and skips 4", r1.code === 200 && r1.json?.created === 2 && r1.json?.skipped?.length === 4, r1.json);
  const errs = (r1.json?.skipped || []).map((s) => s.error).join(" | ");
  check("skipped rows carry readable errors", /name is empty/.test(errs) && /already exists/.test(errs) && /invalid proxy/.test(errs) && /no valid cookies/.test(errs), errs);
  const a = manager.getSession(`${P}-a`);
  check(
    "row fields → tags, label, folder, notes, startUrls",
    a && a.tags?.join() === "alpha,beta" && a.label === "warming" && a.folder === "qa" && a.notes === "hello" && a.startUrls?.length === 2 && a.email === a.id,
    a && { tags: a.tags, label: a.label, folder: a.folder, notes: a.notes, startUrls: a.startUrls }
  );
  check("row cookies are staged for the next launch", countStaged(`${P}-a`) === 1);
  const b = manager.getSession(`${P}-b`);
  check("row proxy is parsed and bound", b?.proxy?.host === "10.9.8.7" && b.proxy.port === 3128 && b.proxy.username === "qa" && b.proxy.password === "pw", b?.proxy);
  check("a failed row leaves no profile behind", !manager.getSession(`${P}-c`) && !manager.getSession(`${P}-d`));

  check("rows must be an array", (await call("/api/import/profiles", { method: "POST", body: { rows: "x" } })).code === 400);
  check("more than 500 rows is refused", (await call("/api/import/profiles", { method: "POST", body: { rows: Array.from({ length: 501 }, () => ({ name: "x" })) } })).code === 400);

  // --- cookie files: one profile per file, named after the file
  const r2 = await call("/api/import/cookie-files", {
    method: "POST",
    body: { files: [{ name: `${P}-ck.txt`, text: NETSCAPE }, { name: `${P}-empty.json`, text: "" }, { name: `${P}-a.json`, text: JSON.stringify(COOKIE) }] },
  });
  check("POST /api/import/cookie-files creates 1, skips empty + existing", r2.code === 200 && r2.json?.created === 1 && r2.json?.skipped?.length === 2, r2.json);
  check("profile is named after the file without its extension, cookies staged", !!manager.getSession(`${P}-ck`) && countStaged(`${P}-ck`) === 1);

  // --- export
  fs.writeFileSync(path.join(a.userDataDir, "qa-marker.txt"), "x");
  fs.mkdirSync(path.join(DATA, "cookies"), { recursive: true });
  fs.writeFileSync(cookieFile(`${P}-a`), JSON.stringify(COOKIE));
  const r3 = await call("/api/sessions/export", { method: "POST", body: { ids: [`${P}-a`, "nope"], includeBrowserData: true } });
  const f = r3.json?.files?.[0];
  check("POST /api/sessions/export → one file + one skipped", r3.code === 200 && r3.json?.files?.length === 1 && f?.id === `${P}-a` && f.url === `/api/exports/${P}-a.smp` && f.bytes > 0 && r3.json.skipped?.[0]?.error === "not found", r3.json);
  check("export temp folder removed", !fs.existsSync(path.join(DATA, "exports", `tmp-${P}-a`)));

  const dl = await call(f.url);
  check("GET /api/exports/<name>.smp downloads a zip", dl.code === 200 && dl.buf.slice(0, 2).toString() === "PK" && /attachment/.test(dl.headers.get("content-disposition") || ""), `${dl.code} ${dl.headers.get("content-disposition")}`);
  const aZip = path.join(SCRATCH, "a.smp");
  fs.writeFileSync(aZip, dl.buf);
  const entries = list(aZip);
  check("archive holds profile.json, cookies.json, the fpt and the browser data", ["profile.json", "cookies.json", `fpt/${a.fingerprintFile}`, "profile/qa-marker.txt"].every((e) => entries.includes(`./${e}`)), entries.slice(0, 8));
  const aDir = extract(aZip);
  const aProfile = JSON.parse(fs.readFileSync(path.join(aDir, "profile.json"), "utf8"));
  check("profile.json has no userDataDir and no proxy password by default", aProfile.id === `${P}-a` && !("userDataDir" in aProfile) && aProfile.proxy && aProfile.proxy.password === "", { userDataDir: aProfile.userDataDir, pw: aProfile.proxy?.password });
  check("cookies.json holds the dump", JSON.parse(fs.readFileSync(path.join(aDir, "cookies.json"), "utf8")).length === 1);

  const r4 = await call("/api/sessions/export", { method: "POST", body: { ids: [`${P}-b`], includeProxyPassword: true } });
  const bZip = path.join(SCRATCH, "b.smp");
  fs.writeFileSync(bZip, (await call(r4.json.files[0].url)).buf);
  const bEntries = list(bZip);
  const bProfile = JSON.parse(fs.readFileSync(path.join(extract(bZip), "profile.json"), "utf8"));
  check("includeProxyPassword keeps the password; no profile/ without includeBrowserData", bProfile.proxy?.password === "pw" && !bEntries.some((e) => e.startsWith("./profile/")), bEntries);

  orchestrator.live.set(`${P}-b`, { id: `${P}-b`, handle: {}, startedAt: new Date().toISOString() });
  try {
    const r5 = await call("/api/sessions/export", { method: "POST", body: { ids: [`${P}-b`] } });
    check("a running profile is skipped, not exported", r5.json?.files?.length === 0 && /running/.test(r5.json?.skipped?.[0]?.error || ""), r5.json);
  } finally {
    orchestrator.live.delete(`${P}-b`);
  }
  check("GET /api/exports refuses a traversal name", (await call("/api/exports/..%2Fsessions.json")).code === 400);
  check("GET /api/exports 404s an unknown file", (await call("/api/exports/nope.smp")).code === 404);

  // --- import round trip: collision → -2, -3; fields, cookies and browser data restored
  const i1 = await call("/api/sessions/import", { method: "POST", raw: dl.buf });
  check("POST /api/sessions/import creates <id>-2 on a name collision", i1.code === 200 && i1.json?.created?.[0] === `${P}-a-2` && i1.json.skipped?.length === 0, i1.json);
  const a2 = manager.getSession(`${P}-a-2`);
  check(
    "imported record keeps tags, label, folder, notes, startUrls, seed",
    a2 && a2.tags?.join() === "alpha,beta" && a2.label === "warming" && a2.folder === "qa" && a2.notes === "hello" && a2.startUrls?.length === 2 && a2.seed === a.seed,
    a2 && { tags: a2.tags, label: a2.label, seed: a2.seed }
  );
  check("taken proxy and fingerprint are replaced from the pool", a2 && a2.proxy?.host && `${a2.proxy.host}:${a2.proxy.port}` !== `${a.proxy.host}:${a.proxy.port}` && a2.fingerprintFile && a2.fingerprintFile !== a.fingerprintFile, a2 && { proxy: a2.proxy?.host, fpt: a2.fingerprintFile });
  check("cookies copied to data/cookies/<id>.json and counted", fs.existsSync(cookieFile(`${P}-a-2`)) && a2?.cookieCount === 1);
  check("browser data restored into the new userDataDir", a2 && fs.existsSync(path.join(a2.userDataDir, "qa-marker.txt")));
  check("with browser data present nothing is staged", countStaged(`${P}-a-2`) === 0);
  const i2 = await call("/api/sessions/import", { method: "POST", raw: dl.buf });
  check("second import → <id>-3", i2.json?.created?.[0] === `${P}-a-3`, i2.json);

  // Free the name: the exported proxy, fingerprint and seed come back as they were.
  await manager.trashSession(`${P}-b`);
  await manager.purgeTrash({ id: `${P}-b` });
  const i3 = await call("/api/sessions/import", { method: "POST", raw: fs.readFileSync(bZip) });
  const b2 = manager.getSession(`${P}-b`);
  check(
    "import keeps a free proxy (with password), fingerprint and seed",
    i3.json?.created?.[0] === `${P}-b` && b2?.proxy?.host === "10.9.8.7" && b2.proxy.password === "pw" && b2.fingerprintFile === b.fingerprintFile && b2.seed === b.seed && b2.fingerprint?.timezone === b.fingerprint?.timezone,
    i3.json
  );

  // --- a packed fingerprint file lands in resources/fpts when missing; cookies staged without browser data
  const fptDir = path.join(SCRATCH, "fpt-src");
  fs.mkdirSync(path.join(fptDir, "fpt"), { recursive: true });
  fs.writeFileSync(path.join(fptDir, "profile.json"), JSON.stringify({ id: `${P}-fpt`, fingerprintFile: `${P}-fpt.json`, tags: ["z"], color: "#123456" }));
  fs.writeFileSync(path.join(fptDir, "fpt", `${P}-fpt.json`), JSON.stringify({ attr: {} }));
  fs.writeFileSync(path.join(fptDir, "cookies.json"), JSON.stringify(COOKIE));
  const i4 = await call("/api/sessions/import", { method: "POST", raw: pack(fptDir) });
  const fp = manager.getSession(`${P}-fpt`);
  check("missing fpt is copied into resources/fpts and bound", i4.json?.created?.[0] === `${P}-fpt` && fs.existsSync(path.join(FPTS, `${P}-fpt.json`)) && fp?.fingerprintFile === `${P}-fpt.json` && fp.color === "#123456", i4.json);
  check("without browser data the cookies are staged for the first launch", countStaged(`${P}-fpt`) === 1 && fs.existsSync(cookieFile(`${P}-fpt`)));

  // --- hostile and malformed archives
  const evilDir = path.join(SCRATCH, "evil");
  fs.mkdirSync(evilDir, { recursive: true });
  fs.writeFileSync(path.join(evilDir, "profile.json"), JSON.stringify({ id: `${P}-evil` }));
  fs.writeFileSync(path.join(SCRATCH, `${P}-evil.txt`), "x");
  const evil = pack(evilDir, ["-P", "-C", evilDir, `../${P}-evil.txt`]);
  const i5 = await call("/api/sessions/import", { method: "POST", raw: evil });
  check("an archive with a .. entry is refused before extraction", i5.code === 200 && i5.json?.created?.length === 0 && /refusing archive entry/.test(i5.json?.skipped?.[0]?.error || "") && !manager.getSession(`${P}-evil`) && !fs.existsSync(path.join(DATA, `${P}-evil.txt`)), i5.json);
  const noneDir = path.join(SCRATCH, "none");
  fs.mkdirSync(noneDir, { recursive: true });
  fs.writeFileSync(path.join(noneDir, "readme.txt"), "x");
  const i6 = await call("/api/sessions/import", { method: "POST", raw: pack(noneDir) });
  check("an archive without profile.json is reported", /profile\.json is missing/.test(i6.json?.skipped?.[0]?.error || ""), i6.json);
  check("a JSON body is not an archive", (await call("/api/sessions/import", { method: "POST", body: { x: 1 } })).code === 400);
  check("garbage bytes fail cleanly", (await call("/api/sessions/import", { method: "POST", raw: Buffer.from("not a zip at all") })).json?.skipped?.length === 1);
  check("import temp files cleaned up", !fs.readdirSync(path.join(DATA, "exports")).some((n) => n.startsWith("import-")));
}

server.listen(PORT, "127.0.0.1", async () => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  try {
    await main();
  } catch (e) {
    check("UNCAUGHT", false, e.stack);
  } finally {
    const mine = () => [...manager.listSessions(), ...manager.listTrash()].map((s) => s.id).filter((id) => id.startsWith(`${P}-`));
    for (const id of mine()) {
      try { await manager.trashSession(id); } catch {}
      try { await manager.purgeTrash({ id }); } catch {}
    }
    for (const dir of [path.join(DATA, "cookies"), path.join(DATA, "exports")]) {
      if (!fs.existsSync(dir)) continue;
      for (const n of fs.readdirSync(dir)) if (n.startsWith(`${P}-`)) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
    }
    fs.rmSync(path.join(FPTS, `${P}-fpt.json`), { force: true });
    fs.rmSync(SCRATCH, { recursive: true, force: true });
    check("cleanup: no qa-importexport-* profiles, cookies, exports or fpt files left", mine().length === 0 && !fs.existsSync(path.join(FPTS, `${P}-fpt.json`)), `${mine().length} left`);
    for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${!r.ok && r.detail ? "  — " + r.detail : ""}`);
    console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
    server.close();
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }
});
