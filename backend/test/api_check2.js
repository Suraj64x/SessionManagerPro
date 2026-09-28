// Round-2 checks: crash routes, stricter ids, app settings, CSV import, trash conflicts,
// quit and single-instance (in child processes). Restores AccountFile.csv and data/app.json.
process.chdir(require("path").resolve(__dirname, "..", ".."));
process.argv.push("--no-open", "--no-terminal");
const fs = require("fs");
const http = require("http");
const { spawn } = require("child_process");
const { server } = require("../src/server.js");
const manager = require("../src/manager.js");

const PORT = 3994;
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
const ACC = "resources/AccountFile.csv";
const APP = "data/app.json";
const accBackup = fs.existsSync(ACC) ? fs.readFileSync(ACC) : null;
const appBackup = fs.existsSync(APP) ? fs.readFileSync(APP) : null;

function req(port, path, { method = "GET", body } = {}) {
  return new Promise((resolve) => {
    const h = { Host: `127.0.0.1:${port}` };
    if (body !== undefined) h["Content-Type"] = "application/json";
    if (method !== "GET") h["X-SMP"] = "1";
    const r = http.request({ host: "127.0.0.1", port, path, method, headers: h }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(d); } catch {}
        resolve({ code: res.statusCode, json, text: d });
      });
    });
    r.on("error", (e) => resolve({ code: 0, error: e.message }));
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

const startChild = (port) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ["backend/src/server.js", "--no-open", "--no-terminal"], {
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => {
      out += c;
      if (out.includes("Server running") || out.includes("already running")) resolve({ child, out: () => out });
    });
    child.on("exit", () => resolve({ child, out: () => out }));
  });

const exited = (child, ms) =>
  new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const t = setTimeout(() => resolve(null), ms);
    child.on("exit", (code) => (clearTimeout(t), resolve(code)));
  });

const created = new Set();

async function main() {
  // --- one bad request must not take the server down
  const blank = await req(PORT, "/api/sessions/%20/cookies");
  check("GET cookies for a blank id returns an error, not a crash", blank.code >= 400 && blank.code < 600, `HTTP ${blank.code}`);
  check("server still alive afterwards", (await req(PORT, "/api/pool")).code === 200);
  const blankTrash = await req(PORT, "/api/trash/%20", { method: "DELETE" });
  check("DELETE trash/<blank> is an error, not a crash", blankTrash.code >= 400, `HTTP ${blankTrash.code}`);
  check("still alive", (await req(PORT, "/api/pool")).code === 200);

  // --- ids Windows would fold onto another profile's folder
  for (const bad of ["qa2-alice.", "..", "CON", "lpt1.txt"]) {
    const r = await req(PORT, "/api/sessions/create", { method: "POST", body: { name: bad } });
    check(`create refuses ${JSON.stringify(bad)}`, r.code === 400, r.json?.error);
  }

  // --- app settings round-trip (read by the tray launcher)
  const a0 = await req(PORT, "/api/app");
  check("GET /api/app defaults to quit", a0.json?.closeBehavior === ((appBackup && JSON.parse(appBackup).closeBehavior) || "quit"));
  const a1 = await req(PORT, "/api/app", { method: "PATCH", body: { closeBehavior: "tray" } });
  check("PATCH closeBehavior=tray persists", a1.json?.closeBehavior === "tray" && JSON.parse(fs.readFileSync(APP, "utf8")).closeBehavior === "tray");
  check("PATCH rejects an unknown behaviour", (await req(PORT, "/api/app", { method: "PATCH", body: { closeBehavior: "explode" } })).code === 400);

  // --- CSV import creates the profiles it lists
  const csv = "Email\nqa2-csv-1@example.com\nqa2-csv-2@example.com\n";
  const imp = await req(PORT, "/api/accounts/import", { method: "POST", body: { csvContent: csv } });
  ["qa2-csv-1@example.com", "qa2-csv-2@example.com"].forEach((id) => created.add(id));
  check("CSV import creates 2 profiles", imp.json?.created === 2 && manager.getSession("qa2-csv-1@example.com"), imp.text.slice(0, 120));
  const imp2 = await req(PORT, "/api/accounts/import", { method: "POST", body: { csvContent: csv } });
  check("re-import creates none, reports 2 existing", imp2.json?.created === 0 && imp2.json?.existing === 2);

  // --- auto-naming skips names held by the trash
  const b = await req(PORT, "/api/sessions/auto", { method: "POST", body: { count: 1, prefix: "qa2-auto" } });
  const first = b.json?.created?.[0]?.id;
  if (first) created.add(first);
  await req(PORT, `/api/sessions/${encodeURIComponent(first)}`, { method: "DELETE" });
  const b2 = await req(PORT, "/api/sessions/auto", { method: "POST", body: { count: 1, prefix: "qa2-auto" } });
  const second = b2.json?.created?.[0]?.id;
  if (second) created.add(second);
  check("auto-name after trashing picks a free name", b2.code === 200 && second && second !== first, `${first} → ${second} (${b2.json?.error || ""})`);

  // --- restore refuses when its proxy was taken while it sat in the trash
  const victim = manager.listTrash().find((t) => t.id === first);
  const other = manager.getSession(second);
  if (victim && other) {
    const steal = await req(PORT, `/api/sessions/${encodeURIComponent(second)}`, {
      method: "PATCH",
      body: { proxy: { host: victim.proxy.host, port: victim.proxy.port } },
    });
    check("PATCH cannot take a proxy reserved by a trashed profile", steal.code === 409, steal.json?.error);
  }

  // --- SOCKS scheme survives into the store
  const s = await req(PORT, "/api/sessions/create", { method: "POST", body: { name: "qa2-socks", proxy: "socks5://u:p@10.9.8.7:1080" } });
  created.add("qa2-socks");
  check("SOCKS5 scheme is stored", manager.getSession("qa2-socks")?.proxy?.scheme === "socks5", JSON.stringify(s.json?.proxy));
}

async function processChecks() {
  // --- quit: closes and exits cleanly
  const a = await startChild(3993);
  const q = await req(3993, "/api/app/quit", { method: "POST", body: {} });
  const code = await exited(a.child, 8000);
  check("POST /api/app/quit → server exits with code 0", q.code === 200 && code === 0, `exit ${code}`);

  // --- single instance for npm start: second copy says so and exits 0
  const b = await startChild(3992);
  const c = await startChild(3992);
  const code2 = await exited(c.child, 5000);
  check("second server on the same port reports 'already running' and exits 0", code2 === 0 && c.out().includes("already running"), c.out().trim().slice(0, 80));
  check("first server unaffected", (await req(3992, "/api/pool")).code === 200);
  b.child.kill();
}

server.listen(PORT, "127.0.0.1", async () => {
  try {
    await main();
    await processChecks();
  } catch (e) {
    check("UNCAUGHT", false, e.stack);
  } finally {
    for (const id of created) {
      try { await manager.trashSession(id); } catch {}
      try { await manager.purgeTrash({ id }); } catch {}
    }
    if (accBackup) fs.writeFileSync(ACC, accBackup); else fs.rmSync(ACC, { force: true });
    if (appBackup) fs.writeFileSync(APP, appBackup); else fs.rmSync(APP, { force: true });
    const left = [...manager.listSessions(), ...manager.listTrash()].filter((x) => x.id.startsWith("qa2-")).length;
    check("cleanup: no qa2-* profiles left, CSV and app.json restored", left === 0 && (!accBackup || fs.readFileSync(ACC).equals(accBackup)), `${left} left`);
    for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${!r.ok && r.detail ? "  — " + r.detail : ""}`);
    console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }
});
