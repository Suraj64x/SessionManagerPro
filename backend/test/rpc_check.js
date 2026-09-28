// Drives the real Python/Firefox worker through the RPC, headless, in a scratch profile with
// no proxy; then the real orchestrator against an in-memory session store; then ONE short
// headful window for the `window` op. Nothing under data/ is touched except the workers'
// shutdown cookie dumps, which are removed at the end.
//
//   node backend/test/rpc_check.js
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
process.chdir(ROOT);
const { launchWorker, findPythonExe, workerEnv } = require(path.join(ROOT, "backend/src/worker_runner.js"));
const scripts = require(path.join(ROOT, "backend/src/scripts.js"));

// The orchestrator captures manager's functions at require time, so an in-memory store
// swapped in first keeps it off data/sessions.json entirely.
const manager = require(path.join(ROOT, "backend/src/manager.js"));
const records = {};
const seenOpts = {};
Object.assign(manager, {
  getSession: (id) => records[id] || null,
  ensureSessions: async () => ({ created: [], existing: [], skipped: [] }),
  saveSessionPatch: async (id, patch) => {
    if (!records[id]) throw new Error(`unknown session: ${id}`);
    return Object.assign(records[id], patch);
  },
  openSession: async (id, opts) => {
    seenOpts[id] = opts;
    if (!records[id]) throw new Error("unknown session");
    return launchWorker(records[id], opts);
  },
});
const orchestrator = require(path.join(ROOT, "backend/src/orchestrator.js"));

const SCRATCH = path.join(os.tmpdir(), "smp-rpc-check");
const IDS = ["rpc-check", "rpc-orch", "rpc-win"];
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const onceEvent = (emitter, event, ms) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`no ${event} within ${ms} ms`)), ms);
    emitter.once(event, (e) => (clearTimeout(t), res(e)));
  });

const PAGE = "data:text/html," + encodeURIComponent(
  "<title>RPC test</title><input id=q><button id=b onclick=\"document.title='clicked'\">go</button><div style='height:3000px'></div>"
);
// Notification is WebIDL-gated on this pref, so its absence proves the pref reached Firefox.
// (permissions.default.image=2 was tried first: it does not apply to data: images.)
const PREFS = { "dom.webnotifications.enabled": false };

