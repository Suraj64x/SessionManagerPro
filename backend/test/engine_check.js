// Engine feature: GET /api/engine, the read-only "versions" setting, and POST /api/engine/fetch
// with its `engine` broadcasts. Starts the server in-process on 3019 against this checkout.
// The fetch only re-verifies the cached engine (it is already downloaded here); nothing is
// launched. data/app.json is restored byte for byte at the end.
//
//   node backend/test/engine_check.js
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
process.chdir(ROOT);
process.argv.push("--no-open", "--no-terminal");
const PORT = 3019;
process.env.PORT = String(PORT);

const APP_FILE = path.join(ROOT, "data", "app.json");
const appBefore = fs.existsSync(APP_FILE) ? fs.readFileSync(APP_FILE) : null;

const { server } = require(path.join(ROOT, "backend/src/server.js"));
const { findPythonExe } = require(path.join(ROOT, "backend/src/worker_runner.js"));
const WebSocket = require(path.join(ROOT, "backend/node_modules/ws"));

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
const HEADERS = { Host: `127.0.0.1:${PORT}`, "X-SMP": "1", "Content-Type": "application/json" };

async function call(method, p, body, headers = HEADERS) {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { code: res.status, json: await res.json().catch(() => null) };
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

  const t0 = Date.now();
  const first = await call("GET", "/api/engine");
  const e = first.json || {};
  check(
    "GET /api/engine → 200 { python, ready, detail, cacheDir, fetching, versions }",
    first.code === 200 && ["python", "ready", "detail", "cacheDir", "fetching", "versions"].every((k) => k in e),
    `HTTP ${first.code} ${JSON.stringify(e).slice(0, 200)}`
  );
  check("python is the worker's Python", e.python === findPythonExe(), e.python);
  check("ready: the cached engine verifies against the seal", e.ready === true && /firefox-\d+/.test(e.detail), e.detail);
  check("cacheDir is an existing folder", e.cacheDir && fs.existsSync(e.cacheDir), e.cacheDir);
  check("fetching is false at rest", e.fetching === false);
  check("versions.app is package.json's", e.versions?.app === pkg.version, JSON.stringify(e.versions));
  check("versions.engine and versions.firefox are set", /^\d+\.\d+/.test(e.versions?.engine || "") && /^\d+\.\d+/.test(e.versions?.firefox || ""), JSON.stringify(e.versions));
  const firstMs = Date.now() - t0;

  const t1 = Date.now();
  await call("GET", "/api/engine");
  const cachedMs = Date.now() - t1;
  check("a second GET within a minute is cached (< 50 ms)", cachedMs < 50, `${firstMs} ms, then ${cachedMs} ms`);

  const app = await call("GET", "/api/app");
  check("GET /api/app carries the same versions", JSON.stringify(app.json?.versions) === JSON.stringify(e.versions), JSON.stringify(app.json?.versions));

  const ro = await call("PATCH", "/api/app", { versions: { app: "9.9.9" } });
  check("PATCH versions → 400 versions is read-only", ro.code === 400 && ro.json?.error === "versions is read-only", `HTTP ${ro.code} ${ro.json?.error}`);

  const same = await call("PATCH", "/api/app", { closeBehavior: app.json.closeBehavior });
  const disk = JSON.parse(fs.readFileSync(APP_FILE, "utf8"));
  check("PATCH of another key keeps versions out of data/app.json", same.code === 200 && !("versions" in disk) && same.json?.versions?.app === pkg.version, JSON.stringify(Object.keys(disk)));

  const guard = await call("POST", "/api/engine/fetch", undefined, { Host: `127.0.0.1:${PORT}` });
  check("POST /api/engine/fetch without X-SMP is refused", guard.code === 403, `HTTP ${guard.code}`);

  // Listen before starting, so no line is missed.
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Host: `127.0.0.1:${PORT}` } });
  await new Promise((res, rej) => (ws.once("open", res), ws.once("error", rej)));
  const events = [];
  const finished = new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("no done/error event within 120 s")), 120_000);
    ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      if (m.type !== "engine") return;
      events.push(m.data);
      if (m.data.state !== "running") (clearTimeout(t), res(m.data));
    });
  });

  const start = await call("POST", "/api/engine/fetch");
  check("POST /api/engine/fetch → 200 { ok: true }", start.code === 200 && start.json?.ok === true, `HTTP ${start.code} ${JSON.stringify(start.json)}`);
  const twice = await call("POST", "/api/engine/fetch");
  check("a second fetch while one runs → 409", twice.code === 409 && /already running/.test(twice.json?.error), `HTTP ${twice.code} ${twice.json?.error}`);
  const during = await call("GET", "/api/engine");
  check("GET /api/engine reports fetching while it runs", during.json?.fetching === true);

  const end = await finished;
  ws.close();
  const lines = events.filter((x) => x.state === "running");
  check("output lines stream as engine { state: running, line }", lines.length > 0 && lines.every((x) => typeof x.line === "string" && x.line), `${lines.length} lines, e.g. ${JSON.stringify(lines[0]?.line)}`);
  check("the run ends with engine { state: done, line: detail }", end.state === "done" && /firefox-\d+/.test(end.line), JSON.stringify(end));

  const after = (await call("GET", "/api/engine")).json;
  check("afterwards: ready and not fetching", after?.ready === true && after?.fetching === false, JSON.stringify(after).slice(0, 160));
}

server.listen(PORT, "127.0.0.1", async () => {
  try {
    await main();
  } catch (err) {
    check("UNCAUGHT", false, err.stack);
  } finally {
    if (appBefore) fs.writeFileSync(APP_FILE, appBefore);
    else fs.rmSync(APP_FILE, { force: true });
    check("cleanup: data/app.json restored", appBefore ? fs.readFileSync(APP_FILE).equals(appBefore) : !fs.existsSync(APP_FILE));
    server.close();
    for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail && (!r.ok || /ms$|lines/.test(r.detail)) ? "  — " + r.detail : ""}`);
    console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }
});
