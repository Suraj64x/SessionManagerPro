// Profile history + cookie snapshots, end to end on one qa profile: created through the API,
// five old snapshots planted, one restored while stopped, then a real HEADLESS proxy-less
// launch through the orchestrator (staged cookies, a script ok + fail, a live restore),
// a stop, and the snapshot taken on that clean close. Starts the server in-process on 3018
// and touches only qa-history-* data, which it trashes and purges through the API at the end.
//
//   node backend/test/history_check.js
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
process.chdir(ROOT);
process.argv.push("--no-open", "--no-terminal");
const PORT = 3018;
process.env.PORT = String(PORT);

const { server } = require(path.join(ROOT, "backend/src/server.js"));
const manager = require(path.join(ROOT, "backend/src/manager.js"));
const orchestrator = require(path.join(ROOT, "backend/src/orchestrator.js"));
const scripts = require(path.join(ROOT, "backend/src/scripts.js"));

const ID = "qa-history-a";
const DATA = path.join(ROOT, "data");
const HIST = path.join(DATA, "history", `${ID}.jsonl`);
const SNAPS = path.join(DATA, "cookies", "snapshots", ID);
const COOKIES = path.join(DATA, "cookies", `${ID}.json`);
const PAGE = "data:text/html," + encodeURIComponent("<title>qa history</title><p>hi</p>");

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(250);
  }
  return false;
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
    // a download
  }
  return { code: res.status, json, text };
}
const enc = encodeURIComponent;
const history = async (q = "") => (await call("GET", `/api/sessions/${enc(ID)}/history${q}`)).json;
const types = (h) => h.events.map((e) => e.type);
const cookie = (name, value) => ({ name, value, domain: ".example.com", path: "/", expires: Math.floor(Date.now() / 1000) + 86400 });

// Right after a stop Firefox can still hold the profile folder, and the rename into the
// trash fails with a 500 (EPERM): retry until it lets go.
async function trash() {
  let r;
  for (let i = 0; i < 40; i++) {
    r = await call("DELETE", `/api/sessions/${enc(ID)}`);
    if (r.code !== 500) break;
    await sleep(500);
  }
  return r;
}
async function purge() {
  if (manager.getSession(ID)) await trash();
  await until(async () => (await call("DELETE", `/api/trash/${enc(ID)}`)).code !== 409, 10_000);
}

