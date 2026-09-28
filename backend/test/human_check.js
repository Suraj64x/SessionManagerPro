// The human_* ops (human_input.py) end to end, HEADLESS, on both engines: Stealth Firefox and an
// installed Chrome, each a qa- profile under os.tmpdir() with no proxy, on local pages served
// in-process. Proves: trusted mousemoves along curved, paced multi-point paths that start where the
// pointer is; wheel flicks as several eased events (never one jump) away from the scrollbar; human
// clicks landing on the target; typing that produces the text; the script API (the reference's
// createHumanCursor snippet) and the human warm-up following a link with a trusted click.
// data/ is touched only by the workers' cookie dumps, removed at the end.
//
//   node backend/test/human_check.js
const fs = require("fs");
const os = require("os");
const http = require("http");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
process.chdir(ROOT);
const { launchWorker, findPythonExe } = require(path.join(ROOT, "backend/src/worker_runner.js"));
const browsers = require(path.join(ROOT, "backend/src/browsers.js"));
const scripts = require(path.join(ROOT, "backend/src/scripts.js"));

const SCRATCH = path.join(os.tmpdir(), "qa-human-check");
const IDS = ["qa-human-firefox", "qa-human-chrome"];
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RECORD = `<script>
  window.__ev = [];
  const rec = (e) => __ev.push({ type: e.type, x: e.clientX, y: e.clientY, dy: e.deltaY, mode: e.deltaMode, trusted: e.isTrusted,
    id: e.target && e.target.id, t: performance.now(), buttons: e.buttons, key: e.key });
  for (const t of ["mousemove", "mousedown", "mouseup", "click", "wheel", "keydown"]) addEventListener(t, rec, { capture: true, passive: true });
</script>`;
const PAGES = {
  "/page.html": `<!doctype html><meta charset=utf-8><title>human</title>
<style>body { margin: 0; font: 16px sans-serif } #email { position: absolute; left: 120px; top: 120px; width: 260px }
#area { position: absolute; left: 120px; top: 180px; width: 300px; height: 60px }
#b { position: absolute; left: 600px; top: 1500px; width: 140px; height: 44px }
#footer { position: absolute; left: 0; top: 3800px; width: 100%; height: 60px }</style>
<input id=email><textarea id=area></textarea><button id=b onclick="document.title = 'clicked'">go</button>
<div id=footer>footer</div><div style="height:4400px"></div>${RECORD}`,
  "/warm-a.html": `<!doctype html><title>warm a</title><p>Something to read before moving on.</p>
<a href="/warm-b.html" onclick="sessionStorage.qaLink = event.isTrusted">read more</a><div style="height:2500px"></div>
<script>addEventListener("wheel", (e) => { if (e.isTrusted) sessionStorage.qaWheel = (+sessionStorage.qaWheel || 0) + 1; }, { passive: true });</script>`,
  "/warm-b.html": `<!doctype html><title>warm b</title><script>document.cookie = "qa_b=1; path=/"</script><div style="height:2500px"></div>`,
};
const server = http.createServer((req, res) => {
  const body = PAGES[req.url.split("?")[0]];
  res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
  res.end(body || "not found");
});

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const ofType = (ev, type) => ev.filter((e) => e.type === type);
// Perpendicular distance of each event from the chord a -> b.
const bow = (ms, a, b) => Math.max(0, ...ms.map((p) => Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / (dist(a, b) || 1)));
const maxStep = (ms) => Math.max(0, ...ms.slice(1).map((p, i) => dist(p, ms[i])));
const sum = (ws) => ws.reduce((s, e) => s + e.dy, 0);

