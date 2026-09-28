// Checks backend/src/fsutil.js: atomic writes under concurrent writers from several processes,
// recovery of an interleaved file, and the cross-process lock. Scratch files only.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { fork } = require("child_process");
const { writeFileAtomic, readJsonSafe, withFileLock } = require("../src/fsutil");

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smp-fsutil-"));
const file = path.join(dir, "store.json");

// Child mode: hammer the file with atomic writes, or do locked read-modify-write increments.
if (process.argv[2] === "writer") {
  const [, , , target, id, mode] = process.argv;
  (async () => {
    for (let i = 0; i < 60; i++) {
      if (mode === "lock") {
        await withFileLock(target, () => {
          const cur = readJsonSafe(target, { fallback: { n: 0 } });
          writeFileAtomic(target, JSON.stringify({ n: cur.n + 1, pad: "x".repeat(2000 + Number(id) * 3000) }));
        });
      } else {
        writeFileAtomic(target, JSON.stringify({ writer: id, i, pad: "y".repeat(1000 + Number(id) * 5000) }));
      }
    }
    process.exit(0);
  })();
  return;
}

const runWriters = (mode, n) =>
  Promise.all(
    Array.from({ length: n }, (_, i) =>
      new Promise((res) => fork(__filename, ["writer", file, String(i), mode]).on("exit", res))
    )
  );

(async () => {
  try {
    // 1. Four processes writing different-length documents at once: always one whole document.
    await runWriters("plain", 4);
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {}
    check("concurrent atomic writes leave one whole JSON document", parsed && typeof parsed.writer === "string");
    check("no temp files left behind", fs.readdirSync(dir).every((f) => !f.endsWith(".tmp")), fs.readdirSync(dir).join(","));

    // 2. Locked read-modify-write from four processes: no lost updates.
    fs.rmSync(file, { force: true });
    await runWriters("lock", 4);
    const n = JSON.parse(fs.readFileSync(file, "utf8")).n;
    check("cross-process lock: 4 × 60 increments all land", n === 240, `n=${n}`);
    check("lock file released", !fs.existsSync(file + ".lock"));

    // 3. A file damaged exactly like the incident: a whole document plus a stray tail.
    fs.writeFileSync(file, JSON.stringify({ sessions: { a: 1 } }, null, 2) + '"stray": "tail"\n  }\n}');
    let note = null;
    const rec = readJsonSafe(file, { onRecover: (m) => (note = m) });
    check("interleaved file: last whole write recovered", rec?.sessions?.a === 1 && /recovered/.test(note || ""), note);

    // 4. Garbage with a backup: the backup is used, never an empty store.
    fs.writeFileSync(file, "{ not json");
    fs.writeFileSync(file + ".bak", JSON.stringify({ sessions: { b: 2 } }));
    check("unreadable file falls back to .bak", readJsonSafe(file)?.sessions?.b === 2);
    fs.rmSync(file + ".bak");
    let threw = false;
    try {
      readJsonSafe(file, { fallback: { sessions: {} } });
    } catch {
      threw = true;
    }
    check("unreadable file without backup throws (never reads as empty)", threw);

    // 5. A stale lock (crashed holder) is taken over.
    fs.writeFileSync(file + ".lock", "999999:dead");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(file + ".lock", old, old);
    const t0 = Date.now();
    await withFileLock(file, () => {});
    check("stale lock taken over quickly", Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
  } catch (e) {
    check("UNCAUGHT", false, e.stack);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${!r.ok && r.detail ? "  — " + r.detail : ""}`);
    console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }
})();
