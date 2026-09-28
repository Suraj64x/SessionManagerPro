// Window control and broadcast. Window ops cannot run headless, so /api/sessions/window is
// checked against fake live entries whose rpc("window") returns canned bounds (the rect
// maths and the request handling); /api/broadcast runs end to end on one qa-windows-*
// profile attached to a real HEADLESS worker with no proxy. Starts the server in-process
// on 3017; trashes and purges the qa profile at the end.
//
//   node backend/test/windows_check.js
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
process.chdir(ROOT);
process.argv.push("--no-open", "--no-terminal");
const PORT = 3017;
process.env.PORT = String(PORT);

const { server } = require(path.join(ROOT, "backend/src/server.js"));
const manager = require(path.join(ROOT, "backend/src/manager.js"));
const orchestrator = require(path.join(ROOT, "backend/src/orchestrator.js"));
const { launchWorker } = require(path.join(ROOT, "backend/src/worker_runner.js"));
const { cascade, tile } = require(path.join(ROOT, "backend/src/features/windows.js"));

const ID = "qa-windows-1";
const FAKES = ["qa-windows-fake-a", "qa-windows-fake-b", "qa-windows-fake-c"];
const HEADLESS_FAKE = "qa-windows-fake-headless";
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function post(p, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method: "POST",
    headers: { Host: `127.0.0.1:${PORT}`, "X-SMP": "1", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { code: res.status, json: await res.json().catch(() => null) };
}

/* ---------------- fake windows: canned bounds, every call recorded ---------------- */

const MON = { x: 0, y: 0, width: 1920, height: 1040 };
const calls = [];
function fakeHandle(id, size, { refuseFocus = false, fail = false } = {}) {
  const b = { x: 100, y: 100, ...size, monitor: MON };
  return {
    id,
    headless: false,
    rpc: async (op, payload) => {
      calls.push({ id, op, ...payload });
      if (op !== "window") throw new Error(`fake: no ${op}`);
      if (fail) throw new Error("no browser window found");
      if (payload.action === "move") Object.assign(b, payload.rect);
      return { ok: true, hwnd: 1, minimized: false, bounds: { ...b }, ...(payload.action === "focus" ? { focused: !refuseFocus } : {}) };
    },
  };
}
const attachFake = (id, handle, extra = {}) =>
  orchestrator.live.set(id, { id, handle, startedAt: new Date().toISOString(), url: "about:blank", headless: false, ...extra });

async function windowChecks() {
  // Pure maths first.
  const c = cascade([{ width: 800, height: 600 }, { width: 900, height: 700 }, { width: 3000, height: 2000 }], MON);
  check(
    "cascade keeps sizes, steps 32 px from the origin, clamps oversize to the work area",
    eq(c, [
      { x: 0, y: 0, width: 800, height: 600 },
      { x: 32, y: 32, width: 900, height: 700 },
      { x: 0, y: 0, width: 1920, height: 1040 },
    ]),
    JSON.stringify(c)
  );
  const wrap = cascade(Array(12).fill({ width: 1600, height: 900 }), MON);
  check("cascade wraps to the origin before leaving the work area", wrap.every((r) => r.y + r.height <= 1040) && wrap[5].x === 0, JSON.stringify(wrap.map((r) => r.x)));
  const t = tile(5, { x: 1920, y: 0, width: 1920, height: 1040 });
  check(
    "tile 5 → 3×2 grid on the given work area",
    eq(t[0], { x: 1920, y: 0, width: 640, height: 520 }) && eq(t[4], { x: 1920 + 640, y: 520, width: 640, height: 520 }),
    JSON.stringify(t)
  );

  // The route, with fakes in the live pool.
  attachFake(FAKES[0], fakeHandle(FAKES[0], { width: 800, height: 600 }));
  attachFake(FAKES[1], fakeHandle(FAKES[1], { width: 1000, height: 700 }, { refuseFocus: true }));
  attachFake(FAKES[2], fakeHandle(FAKES[2], { width: 900, height: 600 }, { fail: true }));
  attachFake(HEADLESS_FAKE, fakeHandle(HEADLESS_FAKE, { width: 1, height: 1 }), { headless: true });

  const bad = await Promise.all([
    post("/api/sessions/window", { ids: [], action: "tile" }),
    post("/api/sessions/window", { ids: [FAKES[0]], action: "maximize" }),
    post("/api/sessions/window", { ids: [FAKES[0]], action: "tile", monitor: { x: 0 } }),
    post("/api/sessions/window", { ids: Array(1001).fill("x"), action: "focus" }),
  ]);
  check("window: empty ids, unknown action, bad monitor, too many ids → 400", bad.every((r) => r.code === 400), bad.map((r) => r.code).join(","));

  calls.length = 0;
  const tl = await post("/api/sessions/window", { ids: [FAKES[0], FAKES[1], FAKES[2], HEADLESS_FAKE, "qa-windows-nope"], action: "tile" });
  const r = tl.json?.results || {};
  const moves = calls.filter((x) => x.action === "move");
  check(
    "tile: two placed side by side on the first window's work area",
    tl.code === 200 && eq(moves.find((m) => m.id === FAKES[0])?.rect, { x: 0, y: 0, width: 960, height: 1040 }) && eq(moves.find((m) => m.id === FAKES[1])?.rect, { x: 960, y: 0, width: 960, height: 1040 }),
    JSON.stringify(moves)
  );
  check("tile: restore precedes move for each window", [FAKES[0], FAKES[1]].every((id) => calls.filter((x) => x.id === id).map((x) => x.action).join() === "restore,move"));
  check(
    "tile: per-id results — ok with bounds, window error, headless, not running",
    r[FAKES[0]]?.ok && r[FAKES[0]].bounds?.width === 960 && r[FAKES[2]]?.ok === false && /no browser window/.test(r[FAKES[2]].error) && /headless/.test(r[HEADLESS_FAKE]?.error) && r["qa-windows-nope"]?.error === "not running",
    JSON.stringify(r)
  );
  check("tile: headless and missing profiles are never called", !calls.some((x) => x.id === HEADLESS_FAKE));

  calls.length = 0;
  // Fresh sizes: the tile above resized the fakes.
  attachFake(FAKES[0], fakeHandle(FAKES[0], { width: 800, height: 600 }));
  attachFake(FAKES[1], fakeHandle(FAKES[1], { width: 1000, height: 700 }, { refuseFocus: true }));
  const cs = await post("/api/sessions/window", { ids: [FAKES[0], FAKES[1]], action: "cascade" });
  const cm = calls.filter((x) => x.action === "move");
  check(
    "cascade: sizes kept (as restored), 32 px steps",
    cs.code === 200 && eq(cm.find((m) => m.id === FAKES[0])?.rect, { x: 0, y: 0, width: 800, height: 600 }) && eq(cm.find((m) => m.id === FAKES[1])?.rect, { x: 32, y: 32, width: 1000, height: 700 }),
    JSON.stringify(cm)
  );
  calls.length = 0;
  const mon = { x: -1920, y: 0, width: 1920, height: 1040 };
  await post("/api/sessions/window", { ids: [FAKES[0]], action: "tile", monitor: mon });
  check("an explicit monitor overrides the window's own", eq(calls.find((x) => x.action === "move")?.rect, mon));

  const fo = await post("/api/sessions/window", { ids: [FAKES[0], FAKES[1]], action: "focus" });
  check(
    "focus: ok, and a refused foreground is reported as failed",
    fo.json?.results?.[FAKES[0]]?.ok === true && fo.json.results[FAKES[1]]?.ok === false && /refused/.test(fo.json.results[FAKES[1]].error),
    JSON.stringify(fo.json)
  );
  calls.length = 0;
  const mn = await post("/api/sessions/window", { ids: [...FAKES, FAKES[0]], action: "minimize" });
  check(
    "minimize: one call per unique id, errors collected",
    eq(Object.keys(mn.json?.results || {}).sort(), [...FAKES].sort()) && calls.filter((x) => x.id === FAKES[0]).length === 1 && mn.json.results[FAKES[2]].ok === false,
    JSON.stringify(mn.json)
  );
}

/* ---------------- broadcast: validation, then a real headless worker ---------------- */

const PAGE =
  "data:text/html," +
  encodeURIComponent(
    "<title>qa-windows</title><input id=q onkeydown=\"if(event.key==='Enter')document.title='entered:'+this.value\"><div style='height:4000px'></div>"
  );

async function broadcastChecks() {
  const bad = await Promise.all([
    post("/api/broadcast", { ids: [ID], op: "eval", args: {} }),
    post("/api/broadcast", { ids: [ID], op: "open_url", args: { url: "javascript:alert(1)" } }),
    post("/api/broadcast", { ids: [ID], op: "open_url", args: { url: "https://example.com", where: "side" } }),
    post("/api/broadcast", { ids: [ID], op: "press", args: { key: "Control+w" } }),
    post("/api/broadcast", { ids: [ID], op: "type", args: { random: [9, 1] } }),
    post("/api/broadcast", { ids: [ID], op: "type", args: {} }),
    post("/api/broadcast", { ids: [ID], op: "type", args: { text: "x".repeat(2001) } }),
    post("/api/broadcast", { ids: [ID], op: "scroll", args: { dy: "lots" } }),
    post("/api/broadcast", { ids: "all", op: "reload" }),
  ]);
  check("broadcast: bad op/url/where/key/random/text/dy/ids → 400", bad.every((r) => r.code === 400), bad.map((r) => `${r.code} ${r.json?.error}`).join(" | "));

  const rec = manager.getSession(ID);
  // The engine gets 30 s to report ready; on a busy machine the first try can miss it.
  const launch = () => launchWorker({ ...rec, proxy: undefined, fingerprint: undefined }, { headless: true, url: PAGE });
  const handle = await launch().catch(async (err) => {
    console.log(`launch retry after: ${err.message}`);
    await new Promise((r) => setTimeout(r, 5000));
    return launch();
  });
  orchestrator.live.set(ID, { id: ID, handle, startedAt: new Date().toISOString(), url: PAGE, headless: true });
  const ev = (code) => handle.rpc("eval", { code });
  try {
    const w = await post("/api/sessions/window", { ids: [ID], action: "focus" });
    check("window on a real headless profile → error, not a crash", w.code === 200 && /headless/.test(w.json?.results?.[ID]?.error), JSON.stringify(w.json));

    await handle.rpc("click", { selector: "#q" });
    const ty = await post("/api/broadcast", { ids: [ID, "qa-windows-nope"], op: "type", args: { text: "hi" } });
    check(
      "type (same text) types into the focused input; a stopped profile gets an error",
      ty.json?.results?.[ID]?.ok && ty.json.results[ID].value === "hi" && ty.json.results["qa-windows-nope"]?.error === "not running" && (await ev("document.querySelector('#q').value")) === "hi",
      JSON.stringify(ty.json)
    );
    const pp = await post("/api/broadcast", { ids: [ID], op: "type", perProfile: { [ID]: { text: "-a" } } });
    const rn = await post("/api/broadcast", { ids: [ID], op: "type", args: { random: [7, 7] } });
    check(
      "type (one line per profile) and (random number) append their own values",
      pp.json?.results?.[ID]?.ok && rn.json?.results?.[ID]?.value === "7" && (await ev("document.querySelector('#q').value")) === "hi-a7",
      JSON.stringify([pp.json, rn.json])
    );
    const pe = await post("/api/broadcast", { ids: [ID], op: "type", perProfile: { other: { text: "x" } } });
    check("type: a profile without a line fails on its own", pe.code === 200 && /no text/.test(pe.json?.results?.[ID]?.error), JSON.stringify(pe.json));

    const pr = await post("/api/broadcast", { ids: [ID], op: "press", args: { key: "Enter" } });
    check("press Enter reaches the page", pr.json?.results?.[ID]?.ok && (await ev("document.title")) === "entered:hi-a7", JSON.stringify(pr.json));

    const sc = await post("/api/broadcast", { ids: [ID], op: "scroll", args: { dy: 800 } });
    await new Promise((r) => setTimeout(r, 400));
    const y = await ev("window.scrollY");
    check("scroll moves the page", sc.json?.results?.[ID]?.ok && y > 0, `scrollY=${y}`);

    // Firefox restores form values on reload, so a page global is the proof of a fresh document.
    await ev("window.__qa = 1");
    const rl = await post("/api/broadcast", { ids: [ID], op: "reload" });
    check("reload returns the url and gives a fresh document", rl.json?.results?.[ID]?.value?.startsWith("data:") && (await ev("typeof window.__qa")) === "undefined", JSON.stringify(rl.json).slice(0, 120));

    const nt = await post("/api/broadcast", { ids: [ID], op: "open_url", args: { url: "about:blank", where: "new" } });
    const tabs = await handle.rpc("tabs");
    check("open_url (new tab) opens a second tab", nt.json?.results?.[ID]?.ok && tabs.length === 2, JSON.stringify(nt.json));

    const co = await post("/api/broadcast", { ids: [ID], op: "close_other_tabs" });
    check("close_other_tabs closes one and leaves one", co.json?.results?.[ID]?.value === 1 && (await handle.rpc("tabs")).length === 1, JSON.stringify(co.json));

    const cu = await post("/api/broadcast", { ids: [ID], op: "open_url", args: { url: "about:blank", where: "current" } });
    check("open_url (current tab) navigates it", cu.json?.results?.[ID]?.value === "about:blank" && (await handle.rpc("tabs")).length === 1, JSON.stringify(cu.json));
  } finally {
    orchestrator.live.delete(ID);
    await handle.close().catch(() => {});
  }
}

server.listen(PORT, "127.0.0.1", async () => {
  try {
    // Fake proxy + stub fingerprint: no real proxy taken and no geo lookup; the worker gets neither.
    await manager.createSessionRecord(ID, {
      proxy: { scheme: "http", host: "10.255.255.2", port: 9, username: "", password: "" },
      fingerprint: { qa: true },
    });
    await windowChecks();
    await broadcastChecks();
  } catch (e) {
    check("UNCAUGHT", false, e.stack);
  } finally {
    for (const id of [...FAKES, HEADLESS_FAKE]) orchestrator.live.delete(id);
    // A killed worker's Firefox can hold the profile folder for a few seconds.
    let cleanupError = "";
    for (let i = 0; i < 8 && [...manager.listSessions(), ...manager.listTrash()].some((x) => x.id === ID); i++) {
      if (i) await new Promise((r) => setTimeout(r, 2000));
      try {
        if (manager.getSession(ID)) await manager.trashSession(ID);
        await manager.purgeTrash({ id: ID });
      } catch (e) {
        cleanupError = e.message;
      }
    }
    fs.rmSync(path.join(ROOT, "data", "cookies", `${ID}.json`), { force: true });
    const left = [...manager.listSessions(), ...manager.listTrash()].some((x) => x.id === ID);
    check("cleanup: qa profile gone", !left, cleanupError);
    for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail && !r.ok ? `  — ${r.detail}` : ""}`);
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    server.close();
    process.exit(failed ? 1 : 0);
  }
});