async function engineChecks(label, h, id) {
  const L = (s) => `${label}: ${s}`;
  const events = () => h.rpc("eval", { code: "window.__ev.splice(0)" });
  const evalv = (code) => h.rpc("eval", { code });
  const vp = await evalv("({ w: innerWidth, h: innerHeight })");
  const timed = async (op, payload) => {
    const t = Date.now();
    const v = await h.rpc(op, payload);
    return { v, ms: Date.now() - t };
  };

  // --- the pointer
  const intro = await h.rpc("human_move", {});
  let ev = await events();
  let ms = ofType(ev, "mousemove");
  const edge = ms[0] && (ms[0].x < 60 || ms[0].x > vp.w - 60 || ms[0].y > vp.h - 60);
  check(L("first human op brings the pointer in from an edge and eases inwards"), ms.length >= 3 && edge && ms.every((e) => e.trusted) &&
    ms.at(-1).x === intro.x && ms.at(-1).y === intro.y, `${ms.length} moves, from ${ms[0]?.x},${ms[0]?.y} to ${intro.x},${intro.y}`);

  const A = { x: Math.round(vp.w * 0.15), y: Math.round(vp.h * 0.8) };
  const B = { x: Math.round(vp.w * 0.7), y: Math.round(vp.h * 0.25) };
  await h.rpc("human_move", A);
  await events();
  const toB = await timed("human_move", B);
  const mB = ofType(await events(), "mousemove");
  await h.rpc("human_move", A);
  const mA = ofType(await events(), "mousemove");
  const d = dist(A, B);
  check(L("human_move: trusted mousemoves along a multi-point path, ending exactly on target"), mB.length >= 5 && mA.length >= 5 &&
    [...mA, ...mB].every((e) => e.trusted) && toB.v.x === B.x && toB.v.y === B.y && mB.at(-1).x === B.x && mB.at(-1).y === B.y,
    `${mB.length} + ${mA.length} events over ${Math.round(d)} px`);
  check(L("the path is curved and never one jump"), Math.max(bow(mB, A, B), bow(mA, B, A)) > 2 && maxStep(mB) < d * 0.35 && maxStep(mA) < d * 0.35,
    `bow ${bow(mB, A, B).toFixed(1)} / ${bow(mA, B, A).toFixed(1)} px, largest step ${Math.round(Math.max(maxStep(mB), maxStep(mA)))} px`);
  const span = mB.at(-1).t - mB[0].t;
  check(L("paced like a hand (reference: 1400-2600 px/s)"), span > 80 && d / (toB.ms / 1000) > 700 && d / (toB.ms / 1000) < 6000,
    `${Math.round(d)} px in ${toB.ms} ms (${Math.round(d / (toB.ms / 1000))} px/s), events over ${Math.round(span)} ms`);
  check(L("each move starts where the pointer is (no teleport)"), dist(mB[0], A) < 120 && dist(mA[0], B) < 120,
    `${Math.round(dist(mB[0], A))} / ${Math.round(dist(mA[0], B))} px from the start`);

  // --- the wheel
  await evalv("scrollTo(0, 0), 1");
  await sleep(300);
  await events();
  const s3 = await timed("human_scroll", { notches: 3 });
  await sleep(700);
  const w3 = ofType(await events(), "wheel");
  const y3 = await evalv("scrollY");
  const big = Math.max(...w3.map((e) => e.dy));
  check(L("human_scroll {notches: 3}: several trusted wheel events summing to 300 px"), w3.length >= 5 && w3.every((e) => e.trusted && e.dy > 0 && e.mode === 0) &&
    Math.abs(sum(w3) - 300) <= 3 && Math.abs(y3 - 300) <= 40, `${w3.length} events, deltas ${w3.map((e) => Math.round(e.dy)).join(",")} = ${sum(w3)}, scrollY ${y3}`);
  const gaps = w3.slice(1).map((e, i) => e.t - w3[i].t);
  check(L("the flick is eased (it tails off) and quick (70-320 ms planned)"), big < 300 * 0.4 && w3.at(-1).dy <= big / 2 && new Set(w3.map((e) => Math.round(e.dy))).size >= 3 &&
    w3.at(-1).t - w3[0].t < 600 && gaps.reduce((a, b) => a + b, 0) / gaps.length < 45,
    `${Math.round(w3.at(-1).t - w3[0].t)} ms of events, mean gap ${(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1)} ms, op ${s3.ms} ms`);
  check(L("wheel events come from inside the content, never over the scrollbar"), w3.every((e) => e.x <= vp.w - 36 && e.x >= 40), `x ${w3[0].x}`);
  await h.rpc("human_scroll", { notches: -2 });
  await sleep(700);
  const w2 = ofType(await events(), "wheel");
  const y2 = await evalv("scrollY");
  check(L("human_scroll {notches: -2} goes back up 200 px"), w2.length >= 5 && w2.every((e) => e.dy < 0) && Math.abs(sum(w2) + 200) <= 3 && Math.abs(y2 - 100) <= 40,
    `${w2.length} events = ${sum(w2)}, scrollY ${y2}`);
  await h.rpc("human_scroll", { px: 800 });
  await sleep(700);
  const w8 = ofType(await events(), "wheel");
  check(L("human_scroll {px: 800}: one flick of 800 px"), w8.length >= 8 && Math.abs(sum(w8) - 800) <= 3 && Math.max(...w8.map((e) => e.dy)) < 800 * 0.3,
    `${w8.length} events = ${sum(w8)}`);
  await h.rpc("human_scroll", { selector: "#footer" });
  await sleep(900);
  check(L("human_scroll {selector} brings the element on screen"), await evalv("(() => { const r = document.querySelector('#footer').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()"),
    `scrollY ${await evalv("scrollY")}`);

  // --- clicking
  await evalv("scrollTo(0, 0), document.title = 'human', 1");
  await sleep(400);
  await events();
  const clk = await timed("human_click", { selector: "#b" });
  const ce = await events();
  const box = await evalv("(() => { const r = document.querySelector('#b').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()");
  const click = ce.find((e) => e.type === "click");
  const down = ce.find((e) => e.type === "mousedown");
  const up = ce.find((e) => e.type === "mouseup");
  const inBox = click && click.x >= box.x && click.x <= box.x + box.w && click.y >= box.y && click.y <= box.y + box.h;
  check(L("human_click {selector}: scrolled into view with the wheel, then a trusted click on the target"), (await evalv("document.title")) === "clicked" &&
    click?.trusted && click.id === "b" && inBox && ofType(ce, "wheel").length >= 3 && ce.indexOf(down) > 3 && ofType(ce.slice(0, ce.indexOf(down)), "mousemove").length >= 3,
    `at ${click?.x},${click?.y} in ${Math.round(box.x)},${Math.round(box.y)} ${box.w}x${box.h}; ${ofType(ce, "wheel").length} wheel, op ${clk.ms} ms`);
  check(L("the press is a real one: buttons=1, 10-120 ms down"), down?.trusted && up?.trusted && down.buttons === 1 && up.t - down.t >= 10 && up.t - down.t <= 120,
    `${Math.round(up?.t - down?.t)} ms`);

  // --- typing
  await events();
  const ty = await timed("human_type", { selector: "#email", text: "hello@outlook.com", credentialField: true, emailField: true });
  const kd = ofType(await events(), "keydown");
  check(L("human_type {credentialField, emailField}: the field holds exactly the text"), (await evalv("document.querySelector('#email').value")) === "hello@outlook.com" &&
    kd.length >= 17 && kd.every((e) => e.trusted), `${kd.length} keydowns in ${ty.ms} ms`);
  await h.rpc("human_type", { selector: "#area", text: "Plain words here", noTypos: true });
  check(L("human_type {noTypos}: exact text"), (await evalv("document.querySelector('#area').value")) === "Plain words here");

  // --- fidgets
  await events();
  const wd = await h.rpc("human_wander", {});
  const wm = ofType(await events(), "mousemove");
  check(L("human_wander darts about the page, off the scrollbar gutter"), wd === true && wm.length >= 3 && wm.every((e) => e.trusted && e.x <= vp.w - 20 && e.y >= 0 && e.y <= vp.h),
    `${wm.length} moves`);
  const sb = await h.rpc("human_scroll_burst", {});
  check(L("human_scroll_burst: short flicks"), sb === true && ofType(await events(), "wheel").length >= 3);
  const maybe = await h.rpc("human_wander", { force: false });
  check(L("human_wander {force: false} only sometimes (20 %)"), typeof maybe === "boolean", String(maybe));

  // --- one pointer for the plain ops and the human ones
  await evalv("scrollTo(0, 0), 1");
  await sleep(300);
  const P = await h.rpc("human_move", {});
  await events();
  await h.rpc("click", { selector: "#area" }); // on screen: on Stealth Firefox the engine walks there itself
  const pc = await events();
  const pClick = pc.find((e) => e.type === "click");
  if (label === "Stealth Firefox") {
    const first = ofType(pc, "mousemove")[0];
    check(L("the engine's own click starts where the human cursor left the pointer"), first && dist(first, P) < 120, `${first && Math.round(dist(first, P))} px`);
  }
  await h.rpc("human_move", { x: Math.round(vp.w * 0.5), y: Math.round(vp.h * 0.6) });
  const after = ofType(await events(), "mousemove");
  check(L("a human move starts where a plain click left the pointer"), pClick && after[0] && dist(after[0], pClick) < 120, `${after[0] && pClick && Math.round(dist(after[0], pClick))} px`);
  await h.rpc("click", { selector: "#b" }); // off screen: the plain op scrolls and presses its centre with no path
  const oClick = (await events()).find((e) => e.type === "click");
  await h.rpc("human_move", { x: Math.round(vp.w * 0.3), y: Math.round(vp.h * 0.3) });
  const after2 = ofType(await events(), "mousemove");
  check(L("...also after a plain click on an off-screen element"), oClick && after2[0] && dist(after2[0], oClick) < 120, `${after2[0] && oClick && Math.round(dist(after2[0], oClick))} px`);

  // --- the script API: the reference's snippet, and the global form
  const deps = { orchestrator: { live: new Map([[id, { handle: h }]]), log: () => {} }, getSession: () => ({ id, email: "qa@example.com", tags: [] }) };
  const settle = async (runId, max) => {
    const end = Date.now() + max;
    for (;;) {
      const r = scripts.recentRuns().find((x) => x.id === runId).results[id];
      if (!["pending", "running"].includes(r.state) || Date.now() > end) return r;
      await sleep(200);
    }
  };
  await evalv("document.querySelector('#email').value = '', document.title = 'human', scrollTo(0, 0), 1");
  const snippet = [
    "const cursor = createHumanCursor(page, { showVirtualMouse: false });",
    "await cursor.ensureIntro();",
    "await cursor.moveTo(400, 300);",
    "await cursor.clickElement('#b');",
    "await cursor.type('hello@outlook.com', { selector: '#email', credentialField: true, emailField: true });",
    "await cursor.scroll(3);",
    "await cursor.scroll(-2);",
    "await cursor.scrollToSelector('#footer');",
    "await cursor.wanderMouse(true);",
    "await cursor.scrollBurst(true);",
    "await ghostHumanScroll(page, cursor.ghost, 3, {}, { pixelsPerNotch: 100, pxPerSecMin: 1400, pxPerSecMax: 2200, frameMs: 8 });",
    "await smoothScrollPx(page, cursor.ghost, 800);",
    "return (await page.title()) + ' ' + (await page.evaluate(() => document.querySelector('#email').value));",
  ].join("\n");
  const t0 = Date.now();
  const run1 = await settle(scripts.startRun({ name: "qa-human", mode: "automation", code: snippet }, [id], deps).id, 90_000);
  check(L("script API: the createHumanCursor snippet runs as pasted"), run1.state === "ok" && run1.value === "clicked hello@outlook.com", `${JSON.stringify(run1).slice(0, 200)} in ${Date.now() - t0} ms`);
  const run2 = await settle(scripts.startRun({ name: "qa-human-global", mode: "automation", code: "await cursor.moveTo('#b'); await cursor.clickAt(300, 200); return await cursor.ensureIntro();" }, [id], deps).id, 30_000);
  check(L("script API: the global cursor, moveTo(selector), clickAt"), run2.state === "ok" && /"x":\s*\d+/.test(run2.value), `${run2.state} ${run2.value || run2.error}`);

  // --- the warm-up, human
  const tw = Date.now();
  const wu = scripts.startRun(scripts.WARMUP, [id], deps, { input: { sites: [`${BASE()}/warm-a.html`], dwell: [3, 3], links: 1, scroll: true, shuffle: false } });
  const wr = await settle(wu.id, 90_000);
  let wv = {};
  try {
    wv = JSON.parse(wr.value || "{}");
  } catch {
    // shown below
  }
  const wurl = (await h.rpc("info")).url;
  const store = await evalv("({ link: sessionStorage.qaLink, wheel: +sessionStorage.qaWheel || 0 })");
  check(L("warm-up: browses with wheel flicks and follows the link with a trusted click"), wr.state === "ok" && wv.sites === 1 && wurl.endsWith("/warm-b.html") &&
    store.link === "true" && store.wheel >= 3 && wv.cookiesAfter > wv.cookiesBefore,
    `${wr.state} ${wr.value || wr.error} on ${wurl.split("/").pop()}, link click trusted=${store.link}, ${store.wheel} wheel events, ${Date.now() - tw} ms`);
}

