// Engine status, first-run download and versions. See README.md in this folder for deps.
//
//   GET  /api/engine        { python, ready, fetching, detail, cacheDir, versions }
//   POST /api/engine/fetch  starts `python -m invisible_playwright fetch` once; lines stream as
//                           `engine` broadcasts { state: running | done | error, line }
//
// `status()` is also exported for the CLI selfcheck (no server needed).
const fs = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");
const { findPythonExe, workerEnv } = require("../worker_runner");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const RUNTIME_PYTHON = path.join(ROOT, "runtime", "python", "python.exe");
const STATUS_TTL_MS = 60_000;

// engine_status() verifies the cached tree against the seal and never downloads.
const STATUS_PY =
  "import json; from invisible_core import download as d; ok, detail = d.engine_status(); " +
  "print(json.dumps({'ready': bool(ok), 'detail': str(detail), 'cacheDir': str(d.cache_root())}))";

/** runtime\python\python.exe → runtime\python\Lib\site-packages; .venv\Scripts\python.exe → .venv\Lib\site-packages. */
function sitePackages(python) {
  const dir = path.dirname(python);
  return [path.join(dir, "Lib", "site-packages"), path.join(dir, "..", "Lib", "site-packages")].find((p) => fs.existsSync(p)) || null;
}

/** App, engine package and sealed Firefox versions, from files alone: no Python spawn at boot. */
function readVersions() {
  const versions = {};
  try {
    versions.app = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  } catch {
    // no package.json: an odd install, the panel shows a dash
  }
  const python = findPythonExe();
  const site = python && sitePackages(python);
  if (!site) return versions;
  const info = fs.readdirSync(site).find((f) => /^invisible_playwright-.+\.dist-info$/.test(f));
  if (info) versions.engine = info.slice("invisible_playwright-".length, -".dist-info".length);
  try {
    versions.firefox = JSON.parse(fs.readFileSync(path.join(site, "invisible_core", "seal.json"), "utf8")).upstream_version;
  } catch {
    // engine package without a seal: nothing to show
  }
  return versions;
}

const VERSIONS = readVersions();

let cached = null; // { at, value }
let inflight = null;
let fetching = null; // the running fetch ChildProcess

function probe() {
  const python = findPythonExe();
  if (!python) {
    return Promise.resolve({
      python: null,
      ready: false,
      detail: `Python runtime missing — expected ${RUNTIME_PYTHON} (reinstall SessionManagerPro)`,
      cacheDir: null,
      versions: VERSIONS,
    });
  }
  return new Promise((resolve) => {
    // -E -s: only the runtime's own site-packages, exactly as the worker runs.
    execFile(python, ["-E", "-s", "-c", STATUS_PY], { env: workerEnv(), timeout: 15_000, windowsHide: true }, (err, stdout, stderr) => {
      const base = { python, ready: false, cacheDir: null, versions: VERSIONS };
      if (err) {
        const why = err.killed ? "engine status check timed out (15 s)" : String(stderr || err.message).trim().split(/\r?\n/).pop();
        return resolve({ ...base, detail: why.slice(0, 300) });
      }
      try {
        const j = JSON.parse(String(stdout).trim().split(/\r?\n/).pop());
        resolve({ ...base, ready: j.ready, detail: j.detail, cacheDir: j.cacheDir });
      } catch {
        resolve({ ...base, detail: "engine status unreadable" });
      }
    });
  });
}

/** The engine's state, cached for a minute: the check spawns Python and reads the whole tree. */
function status() {
  if (cached && Date.now() - cached.at < STATUS_TTL_MS) return Promise.resolve(cached.value);
  if (!inflight) {
    inflight = probe()
      .then((value) => {
        cached = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function register(app, deps) {
  // GET /api/app carries the versions for the status bar. Read-only: never stored, so a copy
  // in app.json can't outlive an upgrade and shadow the fresh value.
  deps.appSettings.register(
    "versions",
    VERSIONS,
    () => {
      throw new Error("versions is read-only");
    },
    { readOnly: true }
  );

  app.get("/api/engine", async (req, res) => {
    res.json({ ...(await status()), fetching: Boolean(fetching) });
  });

  app.post("/api/engine/fetch", (req, res) => {
    if (fetching) return res.status(409).json({ error: "the engine download is already running" });
    const python = findPythonExe();
    if (!python) return res.status(500).json({ error: `Python runtime missing — expected ${RUNTIME_PYTHON} (reinstall SessionManagerPro)` });

    // -u so progress lines arrive as they are printed, not when the pipe buffer fills.
    const proc = spawn(python, ["-u", "-E", "-s", "-m", "invisible_playwright", "fetch"], {
      cwd: ROOT,
      env: workerEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    fetching = proc;
    cached = null;
    deps.log("info", "BROWSER", "Browser engine download started");
    const emit = (state, line) => deps.broadcast("engine", { state, line });

    let last = "";
    // Progress bars redraw with \r, so a bare carriage return ends a line too.
    const stream = (s) => {
      let buf = "";
      s.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const parts = buf.split(/\r\n|\r|\n/);
        buf = parts.pop();
        for (const p of parts) {
          const line = p.trim();
          if (!line) continue;
          last = line;
          emit("running", line);
        }
      });
      s.on("end", () => {
        if (buf.trim()) emit("running", (last = buf.trim()));
      });
    };
    stream(proc.stdout);
    stream(proc.stderr);

    proc.on("error", (err) => (last = err.message));
    proc.on("close", async (code) => {
      fetching = null;
      cached = null;
      const s = await status();
      if (code === 0 && s.ready) {
        deps.log("success", "BROWSER", `Browser engine ready: ${s.detail}`);
        emit("done", s.detail);
      } else {
        const why = code === 0 ? s.detail : last || `exit code ${code}`;
        deps.log("error", "BROWSER", `Browser engine download failed: ${why}`);
        emit("error", why);
      }
    });

    res.json({ ok: true });
  });
}

module.exports = register;
module.exports.status = status;
module.exports.versions = VERSIONS;
