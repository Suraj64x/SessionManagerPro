// Warm-up, schedules and re-run failed, end to end: the built-in script, the warmupSets
// setting, a real HEADLESS proxy-less warm-up of two local pages launched by the run itself
// (traffic saver, stop when done), a scheduled warm-up fired by the 30 s tick, schedule CRUD
// and re-run failed. Starts the server in-process on 3016 and touches only qa-automation-*
// data, which it removes at the end (schedules.json and warmupSets are restored).
//
//   node backend/test/automation_check.js
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
process.chdir(ROOT);
process.argv.push("--no-open", "--no-terminal");
const PORT = 3016;
process.env.PORT = String(PORT);

const DATA = path.join(ROOT, "data");
const SCHED = path.join(DATA, "schedules.json");
const schedBefore = fs.existsSync(SCHED) ? fs.readFileSync(SCHED, "utf8") : null;

const { server } = require(path.join(ROOT, "backend/src/server.js"));
const manager = require(path.join(ROOT, "backend/src/manager.js"));
const orchestrator = require(path.join(ROOT, "backend/src/orchestrator.js"));
const scripts = require(path.join(ROOT, "backend/src/scripts.js"));
const { nextRunOf } = require(path.join(ROOT, "backend/src/features/automation.js"));

const A = "qa-automation-a";
const B = "qa-automation-b";
// Local pages served by the app's own screenshots route: no external site in the test.
const PAGES = path.join(scripts.SHOTS, A);
const BASE = `http://127.0.0.1:${PORT}/api/screenshots/${A}`;
const page = (name, other) =>
  `<!doctype html><title>qa ${name}</title><script>document.cookie = "qa_${name}=1; max-age=3600; path=/"</script>` +
  `<a href="${other}.html">next</a><div style="height:3000px"></div>`;

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  return null;
};

