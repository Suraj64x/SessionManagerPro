// Organize: the "statuses" and "folders" settings, the status/folder bulk actions, the
// label/folder/pinned PATCH fields and the label migration. Starts the server in-process on
// 3011 and touches only qa-organize-* records and list entries; the two settings are put
// back exactly as found. No browser is launched.
//
//   node backend/test/organize_check.js
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
process.chdir(ROOT);
process.argv.push("--no-open", "--no-terminal");
const PORT = 3011;
process.env.PORT = String(PORT);

// Snapshot before the server starts: its label migration may append labels that other
// teams' qa profiles carry, and those must not outlive this check.
const fs = require("fs");
let before = {};
try {
  before = JSON.parse(fs.readFileSync(path.join(ROOT, "data/app.json"), "utf8"));
} catch {}

const { server } = require(path.join(ROOT, "backend/src/server.js"));
const manager = require(path.join(ROOT, "backend/src/manager.js"));
const organize = require(path.join(ROOT, "backend/src/features/organize.js"));

const ID = "qa-organize-1";
const FOLDER = "qa-organize-folder";
const STATUS = "qa-organize-st";
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
let original = null;

async function call(method, p, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method,
    headers: { Host: `127.0.0.1:${PORT}`, "X-SMP": "1", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { code: res.status, json: await res.json().catch(() => null) };
}

async function main() {
  const app = await call("GET", "/api/app");
  original = { statuses: app.json.statuses, folders: app.json.folders };
  check(
    "GET /api/app has statuses [{name,color}] and folders [string]",
    Array.isArray(original.statuses) &&
      original.statuses.length >= 1 &&
      original.statuses.every((s) => typeof s.name === "string" && /^#[0-9a-f]{6}$/.test(s.color)) &&
      Array.isArray(original.folders),
    JSON.stringify(original).slice(0, 120)
  );

  const bad = async (name, body) => {
    const r = await call("PATCH", "/api/app", body);
    check(`400: ${name}`, r.code === 400 && r.json?.error, `HTTP ${r.code} ${r.json?.error || ""}`);
  };
  await bad("empty status list", { statuses: [] });
  await bad("31 statuses", { statuses: Array.from({ length: 31 }, (_, i) => ({ name: `s${i}`, color: "#000000" })) });
  await bad("duplicate status, other case", { statuses: [{ name: "Ready", color: "#000000" }, { name: "ready", color: "#111111" }] });
  await bad("status name over 24", { statuses: [{ name: "x".repeat(25), color: "#000000" }] });
  await bad("status colour not #rrggbb", { statuses: [{ name: "X", color: "red" }] });
  await bad("folders not a list", { folders: "a" });
  await bad("duplicate folder", { folders: ["A", "a"] });
  await bad("folder name over 40", { folders: ["x".repeat(41)] });
  const still = (await call("GET", "/api/app")).json;
  check("a refused PATCH changes nothing", JSON.stringify(still.statuses) === JSON.stringify(original.statuses));

  const withQa = await call("PATCH", "/api/app", {
    statuses: [...original.statuses, { name: `  ${STATUS}  `, color: "#ABCDEF" }],
    folders: [...original.folders, FOLDER],
  });
  const added = withQa.json?.statuses?.at(-1);
  check("PATCH statuses trims the name and lowercases the colour", withQa.code === 200 && added?.name === STATUS && added?.color === "#abcdef", JSON.stringify(added));
  check("PATCH folders appends", withQa.json?.folders?.at(-1) === FOLDER);

  await manager.createSessionRecord(ID, {
    proxy: { scheme: "http", host: "10.255.255.1", port: 9, username: "", password: "" },
    fingerprint: { qa: true },
  });
  const bulk = (action, value) => call("POST", "/api/sessions/bulk", { ids: [ID], action, value });

  let r = await bulk("status", STATUS);
  check("bulk status sets the label", r.json?.ok === 1 && manager.getSession(ID).label === STATUS, JSON.stringify(r.json));
  r = await bulk("status", "");
  check("bulk status '' clears it", r.json?.ok === 1 && !manager.getSession(ID).label);
  r = await bulk("folder", "qa-organize-nope");
  check("bulk folder refuses a folder not in the list", r.json?.ok === 0 && /unknown folder/.test(r.json?.failed?.[0]?.error), JSON.stringify(r.json));
  r = await bulk("folder", FOLDER);
  check("bulk folder moves into a listed folder", r.json?.ok === 1 && manager.getSession(ID).folder === FOLDER);
  r = await bulk("folder", "");
  check("bulk folder '' unfiles", r.json?.ok === 1 && !manager.getSession(ID).folder);

  r = await call("PATCH", `/api/sessions/${ID}`, { label: STATUS, folder: FOLDER, pinned: true });
  const rec = manager.getSession(ID);
  check("PATCH label/folder/pinned", r.code === 200 && rec.label === STATUS && rec.folder === FOLDER && rec.pinned === true, JSON.stringify({ label: rec.label, folder: rec.folder, pinned: rec.pinned }));
  const listed = (await call("GET", "/api/sessions")).json.find((s) => s.id === ID);
  check("GET /api/sessions carries label, folder, pinned", listed?.label === STATUS && listed?.folder === FOLDER && listed?.pinned === true);

  // Migration, against stubs: no real settings file is touched.
  let written = null;
  const stub = {
    appSettings: {
      register() {},
      read: () => ({ statuses: organize.DEFAULT_STATUSES, folders: [] }),
      write: (next) => (written = next),
    },
    manager: { listSessions: () => [{ label: "Legacy" }, { label: "new" }, { label: "" }, { label: "Legacy" }, {}] },
    bulk: {},
    readApp: () => ({ folders: [] }),
    log() {},
  };
  organize({}, stub);
  await new Promise((res) => setImmediate(res));
  const names = written?.statuses?.map((s) => s.name) || [];
  check(
    "migration appends unknown labels once, grey, case-insensitively",
    names.length === 6 && names[5] === "Legacy" && written.statuses[5].color === "#94a3b8",
    JSON.stringify(names)
  );
  written = null;
  stub.manager.listSessions = () => [{ label: "ready" }];
  organize({}, stub);
  await new Promise((res) => setImmediate(res));
  check("migration writes nothing when every label is known", written === null);
  check("stub registered status and folder bulk actions", typeof stub.bulk.status === "function" && typeof stub.bulk.folder === "function");
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
    if (original) {
      const restore = { statuses: before.statuses || original.statuses, folders: before.folders || original.folders };
      const back = await call("PATCH", "/api/app", restore).catch(() => ({ code: 0 }));
      check("cleanup: statuses and folders restored", back.code === 200 && JSON.stringify(back.json.statuses) === JSON.stringify(restore.statuses));
    }
    const left = [...manager.listSessions(), ...manager.listTrash()].some((x) => x.id === ID);
    check(`cleanup: ${ID} trashed and purged`, !left);
    server.close();
    for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail && !r.ok ? "  — " + r.detail : ""}`);
    console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }
});