let port = 0;
const BASE = () => `http://127.0.0.1:${port}`;

(async () => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  const handles = [];
  try {
    const py = execFileSync(findPythonExe(), ["-E", "-s", path.join(ROOT, "backend/src/human_input.py")], { encoding: "utf8" }).trim();
    check("human_input.py self-check (paths, pacing, flicks, typing)", /PASS$/.test(py), py);

    const t0 = Date.now();
    const ff = await launchWorker({ id: IDS[0], userDataDir: path.join(SCRATCH, "firefox"), tabs: [], seed: 4242 }, { headless: true, url: `${BASE()}/page.html` });
    handles.push(ff);
    check("Stealth Firefox worker ready (headless, no proxy)", true, `${Date.now() - t0} ms`);
    await engineChecks("Stealth Firefox", ff, IDS[0]);

    const chrome = (await browsers.list()).find((b) => b.id === "chrome" && b.installed);
    if (!chrome) {
      check("Chrome: skipped, not installed", true);
    } else {
      const t1 = Date.now();
      const cr = await launchWorker({ id: IDS[1], userDataDir: path.join(SCRATCH, "chrome"), tabs: [], seed: 11, browser: "chrome" }, { headless: true, url: `${BASE()}/page.html` });
      handles.push(cr);
      check("Chrome worker ready (headless, no proxy)", true, `${Date.now() - t1} ms`);
      await engineChecks("Chrome", cr, IDS[1]);
    }
  } catch (e) {
    check("UNCAUGHT", false, e.stack);
  } finally {
    for (const h of handles) await h.close().catch(() => {});
    server.close();
    await sleep(500);
    fs.rmSync(SCRATCH, { recursive: true, force: true });
    for (const id of IDS) fs.rmSync(path.join(ROOT, "data", "cookies", `${id}.json`), { force: true });
    for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  — " + r.detail : ""}`);
    console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }
})();
