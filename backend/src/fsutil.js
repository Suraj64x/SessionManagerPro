// Safe JSON files for stores that more than one process may touch (the app's server, a second
// server started by hand, a test run). Every writer used to share one "<file>.tmp", so two
// simultaneous writes interleaved their bytes and corrupted the store.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Windows can hold a file for a moment (a reader, antivirus, the indexer): retry briefly. */
function retrying(fn, tries = 25) {
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (err) {
      if (!RETRY_CODES.has(err.code) || i >= tries) throw err;
      sleepSync(40);
    }
  }
}

/** Writes `data` to `file` atomically: a temp name no other writer can share, then a rename. */
function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    retrying(() => fs.renameSync(tmp, file));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Where the first complete top-level JSON object or array in `text` ends, or -1. */
function firstValueEnd(text) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if ((c === "}" || c === "]") && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * Reads a JSON file. A file damaged by an interleaved write keeps its last whole write as the
 * first complete value: that is recovered (and reported through onRecover). Falls back to
 * `<file>.bak`. Never returns a guess: a store read as empty would be written back empty.
 */
function readJsonSafe(file, { fallback, onRecover } = {}) {
  if (!fs.existsSync(file)) return typeof fallback === "function" ? fallback() : fallback;
  const text = retrying(() => fs.readFileSync(file, "utf8"));
  try {
    return JSON.parse(text);
  } catch (err) {
    const end = firstValueEnd(text);
    if (end > 0) {
      try {
        const value = JSON.parse(text.slice(0, end));
        onRecover?.(`${path.basename(file)} had ${text.length - end} stray bytes after its last whole write; recovered`);
        return value;
      } catch {
        // fall through to the backup
      }
    }
    const bak = `${file}.bak`;
    if (fs.existsSync(bak)) {
      const value = JSON.parse(retrying(() => fs.readFileSync(bak, "utf8")));
      onRecover?.(`${path.basename(file)} was unreadable (${err.message}); using ${path.basename(bak)}`);
      return value;
    }
    throw new Error(`${path.basename(file)} is damaged and has no backup: ${err.message}`);
  }
}

/**
 * A cross-process lock around a read-modify-write: "<file>.lock", created exclusively, holding
 * the owner's pid. A lock older than `staleMs` (a crashed holder) is taken over.
 */
async function withFileLock(file, fn, { waitMs = 20_000, staleMs = 30_000 } = {}) {
  const lockPath = `${file}.lock`;
  const token = `${process.pid}:${crypto.randomBytes(6).toString("hex")}`;
  const deadline = Date.now() + waitMs;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (;;) {
    try {
      fs.writeFileSync(lockPath, token, { flag: "wx" });
      break;
    } catch (err) {
      if (err.code !== "EEXIST" && !RETRY_CODES.has(err.code)) throw err;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > staleMs) fs.rmSync(lockPath, { force: true });
      } catch {
        // gone meanwhile: retry at once
      }
      if (Date.now() > deadline) throw new Error(`${path.basename(file)} is busy (another SessionManagerPro process holds it); try again`);
      await sleep(25 + Math.random() * 25);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      if (fs.readFileSync(lockPath, "utf8") === token) fs.rmSync(lockPath, { force: true });
    } catch {
      // already released or taken over as stale
    }
  }
}

module.exports = { writeFileAtomic, readJsonSafe, withFileLock, firstValueEnd };