async function main() {
  await purge(); // a previous run that died half-way
  // A fake proxy keeps the pool's real ones free; it is dropped before launch (proxy-less engine).
  const made = await call("POST", "/api/sessions/create", { name: ID, proxy: "http://10.255.255.1:9" });
  check("POST /api/sessions/create → 200", made.code === 200, `HTTP ${made.code} ${made.text.slice(0, 120)}`);
  let h = await history();
  check("'created' event from the SESSION log", types(h)[0] === "created", JSON.stringify(h?.events));
  check("stats from the record: zero counters, createdAt", h.stats.launchCount === 0 && h.stats.workSeconds === 0 && h.stats.createdAt === manager.getSession(ID).createdAt, JSON.stringify(h.stats));
  check("unknown profile → 404", (await call("GET", "/api/sessions/qa-history-nope/history")).code === 404);

  // Five old snapshots, oldest first; the newest one has two cookies.
  fs.mkdirSync(SNAPS, { recursive: true });
  for (let d = 1; d <= 5; d++) {
    const list = d === 5 ? [cookie("snap_a", "1"), cookie("snap_b", "2")] : [cookie("old", String(d))];
    fs.writeFileSync(path.join(SNAPS, `2020-01-0${d}T00-00-00.000Z.json`), JSON.stringify(list));
  }
  const snaps = (await call("GET", `/api/sessions/${enc(ID)}/snapshots`)).json;
  check(
    "GET snapshots: newest first with at, count, bytes",
    snaps.length === 5 && snaps[0].file === "2020-01-05T00-00-00.000Z.json" && snaps[0].at === "2020-01-05T00:00:00.000Z" && snaps[0].count === 2 && snaps[0].bytes > 0,
    JSON.stringify(snaps[0])
  );
  const newest = snaps[0].file;
  const dl = await call("GET", `/api/sessions/${enc(ID)}/snapshots/${newest}`);
  check("download returns the file", dl.code === 200 && dl.text === fs.readFileSync(path.join(SNAPS, newest), "utf8"));
  check("a bad snapshot name → 400", (await call("POST", `/api/sessions/${enc(ID)}/snapshots/${enc("../x.json")}/restore`)).code === 400);
  check("a missing snapshot → 404", (await call("GET", `/api/sessions/${enc(ID)}/snapshots/2021-01-01T00-00-00.000Z.json`)).code === 404);

  const r1 = await call("POST", `/api/sessions/${enc(ID)}/snapshots/${newest}/restore`);
  check("restore while stopped → next launch", r1.code === 200 && r1.json.applied === "next launch" && r1.json.count === 2, r1.text);
  check("…overwrites the cookie dump", fs.readFileSync(COOKIES, "utf8") === fs.readFileSync(path.join(SNAPS, newest), "utf8"));
  check("…and stages the import", fs.existsSync(path.join(DATA, "cookies", `${ID}.import.json`)));

  manager.stageCookieImport(ID, manager.normalizeCookies([cookie("qa_staged", "yes")]));
  await manager.saveSessionPatch(ID, { proxy: null });

  const t0 = Date.now();
  const res = await orchestrator.launchAndWait([ID], { headless: true, url: PAGE }, { timeoutMs: 90_000 });
  check("headless launch through the orchestrator", res[ID]?.ok, `${JSON.stringify(res[ID])} ${Date.now() - t0} ms`);
  if (!res[ID]?.ok) return;

  await until(async () => types(await history()).includes("cookies_imported"), 3000);
  h = await history();
  const launched = h.events.find((e) => e.type === "launched");
  check("'launched' event with headless: true", launched?.headless === true, JSON.stringify(launched));
  const imp = h.events.find((e) => e.type === "cookies_imported");
  check("'cookies_imported' from the staged import (3 of 3)", imp?.count === 3 && imp?.total === 3, JSON.stringify(imp));
  check("'proxy_changed' noticed at launch (fake → none)", h.events.some((e) => e.type === "proxy_changed" && e.from === "10.255.255.1:9" && e.to === ""), JSON.stringify(types(h)));

  // Real script runs on the live profile.
  const deps = { orchestrator, getSession: manager.getSession };
  scripts.startRun({ name: "qa-history ok", mode: "page", code: "return 1" }, [ID], deps);
  scripts.startRun({ name: "qa-history fail", mode: "page", code: "throw new Error('qa boom')" }, [ID], deps);
  await until(async () => {
    const t = types(await history());
    return t.includes("script_ok") && t.includes("script_failed");
  }, 20_000);
  h = await history();
  const ok = h.events.find((e) => e.type === "script_ok");
  const bad = h.events.find((e) => e.type === "script_failed");
  check("'script_ok' with the script name and ms", ok?.script === "qa-history ok" && Number.isFinite(ok?.ms), JSON.stringify(ok));
  check("'script_failed' with the message", /qa boom/.test(bad?.message || ""), JSON.stringify(bad));
  check("?type= filters", (await history("?type=script_ok,script_failed")).events.every((e) => e.type.startsWith("script_")));

  const r2 = await call("POST", `/api/sessions/${enc(ID)}/snapshots/${newest}/restore`);
  check("restore while running → applied now", r2.code === 200 && r2.json.applied === "now", r2.text);
  const jar = await orchestrator.live.get(ID).handle.rpc("cookies", {}, 10_000);
  check("…the cookies are in the live jar", ["snap_a", "snap_b", "qa_staged"].every((n) => jar.some((c) => c.name === n)), jar.map((c) => c.name).join(","));

  await sleep(1500);
  await orchestrator.stop(ID);
  await until(async () => types(await history()).includes("closed"), 15_000);
  h = await history();
  const closed = h.events.find((e) => e.type === "closed");
  check("'closed' event: success, closed by user, a duration", closed?.status === "success" && closed?.closedByUser === true && closed?.durationMs > 0, JSON.stringify(closed));
  check("events are newest first", h.events.every((e, i) => !i || e.at <= h.events[i - 1].at));

  const snapped = await until(async () => {
    const s = (await call("GET", `/api/sessions/${enc(ID)}/snapshots`)).json;
    return s[0]?.file.startsWith(new Date().toISOString().slice(0, 10));
  }, 12_000);
  const after = (await call("GET", `/api/sessions/${enc(ID)}/snapshots`)).json;
  check("a snapshot was taken on the clean close", snapped && after[0].count >= 3, JSON.stringify(after[0]));
  check("only the newest 5 are kept (2020-01-01 dropped)", after.length === 5 && !after.some((s) => s.file.startsWith("2020-01-01")), after.map((s) => s.file).join(" "));

  await until(async () => (await history()).stats.workSeconds > 0, 3000);
  h = await history();
  const rec = manager.getSession(ID);
  check("stats: launchCount 1 and workSeconds from the record", h.stats.launchCount === 1 && h.stats.workSeconds === (rec.workSeconds || 0), JSON.stringify(h.stats));
  check("stats: lastExitIp/lastCountry mirror the record", h.stats.lastExitIp === (rec.lastExitIp || null) && h.stats.lastCountry === (rec.lastCountry || null), JSON.stringify(h.stats));

  // The cap: 520 filler lines, then one real event → the file is rewritten to the last 500.
  fs.appendFileSync(HIST, Array.from({ length: 520 }, (_, i) => JSON.stringify({ at: "2020-01-01T00:00:00.000Z", type: "filler", i })).join("\n") + "\n");
  orchestrator.log("info", "FINGERPRINT", `Rebuilt fingerprint for ${ID}`, ID);
  const lines = fs.readFileSync(HIST, "utf8").split("\n").filter(Boolean);
  check("capped at 500 lines, newest kept", lines.length === 500 && JSON.parse(lines[499]).type === "fingerprint_changed", `${lines.length} lines`);

  const tr = await trash();
  const re = await call("POST", `/api/trash/${enc(ID)}/restore`);
  h = await history();
  check("'trashed' then 'restored' events", tr.code === 200 && re.code === 200 && types(h)[0] === "restored" && types(h)[1] === "trashed", types(h).slice(0, 3).join(","));
}

server.listen(PORT, "127.0.0.1", async () => {
  try {
    await main();
  } catch (e) {
    check("UNCAUGHT", false, e.stack);
  } finally {
    try {
      if (orchestrator.live.has(ID)) await orchestrator.stop(ID);
      await until(() => !orchestrator.live.has(ID), 10_000);
      await purge();
    } catch (e) {
      console.error("cleanup:", e.message);
    }
    for (const f of [COOKIES, path.join(DATA, "cookies", `${ID}.import.json`)]) fs.rmSync(f, { force: true });
    const left = [...manager.listSessions(), ...manager.listTrash()].some((x) => x.id === ID);
    check("cleanup: purged, history and snapshots forgotten", !left && !fs.existsSync(HIST) && !fs.existsSync(SNAPS));
    server.close();
    for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail && (!r.ok || /ms$/.test(r.detail)) ? "  — " + r.detail : ""}`);
    console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }
});
