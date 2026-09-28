// Home overview: the shape and counts of GET /api/home, with one qa profile, one failed run
// and one warning to count. Starts the server in-process on 3010 and touches only
// qa-home-* records, which it trashes and purges at the end. No browser is launched.
//
//   node backend/test/home_check.js
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
process.chdir(ROOT);
process.argv.push("--no-open", "--no-terminal");
const PORT = 3010;
process.env.PORT = String(PORT);

const { server } = require(path.join(ROOT, "backend/src/server.js"));
const manager = require(path.join(ROOT, "backend/src/manager.js"));
const orchestrator = require(path.join(ROOT, "backend/src/orchestrator.js"));
const scripts = require(path.join(ROOT, "backend/src/scripts.js"));

const ID = "qa-home-1";
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(p) {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    headers: { Host: `127.0.0.1:${PORT}`, "X-SMP": "1", "Content-Type": "application/json" },
  });
  return { code: res.status, json: await res.json().catch(() => null) };
}

async function main() {
  const first = await get("/api/home");
  const b = first.json || {};
  check(
    "GET /api/home → 200 with the five sections",
    first.code === 200 && ["profiles", "proxies", "fingerprints", "recentRuns", "problems"].every((k) => k in b),
    `HTTP ${first.code} ${JSON.stringify(b).slice(0, 100)}`
  );
  check("profiles.total matches the store", b.profiles.total === manager.listSessions().length, `${b.profiles.total}`);
  check("profiles.trash matches the trash", b.profiles.trash === manager.listTrash().length, `${b.profiles.trash}`);
  const pool = orchestrator.getStatus();
  check("live/queued match the pool", b.profiles.live === pool.activeCount && b.profiles.queued === pool.queuedCount);

  const proxies = manager.listAllProxies();
  check(
    "proxies total/assigned from listAllProxies",
    b.proxies.total === proxies.length && b.proxies.assigned === proxies.filter((p) => p.isAssigned).length,
    JSON.stringify(b.proxies)
  );
  // Health comes from each proxy's check in data/proxies.json (absent file: all unchecked).
  const ok = proxies.filter((p) => p.check?.ok).length;
  const failed = proxies.filter((p) => p.check && !p.check.ok).length;
  check(
    "proxy health: ok/failed/unchecked from each proxy's check",
    b.proxies.ok === ok && b.proxies.failed === failed && b.proxies.unchecked === proxies.length - ok - failed,
    JSON.stringify(b.proxies)
  );
  const stats = manager.getSystemStats();
  check(
    "fingerprints total/free",
    b.fingerprints.total === stats.fingerprintsTotal && b.fingerprints.free === stats.fingerprintsFree,
    JSON.stringify(b.fingerprints)
  );
  check(
    "problems: warn/error only, at most 10, chronological",
    Array.isArray(b.problems) &&
      b.problems.length <= 10 &&
      b.problems.every((l) => l.level === "warn" || l.level === "error") &&
      b.problems.every((l, i) => !i || l.id > b.problems[i - 1].id),
    `${b.problems.length} entries`
  );
  check("recentRuns is a list of at most 8", Array.isArray(b.recentRuns) && b.recentRuns.length <= 8);

  // A qa profile with a fake proxy and a stub fingerprint: no geo lookup and no real proxy
  // taken from the pool. It does reserve one free fingerprint file, freed again at purge.
  await manager.createSessionRecord(ID, {
    proxy: { scheme: "http", host: "10.255.255.1", port: 9, username: "", password: "" },
    fingerprint: { qa: true },
  });
  await manager.saveSessionPatch(ID, { lastResult: { status: "error", reason: "qa-home: pretend launch failure", at: new Date().toISOString() } });
  orchestrator.log("warn", "SESSION", "qa-home: a warning to count", ID);
  orchestrator.log("info", "SESSION", "qa-home: an info line that must not count", ID);
  // A run on a profile that is not live fails at once: the tally is exercised without a browser.
  const run = scripts.startRun({ name: "qa-home run", mode: "page", code: "return 1" }, [ID], { orchestrator, getSession: manager.getSession });
  await sleep(200);

  const after = (await get("/api/home")).json;
  check("a new profile raises profiles.total by one", after.profiles.total === b.profiles.total + 1, `${b.profiles.total} → ${after.profiles.total}`);
  check("an idle profile with lastResult.error counts as an error", after.profiles.errors === b.profiles.errors + 1, `${b.profiles.errors} → ${after.profiles.errors}`);
  check("fingerprints.free dropped by one", after.fingerprints.free === b.fingerprints.free - 1, `${b.fingerprints.free} → ${after.fingerprints.free}`);
  const last = after.problems[after.problems.length - 1];
  check(
    "the warning is the newest problem and the info line is absent",
    last?.message === "qa-home: a warning to count" && last.sessionId === ID && !after.problems.some((l) => l.level === "info"),
    JSON.stringify(last)
  );
  const r = after.recentRuns[0];
  check(
    "the run is first in recentRuns: targets=1, error=1, ok=0, pending=0, ms=null (no timing)",
    r && r.id === run.id && r.scriptName === "qa-home run" && r.targets === 1 && r.error === 1 && r.ok === 0 && r.pending === 0 && r.stopped === 0 && r.ms === null,
    JSON.stringify(r)
  );
  const t0 = Date.now();
  await get("/api/home");
  check("the summary is cheap (no network: < 300 ms)", Date.now() - t0 < 300, `${Date.now() - t0} ms`);
}

server.listen(PORT, "127.0.0.1", async () => {
  try {
    await main();
  } catch (e) {
    check("UNCAUGHT", false, e.stack);
  } finally {
    try {
      await manager.trashSession(ID);
    } catch {}
    try {
      await manager.purgeTrash({ id: ID });
    } catch {}
    const left = [...manager.listSessions(), ...manager.listTrash()].some((x) => x.id === ID);
    check("cleanup: qa-home-1 trashed and purged", !left);
    server.close();
    for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail && (!r.ok || /ms$/.test(r.detail)) ? "  — " + r.detail : ""}`);
    console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }
});
