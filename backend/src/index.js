#!/usr/bin/env node
const fs = require("fs");
const {
  createSessionRecord,
  getSession,
  parseProxy,
  generateFingerprint,
  listSessions,
  trashSession,
  purgeTrash,
  listAllFingerprints,
  PROXY_FILE,
} = require("./manager");

const QA_ID = "qa-selfcheck@example.com";

/** First proxy line in resources/proxies, or null on a fresh install with none yet. */
function firstProxyLine() {
  try {
    return fs.readFileSync(PROXY_FILE, "utf8").split(/\r?\n/).find((l) => l.trim()) || null;
  } catch {
    return null;
  }
}

async function checkProfiles() {
  const line = firstProxyLine();
  if (!line) return "skipped (no proxies in resources/proxies)";
  if (!listAllFingerprints().length) return "skipped (no fingerprints in resources/fpts)";

  const p = parseProxy(line);
  if (!p.host || !p.port) throw new Error("proxy parse failed");

  const a = await generateFingerprint(p);
  if (!a.userAgent || !a.viewport.width || !a.webgl.vendor || !a.timezone || !a.file) {
    throw new Error("fingerprint incomplete");
  }

  const rec = await createSessionRecord(QA_ID, { email: QA_ID });
  try {
    const again = getSession(QA_ID);
    if (again.id !== QA_ID) throw new Error("email not used as session id");
    if (!again.userDataDir.endsWith(QA_ID)) throw new Error("email not used as profile folder");
    if (again.proxy?.host !== rec.proxy?.host) throw new Error("proxy not sticky");
    if (again.fingerprint.userAgent !== rec.fingerprint.userAgent) throw new Error("fingerprint not sticky");
    if (!again.fingerprintFile || again.fingerprintFile !== rec.fingerprintFile) {
      throw new Error("fingerprint file not sticky");
    }
  } finally {
    // Through the store's lock: a running panel may be writing it at the same time.
    await trashSession(QA_ID);
    await purgeTrash({ id: QA_ID });
  }

  // The sheet is not rewritten here: updates/sessions.csv may hold edits not yet synced back.
  const { parseCsvAccounts } = require("./manager");
  const accounts = parseCsvAccounts();
  if (accounts.length && !String(accounts[0]).includes("@")) throw new Error("account file parse failed");
  if (listSessions().some((s) => s.id === QA_ID)) throw new Error("qa profile left behind");
  return "ok";
}

async function selfcheck() {
  console.log(`profiles: ${await checkProfiles()}`);

  // The worker's Python: the bundled runtime, or a developer .venv.
  const { findPythonExe, workerEnv } = require("./worker_runner");
  const { execFileSync } = require("child_process");
  const pyExe = findPythonExe();
  if (!pyExe) throw new Error("Python runtime not found: expected runtime\\python\\python.exe or .venv (reinstall SessionManagerPro)");
  const run = (args) => execFileSync(pyExe, ["-E", "-s", ...args], { encoding: "utf8", env: workerEnv(), windowsHide: true }).trim();
  const pyVer = run(["--version"]);
  if (!pyVer.includes("3.11")) throw new Error(`Expected Python 3.11.x runtime, but found: ${pyVer}`);
  run(["-c", "from invisible_playwright import InvisiblePlaywright"]);
  console.log(`python: ${pyVer} (${pyExe}), invisible_playwright imports`);

  // Status only: this never downloads the engine.
  const engine = await require("./features/engine").status();
  console.log(engine.ready ? `engine: ready, ${engine.detail}` : `engine: not downloaded (${engine.detail}); use Settings > Browser engine > Download`);
  console.log("selfcheck ok");
}

async function main() {
  if (process.argv[2] === "selfcheck") return selfcheck();
  const { run } = require("./cli");
  await run();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