(async () => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  orchestrator.updatesDir = SCRATCH;
  orchestrator.logFilePath = path.join(SCRATCH, "status.log");

  check("findPythonExe: no system Python, only runtime/ or .venv", /[\\/](runtime[\\/]python|\.venv[\\/]Scripts)[\\/]python\.exe$/.test(findPythonExe() || ""), findPythonExe());
  const env = workerEnv();
  check("worker env hygiene", !("PYTHONPATH" in env) && !("PYTHONHOME" in env) && env.PYTHONNOUSERSITE === "1" && env.INVISIBLE_CORE_AUTOFIX === "off");

  // An auto-run script restricted to data: URLs, exactly as a launch would inject it.
  const initFile = path.join(SCRATCH, "init.json");
  fs.writeFileSync(initFile, JSON.stringify([scripts.wrapInit({ name: "t", match: "data:*", code: "window.__smpAutoRan = (window.__smpAutoRan || 0) + 1;" })]));

  const record = { id: "rpc-check", userDataDir: path.join(SCRATCH, "profile"), tabs: [], seed: 4242 };
  let handle;
  let win;
  const t0 = Date.now();
  try {
    handle = await launchWorker(record, { headless: true, url: PAGE, initScriptsFile: initFile, prefs: PREFS });
    check("worker launched and reported ready", true, `${Date.now() - t0} ms`);

    check("auto-run note buffered for the launcher", handle.launchNotes?.some((n) => n.event === "init_scripts" && n.count === 1), JSON.stringify(handle.launchNotes));
    const info = await handle.rpc("info");
    check("info returns url + title", info.title === "RPC test", JSON.stringify(info).slice(0, 80));
    check("auto-run script ran exactly once on the page", (await handle.rpc("eval", { code: "window.__smpAutoRan" })) === 1);

    // Page mode: the wrapper the run endpoint uses, with await + return.
    const v = await handle.rpc("eval", { code: "async () => {\nawait new Promise(r => setTimeout(r, 50));\nreturn { t: document.title, n: 6 * 7 };\n}" });
    check("page-mode body with await/return", v?.n === 42 && v?.t === "RPC test", JSON.stringify(v));

    await handle.rpc("fill", { selector: "#q", value: "hello" });
    check("fill", (await handle.rpc("eval", { code: "document.querySelector('#q').value" })) === "hello");
    await handle.rpc("type", { selector: "#q", text: " world", delay: 5 });
    check("type (press_sequentially)", (await handle.rpc("eval", { code: "document.querySelector('#q').value" })) === "hello world");
    await handle.rpc("click", { selector: "#b" });
    check("click", (await handle.rpc("info")).title === "clicked");
    await handle.rpc("scroll", { dy: 800 });
    await sleep(300);
    check("scroll", (await handle.rpc("eval", { code: "window.scrollY" })) > 0);

    const shot = path.join(SCRATCH, "shot.png");
    await handle.rpc("screenshot", { path: shot });
    check("screenshot written", fs.existsSync(shot) && fs.statSync(shot).size > 1000);

    let err = null;
    try { await handle.rpc("wait_for", { selector: "#nope", timeout: 800 }); } catch (e) { err = e.message; }
    check("a failing op rejects with a readable error", err && /#nope/.test(err) && /matches nothing|timeout/i.test(err), err);

    err = null;
    try { await handle.rpc("eval", { code: "async () => { throw new Error('boom from page'); }" }); } catch (e) { err = e.message; }
    check("page exceptions come back as errors", err && /boom from page/.test(err), err);

    // Slow op must not block a parallel one: RPCs run as tasks in the worker.
    const slow = handle.rpc("eval", { code: "new Promise(r => setTimeout(() => r('slow'), 1500))" });
    const t1 = Date.now();
    await handle.rpc("info");
    check("RPCs run concurrently (fast op not blocked by slow)", Date.now() - t1 < 1000, `${Date.now() - t1} ms`);
    check("slow op still resolves", (await slow) === "slow");

    const count = await handle.rpc("add_cookies", { cookies: [{ name: "smp", value: "1", domain: ".example.com", path: "/", sameSite: "Lax" }] });
    const jar = await handle.rpc("cookies");
    check("add_cookies into live context", jar.some((c) => c.name === "smp") && typeof count === "number");

    // Automation mode through the real Node wrapper.
    const deps = { orchestrator: { live: new Map([["rpc-check", { handle }]]), log: () => {} }, getSession: () => ({ id: "rpc-check", email: "x", tags: [] }) };
    const snap = scripts.startRun(
      { name: "auto", mode: "automation", code: "await page.fill('#q', profile.id); log('filled'); await sleep(20); return (await page.evaluate(() => document.querySelector('#q').value)) + ':' + random(5,5);" },
      ["rpc-check"], deps
    );
    await sleep(2500);
    const done = scripts.recentRuns().find((r) => r.id === snap.id).results["rpc-check"];
    check("automation script runs via page proxy", done.state === "ok" && done.value === "rpc-check:5", JSON.stringify(done).slice(0, 160));
    check("log() lines captured", done.logs?.includes("filled"));

    // Stop: a long script is cancelled at its next awaited call.
    const long = scripts.startRun({ name: "long", mode: "automation", code: "for(;;){ await sleep(100); }" }, ["rpc-check"], deps);
    await sleep(300);
    scripts.stopRun(long.id);
    await sleep(400);
    check("stop cancels a running script", scripts.recentRuns().find((r) => r.id === long.id).results["rpc-check"].state === "stopped");

    // --- round-2: runner hardening
    const settle = async (id, ms) => {
      const end = Date.now() + ms;
      for (;;) {
        const r = scripts.recentRuns().find((x) => x.id === id).results["rpc-check"];
        if (!["pending", "running"].includes(r.state) || Date.now() > end) return r;
        await sleep(100);
      }
    };
    let logCalls = 0;
    const counting = { ...deps, orchestrator: { ...deps.orchestrator, log: () => logCalls++ } };
    const flood = scripts.startRun({ name: "flood", mode: "automation", code: "for (let i = 0; i < 100000; i++) log(i); return 'ok';" }, ["rpc-check"], counting);
    const fr = await settle(flood.id, 10000);
    check("log() flood is batched: last 50 lines kept, server not flooded", fr.state === "ok" && fr.logs.length === 50 && fr.logs[49] === "99999" && logCalls < 200, `state=${fr.state} logs=${fr.logs?.length} calls=${logCalls}`);

    const errRun = scripts.startRun({ name: "errlog", mode: "automation", code: "log(new Error('bad thing')); return 1;" }, ["rpc-check"], deps);
    const er = await settle(errRun.id, 5000);
    check("log(new Error()) shows message and stack, not {}", /Error: bad thing/.test(er.logs?.[0]) && /\bat\b/.test(er.logs?.[0]), er.logs?.[0]?.slice(0, 60));

    const circ = scripts.startRun({ name: "circ", mode: "automation", code: "const a = {}; a.self = a; await page.evaluate((x) => 1, a);" }, ["rpc-check"], deps);
    const t2 = Date.now();
    const cr = await settle(circ.id, 10000);
    check("unsendable (circular) argument fails at once, not after a timeout", cr.state === "error" && /can't be sent/.test(cr.error) && Date.now() - t2 < 3000, `${cr.error} in ${Date.now() - t2} ms`);

    await handle.rpc("eval", { code: "setTimeout(() => { const d = document.createElement('div'); d.id = 'late'; d.textContent = 'late'; document.body.prepend(d); }, 6500), 1" });
    const zero = scripts.startRun({ name: "zero", mode: "automation", code: "await page.waitFor('#late', { timeout: 0 }); return 'found';" }, ["rpc-check"], deps);
    const zr = await settle(zero.id, 15000);
    check("timeout: 0 waits past the old 5 s RPC deadline", zr.state === "ok" && zr.value === "found", JSON.stringify(zr).slice(0, 120));

    // --- round-3: engine plumbing
    check("worker spawned with -E -s", handle.process.spawnargs[1] === "-E" && handle.process.spawnargs[2] === "-s", handle.process.spawnargs.slice(0, 4).join(" "));
    const info3 = await handle.rpc("info");
    check("info reports headless (+ exitIp/country when the engine resolved them)", info3.headless === true && (info3.exitIp === undefined || /^[\d.:a-f]+$/i.test(info3.exitIp)), `exitIp=${info3.exitIp ? "known" : "absent"} country=${info3.country || "absent"} (ready in ${Date.now() - t0} ms)`);
    check("ready event carried headless/exitIp onto the handle", handle.headless === true && handle.exitIp === info3.exitIp);

    check("--prefs reach Firefox (dom.webnotifications.enabled=false hides Notification)", (await handle.rpc("eval", { code: "typeof Notification" })) === "undefined");

    await handle.rpc("eval", { code: "(() => { const q = document.querySelector('#q'); q.focus(); q.select(); })()" });
    check("keyboard_type into the focused element", (await handle.rpc("keyboard_type", { text: "xyz", delay: 5 })) === true && (await handle.rpc("eval", { code: "document.querySelector('#q').value" })) === "xyz");

    await handle.rpc("eval", { code: "window.__gone = 1, 1" });
    const reloaded = await handle.rpc("reload");
    check("reload returns the url and gives a fresh document", reloaded === PAGE && (await handle.rpc("eval", { code: "window.__gone === undefined" })) === true, String(reloaded).slice(0, 40));

    const first = (await handle.rpc("info")).pageId;
    const tabA = await handle.rpc("new_tab", { url: PAGE });
    const tabB = await handle.rpc("new_tab", { url: PAGE });
    const tabs = await handle.rpc("tabs");
    check("tabs lists every page with pageId/url/title/active", tabs.length === 3 && tabs.every((t) => t.pageId && t.url === PAGE && t.title === "RPC test") && tabs.find((t) => t.active)?.pageId === tabB.pageId, JSON.stringify(tabs).slice(0, 160));
    check("close_tab closes the pinned tab", (await handle.rpc("close_tab", { pageId: tabB.pageId })) === true && (await handle.rpc("tabs")).length === 2);
    err = null;
    try { await handle.rpc("close_tab", {}); } catch (e) { err = e.message; }
    check("close_tab without pageId refuses", /needs the pageId/.test(err || ""), err);
    const closedN = await handle.rpc("close_other_tabs", { pageId: first });
    const tabsAfter = await handle.rpc("tabs");
    check("close_other_tabs keeps only the pinned page", closedN === 1 && tabsAfter.length === 1 && tabsAfter[0].pageId === first && tabsAfter[0].active === true && tabA.pageId !== first, JSON.stringify(tabsAfter));
    err = null;
    try { await handle.rpc("close_tab", { pageId: first }); } catch (e) { err = e.message; }
    check("close_tab refuses the last open tab", /last open tab/.test(err || ""), err);

    err = null;
    try { await handle.rpc("window", { action: "bounds" }); } catch (e) { err = e.message; }
    check("window op refuses on a headless worker", /no browser window found/.test(err || ""), err);

    // --- orchestrator: launchAndWait, the two events, the record counters
    records["rpc-orch"] = { id: "rpc-orch", userDataDir: path.join(SCRATCH, "orch-profile"), tabs: [], seed: 7 };
    const launched = [];
    const closed = [];
    orchestrator.on("session:launched", (e) => launched.push(e));
    orchestrator.on("session:closed", (e) => closed.push(e));
    const early = await orchestrator.launchAndWait(["rpc-orch"], { headless: true, url: PAGE, prefs: PREFS }, { timeoutMs: 1 });
    check("launchAndWait times out without cancelling the launch", early["rpc-orch"]?.ok === false && early["rpc-orch"]?.error === "timed out" && orchestrator.starting.has("rpc-orch"), JSON.stringify(early));
    const ev = await onceEvent(orchestrator, "session:launched", 60000);
    check("session:launched {id, startedAt, headless, exitIp?}", ev.id === "rpc-orch" && ev.headless === true && /^\d{4}-/.test(ev.startedAt) && !("exitIp" in ev && ev.exitIp === undefined), JSON.stringify(ev));
    check("startOne passes {url, headless, prefs} from queue time to openSession", seenOpts["rpc-orch"]?.url === PAGE && seenOpts["rpc-orch"]?.headless === true && seenOpts["rpc-orch"]?.prefs === PREFS, JSON.stringify(seenOpts["rpc-orch"]));
    const liveItem = orchestrator.getStatus().live.find((s) => s.id === "rpc-orch");
    check("getStatus().live[] carries headless + exitIp", liveItem?.headless === true && liveItem.exitIp === ev.exitIp, JSON.stringify(liveItem));
    check("launchCount incremented, lastExitIp only when known", records["rpc-orch"].launchCount === 1 && records["rpc-orch"].lastExitIp === ev.exitIp, JSON.stringify(records["rpc-orch"]).slice(0, 120));
    const t3 = Date.now();
    const again = await orchestrator.launchAndWait(["rpc-orch"]);
    check("launchAndWait resolves ok at once for a live id", again["rpc-orch"]?.ok === true && Date.now() - t3 < 200, `${Date.now() - t3} ms`);
    const t4 = Date.now();
    const bad = await orchestrator.launchAndWait(["nope"], {}, { timeoutMs: 20000 });
    check("launchAndWait reports a failed launch with its error", bad.nope?.ok === false && /unknown session/.test(bad.nope?.error) && Date.now() - t4 < 5000, JSON.stringify(bad));
    await sleep(600); // let the session live long enough for a non-zero workSeconds
    await orchestrator.stop("rpc-orch");
    const ce = closed[0] || (await onceEvent(orchestrator, "session:closed", 10000));
    check("session:closed {status, reason, startedAt, endedAt, durationMs, closedByUser}", ce.id === "rpc-orch" && ce.status === "success" && ce.reason === "closed by user" && ce.closedByUser === true && ce.startedAt === ev.startedAt && ce.durationMs > 500 && new Date(ce.endedAt) - new Date(ce.startedAt) === ce.durationMs, JSON.stringify(ce));
    await sleep(200);
    check("workSeconds accumulated on the record", records["rpc-orch"].workSeconds === Math.round(ce.durationMs / 1000) && records["rpc-orch"].workSeconds >= 1, `workSeconds=${records["rpc-orch"].workSeconds}`);
    check("stopped session left the pool", !orchestrator.live.has("rpc-orch"));

    // --- one short headful window for the window op (the desktop is in use: keep it brief)
    win = await launchWorker({ id: "rpc-win", userDataDir: path.join(SCRATCH, "win-profile"), tabs: [], seed: 9 }, { url: PAGE });
    const tw = Date.now();
    const b = await win.rpc("window", { action: "bounds" });
    check("window bounds {x,y,width,height,monitor}", b.ok && b.hwnd > 0 && b.bounds.width > 100 && b.bounds.height > 100 && b.bounds.monitor.width > 100, JSON.stringify(b));
    const mv = await win.rpc("window", { action: "move", rect: { x: 60, y: 60, width: 720, height: 540 } });
    check("window move lands on the rect", Math.abs(mv.bounds.x - 60) <= 16 && Math.abs(mv.bounds.y - 60) <= 16 && Math.abs(mv.bounds.width - 720) <= 32 && Math.abs(mv.bounds.height - 540) <= 32, JSON.stringify(mv.bounds));
    const mn = await win.rpc("window", { action: "minimize" });
    check("window minimize", mn.ok && mn.minimized === true);
    const rs = await win.rpc("window", { action: "restore" });
    check("window restore", rs.ok && rs.minimized === false);
    const fo = await win.rpc("window", { action: "focus" });
    check("window focus", fo.ok && fo.hwnd === b.hwnd && fo.minimized === false, `focused=${fo.focused}`);
    check("headful info reports headless:false", (await win.rpc("info")).headless === false, `${Date.now() - tw} ms of window ops`);
  } catch (e) {
    check("UNCAUGHT", false, e.stack);
  } finally {
    // close() resolves once the worker reports closed (cookies saved); the browser quits after.
    const gone = (h) => Promise.race([h.exited, new Promise((r) => setTimeout(r, 15000))]);
    if (win) {
      await win.close();
      await gone(win);
    }
    if (handle) {
      await handle.close();
      await gone(handle);
      let err = null;
      try { await handle.rpc("info", {}, 2000); } catch (e) { err = e.message; }
      check("RPC after close fails fast", err && /not running|closed|timed out/.test(err), err);
    }
    try { await orchestrator.stopAll(); } catch {}
    // A browser the orchestrator just closed may still hold its profile for a moment.
    for (let i = 0; i < 10; i++) {
      try { fs.rmSync(SCRATCH, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    for (const id of IDS) fs.rmSync(path.join(ROOT, "data", "cookies", `${id}.json`), { force: true }); // the workers' shutdown cookie dumps
    for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail && (!r.ok || /ms/.test(r.detail)) ? "  — " + r.detail : ""}`);
    console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }
})();