async function call(method, p, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method,
    headers: { Host: `127.0.0.1:${PORT}`, "X-SMP": "1", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { code: res.status, json, text };
}
const enc = encodeURIComponent;
const runOf = async (id) => (await call("GET", "/api/scripts/runs")).json.find((r) => r.id === id);
const finished = (run) => run && Object.values(run.results).every((r) => !["pending", "running"].includes(r.state));
let setsBefore;
let qaScript;

async function main() {
  // --- the built-in script
  const list = (await call("GET", "/api/scripts")).json;
  const wu = list.find((s) => s.id === "warmup");
  check("GET /api/scripts lists the built-in Warm-up", wu?.builtin === true && wu.mode === "automation" && /page\.cookies\(\)/.test(wu.code));
  check("PATCH the built-in → 400", (await call("PATCH", "/api/scripts/warmup", { name: "x" })).code === 400);
  check("DELETE the built-in → 400", (await call("DELETE", "/api/scripts/warmup")).code === 400);

  // --- warmupSets
  setsBefore = (await call("GET", "/api/app")).json.warmupSets;
  check("warmupSets registered with a General set", Array.isArray(setsBefore) && setsBefore.length >= 1, JSON.stringify(setsBefore).slice(0, 80));
  check("warmupSets refuses ftp://", (await call("PATCH", "/api/app", { warmupSets: [{ name: "qa-automation-set", urls: ["ftp://x.org"] }] })).code === 400);
  check("warmupSets refuses 51 urls", (await call("PATCH", "/api/app", { warmupSets: [{ name: "qa-automation-set", urls: Array.from({ length: 51 }, (_, i) => `https://s${i}.org`) }] })).code === 400);
  const ok = await call("PATCH", "/api/app", { warmupSets: [...setsBefore, { name: "qa-automation-set", urls: ["example.org"] }] });
  check("warmupSets accepts a set and adds https://", ok.code === 200 && ok.json.warmupSets.at(-1).urls[0] === "https://example.org/", ok.text.slice(0, 160));
  await call("PATCH", "/api/app", { warmupSets: setsBefore });

  // --- profiles: a fake proxy keeps the pool's real ones free; dropped before launch.
  for (const [id, port] of [[A, 9], [B, 10]]) {
    const made = await call("POST", "/api/sessions/create", { name: id, proxy: `http://10.255.255.1:${port}` });
    check(`create ${id}`, made.code === 200, made.text.slice(0, 120));
    await manager.saveSessionPatch(id, { proxy: null });
  }
  fs.mkdirSync(PAGES, { recursive: true });
  fs.writeFileSync(path.join(PAGES, "a.html"), page("a", "b"));
  fs.writeFileSync(path.join(PAGES, "b.html"), page("b", "a"));

  // --- POST /api/warmup validation
  check("warm-up refuses a data: url", (await call("POST", "/api/warmup", { ids: [A], urls: ["data:text/html,x"] })).code === 400);
  check("warm-up refuses an unknown profile", (await call("POST", "/api/warmup", { ids: ["qa-automation-nope"], urls: [`${BASE}/a.html`] })).code === 400);
  check("warm-up refuses dwell min > max", (await call("POST", "/api/warmup", { ids: [A], urls: [`${BASE}/a.html`], dwell: [9, 3] })).code === 400);

  // --- the real warm-up
  const t0 = Date.now();
  const started = await call("POST", "/api/warmup", {
    ids: [A],
    urls: [`${BASE}/a.html`, `${BASE}/b.html`],
    dwell: [1, 2],
    scroll: true,
    links: 1,
    shuffle: false,
    hidden: true,
    saveTraffic: true,
    stopAfter: true,
  });
  const o = started.json?.options || {};
  check("POST /api/warmup → a run", started.code === 200 && started.json.scriptId === "warmup", started.text.slice(0, 160));
  check("run options: launch, headless, stopAfter, saver prefs, limit", o.launch && o.headless && o.stopAfter && o.prefs?.["permissions.default.image"] === 2 && o.prefs?.["media.autoplay.default"] === 5 && o.limitMs > 120_000, JSON.stringify(o));
  check("run options carry the input", o.input?.sites?.length === 2 && o.input.links === 1, JSON.stringify(o.input));
  const done = await until(async () => {
    const r = await runOf(started.json.id);
    return finished(r) && r;
  }, 150_000);
  const res = done?.results?.[A];
  let value = {};
  try {
    value = JSON.parse(res?.value || "{}");
  } catch {
    // shown below
  }
  check("warm-up finished ok", res?.state === "ok", `${JSON.stringify(res).slice(0, 300)} ${Date.now() - t0} ms`);
  check("result { sites: 2, cookiesBefore, cookiesAfter } with new cookies", value.sites === 2 && value.cookiesAfter >= value.cookiesBefore + 2, res?.value);
  check("one log line per site", (res?.logs || []).filter((l) => l.startsWith(BASE)).length === 2, JSON.stringify(res?.logs));
  check("stop when done closed the profile", await until(() => !orchestrator.live.has(A), 15_000));

  // --- re-run failed
  const failed = scripts.startRun({ name: "qa-automation fail", mode: "page", code: "return 1" }, [B], { orchestrator, getSession: manager.getSession });
  check("a run on a stopped profile fails it", failed.results[B].state === "error", JSON.stringify(failed.results));
  const re = await call("POST", `/api/scripts/runs/${failed.id}/rerun-failed`);
  check("rerun-failed → a new run on the failed profiles", re.code === 200 && re.json.id !== failed.id && Object.keys(re.json.results).join() === B && re.json.scriptName === "qa-automation fail", re.text.slice(0, 160));
  check("rerun-failed with nothing failed → 409", (await call("POST", `/api/scripts/runs/${started.json.id}/rerun-failed`)).code === 409);
  check("rerun-failed unknown run → 404", (await call("POST", "/api/scripts/runs/nope/rerun-failed")).code === 404);

  // --- schedule CRUD
  const qs = (await call("POST", "/api/scripts", { name: "qa-automation-script", mode: "page", code: "return 1" })).json;
  qaScript = qs?.id;
  const base = { name: "qa-automation-s1", script: { scriptId: qs?.id }, targets: { kind: "ids", value: [B] }, rule: { kind: "every", minutes: 60 }, options: { launch: false } };
  check("schedule: bad time → 400", (await call("POST", "/api/schedules", { ...base, rule: { kind: "daily", time: "25:00" } })).code === 400);
  check("schedule: past once → 400", (await call("POST", "/api/schedules", { ...base, rule: { kind: "once", at: "2020-01-01T00:00:00Z" } })).code === 400);
  check("schedule: unknown script → 400", (await call("POST", "/api/schedules", { ...base, script: { scriptId: "nope" } })).code === 400);
  check("schedule: bad targets → 400", (await call("POST", "/api/schedules", { ...base, targets: { kind: "ids", value: [] } })).code === 400);
  const s1 = (await call("POST", "/api/schedules", base)).json;
  const inAnHour = Date.parse(s1?.nextRun) - Date.now();
  check("POST /api/schedules → enabled, nextRun in 60 min, lastRun null", s1?.enabled === true && inAnHour > 59 * 60_000 && inAnHour <= 60 * 60_000 && s1.lastRun === null, JSON.stringify(s1));
  check("GET /api/schedules lists it", (await call("GET", "/api/schedules")).json.some((s) => s.id === s1.id));
  const off = (await call("PATCH", `/api/schedules/${s1.id}`, { enabled: false })).json;
  check("PATCH enabled:false clears nextRun", off?.enabled === false && off.nextRun === null && off.name === base.name, JSON.stringify(off));
  const now = await call("POST", `/api/schedules/${s1.id}/run`);
  check("Run now with no running targets → 409 skipped", now.code === 409 && /Skipped/.test(now.json?.error), now.text);
  check("DELETE schedule", (await call("DELETE", `/api/schedules/${s1.id}`)).code === 200);
  check("DELETE again → 404", (await call("DELETE", `/api/schedules/${s1.id}`)).code === 404);

  // --- a scheduled warm-up fired by the tick
  const s2 = (
    await call("POST", "/api/schedules", {
      name: "qa-automation-s2",
      script: { builtin: "warmup", input: { sites: [`${BASE}/b.html`], dwell: [1, 1], links: 0, shuffle: false } },
      targets: { kind: "ids", value: [A] },
      rule: { kind: "once", at: new Date(Date.now() + 2000).toISOString() },
      options: { hidden: true, stopAfter: true },
    })
  ).json;
  check("scheduled warm-up saved with launch forced on", s2?.script?.builtin === "warmup" && s2.options.launch === true && s2.options.hidden === true, JSON.stringify(s2));
  const fired = await until(async () => (await call("GET", "/api/schedules")).json.find((s) => s.id === s2.id && s.lastRun?.runId), 45_000);
  check("the tick fired it; once → no nextRun", fired && fired.nextRun === null, JSON.stringify(fired));
  if (fired) {
    const run = await until(async () => {
      const r = await runOf(fired.lastRun.runId);
      return finished(r) && r;
    }, 120_000);
    check("the scheduled run is tagged and ok", run?.scheduleId === s2.id && run.results[A]?.state === "ok", JSON.stringify(run?.results).slice(0, 300));
    const last = await until(async () => (await call("GET", "/api/schedules")).json.find((s) => s.id === s2.id && s.lastRun?.done), 5000);
    check("lastRun counts follow the run", last?.lastRun.ok === 1 && last.lastRun.failed === 0, JSON.stringify(last?.lastRun));
    check("…and it stopped the profile", await until(() => !orchestrator.live.has(A), 15_000));
  }
  await call("DELETE", `/api/schedules/${s2.id}`);

  // --- nextRunOf
  const at = new Date(2026, 0, 5, 10, 0); // Monday 10:00 local
  check("daily later today", nextRunOf({ kind: "daily", time: "12:30" }, at) === new Date(2026, 0, 5, 12, 30).toISOString());
  check("daily passed → tomorrow", nextRunOf({ kind: "daily", time: "09:00" }, at) === new Date(2026, 0, 6, 9, 0).toISOString());
  check("weekly Sunday", nextRunOf({ kind: "weekly", days: [0], time: "08:00" }, at) === new Date(2026, 0, 11, 8, 0).toISOString());
  check("weekly same weekday, time passed → next week", nextRunOf({ kind: "weekly", days: [1], time: "09:00" }, at) === new Date(2026, 0, 12, 9, 0).toISOString());
}

server.listen(PORT, "127.0.0.1", async () => {
  try {
    await main();
  } catch (e) {
    check("UNCAUGHT", false, e.stack);
  } finally {
    try {
      for (const r of scripts.recentRuns()) scripts.stopRun(r.id);
      if (orchestrator.live.has(A)) await orchestrator.stop(A);
      await until(() => !orchestrator.live.has(A), 10_000);
      for (const id of [A, B]) {
        // Firefox can hold the profile folder for a moment after the stop: retry the trash.
        await until(async () => !manager.getSession(id) || (await call("DELETE", `/api/sessions/${enc(id)}`)).code === 200, 20_000);
        await until(async () => (await call("DELETE", `/api/trash/${enc(id)}`)).code !== 409, 10_000);
        for (const f of [`${id}.json`, `${id}.import.json`]) fs.rmSync(path.join(DATA, "cookies", f), { force: true });
      }
      if (qaScript) await call("DELETE", `/api/scripts/${qaScript}`);
      if (setsBefore) await call("PATCH", "/api/app", { warmupSets: setsBefore });
    } catch (e) {
      console.error("cleanup:", e.message);
    }
    fs.rmSync(PAGES, { recursive: true, force: true });
    // A trash attempt that hit a locked folder leaves its empty target behind.
    const TRASH = path.join(DATA, "trash");
    for (const d of fs.existsSync(TRASH) ? fs.readdirSync(TRASH) : []) {
      if (d.startsWith("qa-automation-")) fs.rmSync(path.join(TRASH, d), { recursive: true, force: true });
    }
    if (schedBefore === null) fs.rmSync(SCHED, { force: true });
    else fs.writeFileSync(SCHED, schedBefore);
    const left = [...manager.listSessions(), ...manager.listTrash()].some((x) => x.id.startsWith("qa-automation"));
    check("cleanup: qa profiles purged", !left);
    server.close();
    for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail && (!r.ok || /ms$/.test(r.detail)) ? "  — " + r.detail : ""}`);
    console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }
});
