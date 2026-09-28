const fs = require("fs");
const path = require("path");
const { generateFingerprint, applyFingerprint, buildFingerprint } = require("./fingerprint");
const { launchWorker, deriveSeed } = require("./worker_runner");
const { writeFileAtomic, readJsonSafe, withFileLock } = require("./fsutil");

// Point ROOT to the workspace root (two levels up from backend/src)
const ROOT = path.resolve(__dirname, "..", "..");
const DATA_DIR = path.join(ROOT, "data");
const STORE_PATH = path.join(DATA_DIR, "sessions.json");
const PROFILES_DIR = path.join(DATA_DIR, "profiles");
const PROXY_DIR = path.join(ROOT, "resources", "proxies");
const PROXY_FILE = fs.existsSync(path.join(PROXY_DIR, "proxies.txt"))
  ? path.join(PROXY_DIR, "proxies.txt")
  : path.join(PROXY_DIR, "proxiesgood.txt");
const ACCOUNT_FILE = path.join(ROOT, "resources", "AccountFile.csv");
const COOKIES_DIR = path.join(DATA_DIR, "cookies");
const TRASH_DIR = path.join(DATA_DIR, "trash");
const TRASH_TTL_MS = 48 * 60 * 60 * 1000;

// ponytail: global lock, per-account locks if create-throughput matters
// In-process queue plus a lock file: a second server or a test run touching the same data/
// waits its turn instead of losing (or, before, corrupting) this one's writes.
let lock = Promise.resolve();
function withLock(fn) {
  const run = lock.then(
    () => withFileLock(STORE_PATH, fn),
    () => withFileLock(STORE_PATH, fn)
  );
  lock = run.catch(() => {});
  return run;
}

/** Sanitises an id for lookups. Lenient on purpose: existing profiles must stay reachable. */
function safeId(id) {
  const cleaned = String(id).trim().replace(/[<>:"/\\|?*]/g, "_").slice(0, 120);
  if (!cleaned) throw new Error("session id is empty");
  // Dot-only names walk out of profiles/ — never acceptable, old or new.
  if (/^[. ]+$/.test(cleaned)) throw new Error("session id cannot be only dots or spaces");
  return cleaned;
}

/** Validates a NEW profile name, which also becomes a folder name. */
function newId(id) {
  const sid = safeId(id);
  // Windows drops trailing dots and spaces from path segments, so "alice." would open
  // alice's own folder and silently share its cookies; device names like CON aren't folders.
  if (/[. ]$/.test(sid)) throw new Error("a profile name cannot end with a dot or a space");
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(sid)) throw new Error(`"${sid}" is a reserved name on Windows`);
  return sid;
}

/** Windows paths are case-insensitive: "Alice" and "alice" would share one folder and cookie file. */
function caseClash(store, sid) {
  const lower = sid.toLowerCase();
  return reserved(store).find((r) => r.id !== sid && r.id.toLowerCase() === lower) || null;
}

function cookiePath(id) {
  return path.join(COOKIES_DIR, `${safeId(id)}.json`);
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function parseCsvAccounts() {
  if (!fs.existsSync(ACCOUNT_FILE)) return [];
  return parseCsvText(fs.readFileSync(ACCOUNT_FILE, "utf8"));
}

/** Names from CSV text with an Email column (header matched case-insensitively). */
function parseCsvText(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .filter((l) => l.trim());
  if (!lines.length) throw new Error("the CSV is empty");
  const headers = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const iEmail = headers.indexOf("email");
  if (iEmail < 0) throw new Error("the CSV needs an Email column");
  const names = [];
  for (const line of lines.slice(1)) {
    const name = (splitCsvLine(line)[iEmail] || "").trim();
    if (name) names.push(name);
  }
  return names;
}

/** The engine for new profiles (Settings → Browsers, data/app.json); the built-in one otherwise. */
function defaultBrowser() {
  try {
    const app = readJsonSafe(path.join(DATA_DIR, "app.json"), { fallback: {} });
    return typeof app.defaultBrowser === "string" && app.defaultBrowser ? app.defaultBrowser : "stealth-firefox";
  } catch {
    return "stealth-firefox";
  }
}

function readStore() {
  return readJsonSafe(STORE_PATH, {
    fallback: () => ({ sessions: {} }),
    onRecover: (msg) => console.warn(`[store] ${msg}`),
  });
}

// A rolling copy of the last good store, for readJsonSafe to fall back on; at most once a minute.
let lastBackup = 0;

function writeStore(store) {
  const text = JSON.stringify(store, null, 2);
  writeFileAtomic(STORE_PATH, text);
  if (Date.now() - lastBackup > 60_000) {
    lastBackup = Date.now();
    try {
      writeFileAtomic(`${STORE_PATH}.bak`, text);
    } catch {
      // the backup is best effort
    }
  }
  try {
    require("./sheet").writeSessionSheet(Object.values(store.sessions || {}));
  } catch {
    // sheet is a view; do not fail the save
  }
}

const PROXY_SCHEMES = new Set(["http", "https", "socks4", "socks5"]);
const redact = (line) => String(line).replace(/\/\/[^@/]*@/, "//***@");

/**
 * One proxy line → { scheme, host, port, username, password, changeIpUrl, name }.
 * Accepts scheme://user:pass@host:port, host:port, host:port:user:pass and
 * user:pass@host:port, each optionally followed by [changeIpUrl] and/or {name}.
 * A line without a scheme gets `defaultScheme`.
 */
function parseProxy(line, defaultScheme = "http") {
  // The password must not reach a log or a 400 in any of the accepted layouts.
  const shown = redact(line)
    .replace(/^([^\s:@/]*):[^\s@/]*@/, "$1:***@")
    .replace(/^([^\s:@/]+:\d+:[^\s:@/]+):[^\s[{]*/, "$1:***");
  const bad = (why = "expected scheme://user:pass@host:port") => new Error(`invalid proxy "${shown}" — ${why}`);
  const fallback = PROXY_SCHEMES.has(defaultScheme) ? defaultScheme : "http";

  let body = String(line).trim();
  let changeIpUrl = "";
  let name = "";
  // Trailing [url] and {name}, in either order.
  for (let i = 0; i < 2; i++) {
    const m = body.match(/\s*(?:\[([^\]]*)\]|\{([^}]*)\})$/);
    if (!m) break;
    if (m[1] !== undefined) changeIpUrl = m[1].trim();
    else name = m[2].trim().slice(0, 60);
    body = body.slice(0, -m[0].length);
  }
  if (changeIpUrl && !/^https?:\/\/\S+$/i.test(changeIpUrl)) throw bad("the change-IP URL must be http(s)");

  const proxy = { scheme: fallback, host: "", port: NaN, username: "", password: "", changeIpUrl, name };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(body)) {
    let u;
    try {
      u = new URL(body);
    } catch {
      throw bad();
    }
    const scheme = u.protocol.slice(0, -1).toLowerCase();
    Object.assign(proxy, {
      scheme: PROXY_SCHEMES.has(scheme) ? scheme : fallback,
      host: u.hostname,
      port: Number(u.port),
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
    });
  } else if (body.includes("@")) {
    const at = body.lastIndexOf("@");
    const [username, ...pw] = body.slice(0, at).split(":");
    const [host, port, ...rest] = body.slice(at + 1).split(":");
    if (rest.length) throw bad();
    Object.assign(proxy, { host, port: Number(port), username, password: pw.join(":") });
  } else {
    const [host, port, username, ...pw] = body.split(":");
    if (username !== undefined && !pw.length) throw bad(); // host:port:user without a password
    Object.assign(proxy, { host, port: Number(port), username: username || "", password: pw.join(":") });
  }
  // A bare "host:port" used to slip through URL as protocol + path with an empty host;
  // an empty host stored as a real proxy is dropped at launch, opening the browser on
  // the operator's own IP. Every layout ends here.
  if (!proxy.host || /[\s/]/.test(proxy.host) || !Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65535) {
    throw bad();
  }
  return proxy;
}

/**
 * The proxy library: data/proxies.json plus every line of resources/proxies/*.txt not in
 * it yet (by host:port). New txt lines get an id and are persisted, so the json is the one
 * source of truth and the txt files stay a plain import source. Entries in the json win.
 * Keys listed in data/proxies-removed.json (written by features/proxies on delete) are not
 * re-imported, or a deleted txt proxy would come back on the next load.
 */
function loadProxies() {
  const file = path.join(DATA_DIR, "proxies.json");
  let library = [];
  let persist = true;
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(parsed)) library = parsed;
    } catch (err) {
      // Never overwrite a file we could not read: serve the txt lines unsaved instead.
      persist = false;
      console.warn(`[proxies] data/proxies.json is unreadable, ids will not be stable: ${err.message}`);
    }
  }
  const seen = new Set(library.map(proxyKey));
  try {
    for (const key of JSON.parse(fs.readFileSync(path.join(DATA_DIR, "proxies-removed.json"), "utf8"))) seen.add(String(key));
  } catch {
    // nothing removed yet
  }
  const files = fs.existsSync(PROXY_DIR) ? fs.readdirSync(PROXY_DIR).filter((f) => f.endsWith(".txt")) : [];
  let added = 0;
  // One malformed line must not take down the whole resources endpoint, which the
  // panel would otherwise render as an authoritative "no proxies configured".
  loadProxies.warned ??= new Set();
  for (const name of files) {
    for (const raw of fs.readFileSync(path.join(PROXY_DIR, name), "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      let p;
      try {
        p = parseProxy(line);
      } catch (err) {
        if (!loadProxies.warned.has(err.message)) console.warn(`[proxies] skipping unusable line: ${err.message}`);
        loadProxies.warned.add(err.message);
        continue;
      }
      if (seen.has(proxyKey(p))) continue;
      seen.add(proxyKey(p));
      library.push({
        id: require("crypto").randomBytes(4).toString("hex"),
        name: p.name,
        scheme: p.scheme,
        host: p.host,
        port: p.port,
        username: p.username,
        password: p.password,
        changeIpUrl: p.changeIpUrl,
        notes: "",
        createdAt: new Date().toISOString(),
        check: null,
      });
      added += 1;
    }
  }
  if (added && persist) {
    writeFileAtomic(file, JSON.stringify(library, null, 2));
  }
  return library;
}

function proxyKey(p) {
  return `${p.host}:${p.port}`;
}

/** Live profiles plus trashed ones: both hold their proxy and fingerprint. */
function reserved(store) {
  return [...Object.values(store.sessions), ...Object.values(store.trash || {})];
}

/**
 * A random library proxy no profile (live or trashed) holds, as the launch fields only:
 * the library's id, name, notes and check must not end up inside a session record.
 * `onlyChecked` limits the draw to entries whose last check passed.
 */
function pickUnusedProxy(store, { onlyChecked = false } = {}) {
  const used = new Set(
    reserved(store).map((s) => s.proxy && proxyKey(s.proxy)).filter(Boolean),
  );
  const free = loadProxies().filter((p) => !used.has(proxyKey(p)) && (!onlyChecked || p.check?.ok === true));
  if (!free.length) throw new Error(`no ${onlyChecked ? "checked, " : ""}unused proxies left in the proxy library`);
  const p = free[Math.floor(Math.random() * free.length)];
  return { scheme: p.scheme || "http", host: p.host, port: Number(p.port), username: p.username || "", password: p.password || "" };
}

function pickUnusedFpt(store) {
  const { listFptFiles } = require("./fingerprint");
  const used = new Set(
    reserved(store).map((s) => s.fingerprintFile).filter(Boolean),
  );
  const free = listFptFiles().filter((f) => !used.has(f));
  if (!free.length) throw new Error("no unused fingerprints left in resources/fpts");
  return free[Math.floor(Math.random() * free.length)];
}

function createSessionRecord(id, extras = {}) {
  return withLock(async () => {
    const store = readStore();
    const existing = store.sessions[safeId(id)];
    if (existing) {
      if (extras.mustBeNew) throw new Error(`a profile named "${existing.id}" already exists`);
      return existing;
    }
    const sid = newId(id);
    if (store.trash?.[sid]) throw new Error(`"${sid}" is in the trash — restore it or empty the trash first`);
    const clash = caseClash(store, sid);
    if (clash) throw new Error(`"${sid}" differs from "${clash.id}" only by letter case — Windows would share their folders`);

    // An explicit proxy/fingerprint must not already belong to another profile, including a
    // trashed one (it keeps both reserved so it can be restored).
    if (extras.proxy && reserved(store).some((r) => r.proxy && proxyKey(r.proxy) === proxyKey(extras.proxy))) {
      throw new Error("that proxy is already bound to another profile");
    }
    if (extras.fingerprintFile) {
      const { listFptFiles } = require("./fingerprint");
      if (!listFptFiles().includes(extras.fingerprintFile)) throw new Error("unknown fingerprint file");
      if (reserved(store).some((r) => r.fingerprintFile === extras.fingerprintFile)) {
        throw new Error("that fingerprint is already bound to another profile");
      }
    }
    const proxy = extras.proxy || pickUnusedProxy(store);
    const fingerprintFile = extras.fingerprintFile || pickUnusedFpt(store);
    const seed = extras.seed || deriveSeed(sid);
    const record = {
      id: sid,
      email: extras.email || sid,
      seed,
      proxy,
      fingerprintFile,
      fingerprint: extras.fingerprint || (await buildFingerprint(fingerprintFile, proxy)),
      userDataDir: path.join(PROFILES_DIR, sid),
      // Which browser runs it (browsers.js); records from before this field are Stealth Firefox.
      browser: extras.browser || defaultBrowser(),
      // "block" (default) | "spoof": whether pages may read a position (Chromium / manual Firefox).
      geolocation: extras.geolocation || "block",
      // WebRTC behind a proxy (worker_runner.js ENGINES.stealth.prefs): "masked", the default, is
      // not stored, so a profile follows the default; "off" is.
      ...(extras.webrtc === "off" && { webrtc: "off" }),
      tabs: [],
      cookieCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(record.userDataDir, { recursive: true });
    store.sessions[sid] = record;
    writeStore(store);
    return record;
  });
}

/** Creates what it can; one bad name (or an empty pool) is reported, not fatal to the rest. */
async function ensureSessions(names) {
  const created = [];
  const existing = [];
  const skipped = [];
  for (const name of names) {
    try {
      const already = getSession(name);
      if (already) existing.push(already);
      else created.push(await createSessionRecord(name, { email: name }));
    } catch (err) {
      skipped.push({ name, error: err.message });
    }
  }
  return { created, existing, skipped };
}

function getSession(id) {
  return readStore().sessions[safeId(id)] || null;
}

function listSessions() {
  return Object.values(readStore().sessions);
}

function nextSessionIds(count, prefix = "session") {
  // Trashed profiles still own their names until purged.
  const existing = new Set(reserved(readStore()).map((s) => s.id.toLowerCase()));
  const ids = [];
  let n = 1;
  while (ids.length < count) {
    const id = `${prefix}-${n}`;
    if (!existing.has(id.toLowerCase())) ids.push(id);
    n += 1;
  }
  return ids;
}

function deleteSession(id) {
  return withLock(() => {
    const sid = safeId(id);
    const store = readStore();
    const rec = store.sessions[sid];
    if (!rec) return false;
    delete store.sessions[sid];
    writeStore(store);
    fs.rmSync(rec.userDataDir, { recursive: true, force: true });
    fs.rmSync(cookiePath(sid), { force: true });
    fs.rmSync(path.join(COOKIES_DIR, `${sid}.import.json`), { force: true });
    return true;
  });
}

async function syncSheetEdits() {
  const { readSessionSheet, writeSessionSheet } = require("./sheet");
  const rows = readSessionSheet();
  if (!rows) {
    writeSessionSheet(listSessions());
    return { updated: 0, created: 0 };
  }
  let updated = 0;
  let created = 0;
  for (const row of rows) {
    const name = (row.Name || row.Email || "").trim();
    if (!name || readStore().trash?.[name]) continue;
    let rec = getSession(name);
    if (!rec) {
      let proxy;
      try {
        proxy = row.Proxy ? parseProxy(row.Proxy) : undefined;
      } catch {
        proxy = undefined;
      }
      await createSessionRecord(name, { email: name, proxy });
      created += 1;
      continue;
    }
    const patch = {};
    if (row.Proxy) {
      try {
        const p = parseProxy(row.Proxy);
        const cur = rec.proxy || {};
        if (
          p.host !== cur.host ||
          Number(p.port) !== Number(cur.port) ||
          p.username !== cur.username ||
          p.password !== cur.password
        ) {
          patch.proxy = p;
        }
      } catch {
        // keep existing proxy if the cell is invalid
      }
    }
    if (row.Notes !== undefined && row.Notes !== (rec.notes || "")) {
      patch.notes = row.Notes;
    }
    if (Object.keys(patch).length) {
      await saveSessionPatch(name, patch);
      updated += 1;
    }
  }
  writeSessionSheet(listSessions());
  return { updated, created };
}

function saveSessionPatch(id, patch) {
  return withLock(() => {
    const sid = safeId(id);
    const store = readStore();
    const rec = store.sessions[sid];
    if (!rec) throw new Error(`unknown session: ${sid}`);
    // One proxy per profile, checked here under the lock: every caller (drawer, bulk assign,
    // templates, imports) checks freeness earlier, then waits on the network before saving.
    if (patch.proxy?.host) {
      const key = proxyKey(patch.proxy);
      const holder = reserved(store).find((r) => r.id !== sid && r.proxy && proxyKey(r.proxy) === key);
      if (holder) throw new Error(`that proxy is already bound to ${holder.id}`);
    }
    Object.assign(rec, patch, { updatedAt: new Date().toISOString() });
    store.sessions[sid] = rec;
    writeStore(store);
    return rec;
  });
}

async function openSession(id, opts = {}) {
  const record = getSession(id) || (await createSessionRecord(id));
  const initScriptsFile = require("./scripts").writeInitScripts(record);
  const handle = await launchWorker(record, { ...opts, initScriptsFile });

  // Fire-and-forget saves: the profile may have been deleted meanwhile.
  const save = (patch) => saveSessionPatch(record.id, patch).catch(() => {});
  handle.on("tabs", (tabs) => save({ tabs }));
  handle.on("cookies", (cookieCount) => save({ cookieCount }));
  handle.once("disconnected", () => save({ tabs: handle.tabs || [], cookieCount: handle.cookieCount || 0 }));

  // Not awaited: the store lock can be held for seconds (a batch create resolving geo), and
  // the caller must attach its "disconnected" listener before a window closed meanwhile fires it.
  save({ lastOpenedAt: new Date().toISOString() });
  handle.session = record;

  return handle;
}

async function openMany(ids, opts = {}) {
  const threads = Math.max(1, Number(opts.threads) || ids.length);
  const out = new Array(ids.length);
  let next = 0;
  let done = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= ids.length) return;
      out[i] = await openSession(ids[i], opts);
      done += 1;
      opts.onProgress?.(ids[i], done, ids.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(threads, ids.length) }, () => worker()));
  return out;
}

function listAllProxies() {
  const store = readStore();
  const assignedMap = new Map();
  for (const s of Object.values(store.sessions)) {
    if (s.proxy) assignedMap.set(proxyKey(s.proxy), s.id);
  }
  for (const s of Object.values(store.trash || {})) {
    if (s.proxy) assignedMap.set(proxyKey(s.proxy), `${s.id} (trash)`);
  }
  const proxies = loadProxies();
  return proxies.map((p) => {
    const key = proxyKey(p);
    const assignedSessionId = assignedMap.get(key) || null;
    return {
      key,
      id: p.id,
      name: p.name || "",
      scheme: p.scheme || "http",
      host: p.host,
      port: p.port,
      username: p.username || "",
      hasPassword: Boolean(p.password),
      changeIpUrl: p.changeIpUrl || "",
      notes: p.notes || "",
      createdAt: p.createdAt,
      check: p.check || null,
      isAssigned: Boolean(assignedSessionId),
      assignedTo: assignedSessionId,
      // Display only, and never with the password: the panel refers to a proxy by `key`
      // and the server looks the credentials up itself (see resolveProxyKey).
      url: `${p.scheme || "http"}://${p.username ? `${encodeURIComponent(p.username)}@` : ""}${p.host}:${p.port}`,
    };
  });
}

/** A record as the panel may see it: the proxy password never leaves the server. */
function publicRecord(rec) {
  if (!rec) return rec;
  const out = { ...rec, browser: rec.browser || "stealth-firefox", geolocation: rec.geolocation || "block", webrtc: rec.webrtc === "off" ? "off" : "masked" };
  if (rec.proxy) {
    const { password, ...proxy } = rec.proxy;
    out.proxy = { ...proxy, hasPassword: Boolean(password) };
  }
  return out;
}

/** The library entry for "host:port", with its credentials, in the shape a record stores. */
function resolveProxyKey(key) {
  const p = loadProxies().find((x) => proxyKey(x) === String(key || "").trim());
  if (!p) throw new Error("that proxy is not in the library any more");
  return { scheme: p.scheme || "http", host: p.host, port: Number(p.port), username: p.username || "", password: p.password || "" };
}

function listAllFingerprints() {
  const { listFptFiles, inspectFingerprint } = require("./fingerprint");
  const store = readStore();
  const assignedMap = new Map();
  for (const s of Object.values(store.sessions)) {
    if (s.fingerprintFile) assignedMap.set(s.fingerprintFile, s.id);
  }
  for (const s of Object.values(store.trash || {})) {
    if (s.fingerprintFile) assignedMap.set(s.fingerprintFile, `${s.id} (trash)`);
  }
  const files = listFptFiles();
  return files.map((file) => {
    const details = inspectFingerprint(file);
    const assignedSessionId = assignedMap.get(file) || null;
    return {
      ...details,
      isAssigned: Boolean(assignedSessionId),
      assignedTo: assignedSessionId,
    };
  });
}


/* ------------------------------------------------------------------ *
 * Trash: deleting moves a profile aside for 48h instead of destroying it
 * ------------------------------------------------------------------ */

/**
 * Right after a browser stops, Windows can still hold its profile folder for a moment
 * (EPERM/EBUSY on rename), so a move retries for up to ~3 s before giving up.
 */
function moveIfExists(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(err.code) || attempt >= 15) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}

function trashSession(id) {
  return withLock(() => {
    const sid = safeId(id);
    const store = readStore();
    const rec = store.sessions[sid];
    if (!rec) return false;
    const dir = path.join(TRASH_DIR, `${sid}-${Date.now()}`);
    try {
      moveIfExists(rec.userDataDir, path.join(dir, "profile"));
    } catch (err) {
      // Nothing moved: leave no empty trash folder behind, and keep the profile active.
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error(`couldn't move ${sid} to the trash — its browser folder is still in use; try again in a moment (${err.code})`);
    }
    moveIfExists(cookiePath(sid), path.join(dir, "cookies.json"));
    // A staged import must travel with the profile, or a new profile reusing the
    // name later would inherit someone else's cookies.
    moveIfExists(path.join(COOKIES_DIR, `${sid}.import.json`), path.join(dir, "import.json"));
    store.trash = store.trash || {};
    store.trash[sid] = { ...rec, trashDir: dir, deletedAt: new Date().toISOString() };
    delete store.sessions[sid];
    writeStore(store);
    return true;
  });
}

function restoreSession(id) {
  return withLock(() => {
    const sid = safeId(id);
    const store = readStore();
    const rec = store.trash?.[sid];
    if (!rec) throw new Error("not in the trash");
    if (store.sessions[sid]) throw new Error(`a profile named "${sid}" already exists`);
    const clash = Object.values(store.sessions).find((s) => s.id.toLowerCase() === sid.toLowerCase());
    if (clash) throw new Error(`"${clash.id}" now uses the same folder name (letters differ only by case)`);
    const { trashDir, deletedAt, ...record } = rec;
    if (!fs.existsSync(path.join(trashDir, "profile"))) {
      throw new Error("its browser data is missing from the trash folder");
    }
    const others = Object.values(store.sessions);
    if (record.proxy && others.some((s) => s.proxy && proxyKey(s.proxy) === proxyKey(record.proxy))) {
      throw new Error("its proxy is now bound to another profile");
    }
    if (record.fingerprintFile && others.some((s) => s.fingerprintFile === record.fingerprintFile)) {
      throw new Error("its fingerprint is now bound to another profile");
    }
    if (fs.existsSync(record.userDataDir)) {
      throw new Error(`a folder already exists at ${record.userDataDir}`);
    }
    moveIfExists(path.join(trashDir, "profile"), record.userDataDir);
    moveIfExists(path.join(trashDir, "cookies.json"), cookiePath(sid));
    moveIfExists(path.join(trashDir, "import.json"), path.join(COOKIES_DIR, `${sid}.import.json`));
    fs.rmSync(trashDir, { recursive: true, force: true });
    delete store.trash[sid];
    store.sessions[sid] = { ...record, updatedAt: new Date().toISOString() };
    writeStore(store);
    return store.sessions[sid];
  });
}

function listTrash() {
  return Object.values(readStore().trash || {}).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

/** Permanently removes trashed profiles: one id, or everything older than `maxAgeMs`. */
function purgeTrash({ id, maxAgeMs } = {}) {
  return withLock(() => {
    const store = readStore();
    const trash = store.trash || {};
    const cutoff = maxAgeMs === undefined ? Infinity : Date.now() - maxAgeMs;
    const doomed = Object.values(trash).filter((r) =>
      id !== undefined ? r.id === safeId(id) : new Date(r.deletedAt).getTime() < cutoff
    );
    const purged = [];
    for (const r of doomed) {
      try {
        fs.rmSync(r.trashDir, { recursive: true, force: true, maxRetries: 3 });
        delete trash[r.id];
        purged.push(r.id);
      } catch {
        // Locked (e.g. a file still open). It stays listed and is retried next time.
      }
    }
    if (purged.length) {
      store.trash = trash;
      writeStore(store);
    }
    return purged;
  });
}

/* ------------------------------------------------------------------ *
 * Clone: same notes/tags/start pages, fresh proxy and fingerprint
 * ------------------------------------------------------------------ */

async function cloneSession(id, name, { withCookies = false } = {}) {
  const src = getSession(id);
  if (!src) throw new Error("source profile not found");
  const sid = newId(name);
  const copy = await createSessionRecord(sid, { email: sid, mustBeNew: true });
  const patch = {};
  for (const k of ["notes", "tags", "label", "color", "startUrls", "browser", "geolocation", "webrtc"]) if (src[k] !== undefined) patch[k] = src[k];
  if (withCookies && fs.existsSync(cookiePath(src.id))) {
    // Staged, not written into the profile: the worker applies it on first launch.
    fs.copyFileSync(cookiePath(src.id), path.join(COOKIES_DIR, `${copy.id}.import.json`));
  }
  return saveSessionPatch(copy.id, patch);
}

/* ------------------------------------------------------------------ *
 * Cookies: Playwright JSON, EditThisCookie/Cookie-Editor JSON, or Netscape txt
 * ------------------------------------------------------------------ */

function parseNetscape(text) {
  const out = [];
  for (let line of text.split(/\r?\n/)) {
    let httpOnly = false;
    if (line.startsWith("#HttpOnly_")) {
      httpOnly = true;
      line = line.slice(10);
    } else if (!line.trim() || line.startsWith("#")) {
      continue;
    }
    const f = line.split("\t");
    if (f.length < 7) continue;
    out.push({
      domain: f[0],
      path: f[2] || "/",
      secure: f[3].toUpperCase() === "TRUE",
      expires: Number(f[4]) || undefined,
      name: f[5],
      value: f.slice(6).join("\t"),
      httpOnly,
    });
  }
  return out;
}

function normalizeCookies(input) {
  let list;
  if (Array.isArray(input)) list = input;
  else if (input && Array.isArray(input.cookies)) list = input.cookies;
  else if (typeof input === "string") {
    const text = input.trim();
    if (text.startsWith("[") || text.startsWith("{")) {
      const parsed = JSON.parse(text);
      list = Array.isArray(parsed) ? parsed : parsed.cookies || [];
    } else {
      list = parseNetscape(text);
    }
  } else {
    throw new Error("expected a JSON cookie array or a Netscape cookies.txt");
  }

  // Browsers cap cookie lifetime at 400 days. This Firefox build silently DROPS a cookie
  // that asks for longer instead of clamping it, and real exports routinely do (1–2 year
  // session cookies), so clamp here — it is exactly what a browser would have stored.
  const maxExpiry = Math.floor(Date.now() / 1000) + 400 * 24 * 60 * 60;
  const out = [];
  for (const c of list) {
    if (!c || !c.name || c.value === undefined || !(c.domain || c.url)) continue;
    const cookie = { name: String(c.name), value: String(c.value) };
    if (c.domain) {
      cookie.domain = String(c.domain);
      cookie.path = c.path || "/";
    } else {
      // Normalise url-only cookies to domain/path: one malformed url would otherwise
      // make the engine reject the whole batch, and they could never be counted as landed.
      let u;
      try {
        u = new URL(String(c.url));
      } catch {
        continue;
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      cookie.domain = u.hostname;
      cookie.path = c.path || u.pathname.replace(/[^/]*$/, "") || "/";
      if (c.secure === undefined && u.protocol === "https:") cookie.secure = true;
    }
    const exp = c.expires ?? c.expirationDate ?? c.expiry;
    if (!c.session && Number(exp) > 0) cookie.expires = Math.min(Math.floor(Number(exp)), maxExpiry);
    if (c.httpOnly !== undefined) cookie.httpOnly = Boolean(c.httpOnly);
    if (c.secure !== undefined) cookie.secure = Boolean(c.secure);
    const ss = String(c.sameSite ?? "").toLowerCase();
    cookie.sameSite = ss === "strict" ? "Strict" : ss === "none" || ss === "no_restriction" ? "None" : "Lax";
    if (cookie.sameSite === "None") cookie.secure = true; // SameSite=None is rejected without Secure
    out.push(cookie);
  }
  if (!out.length) throw new Error("no valid cookies found");
  return out;
}

/** How many of `wanted` are now present in `jar` (same name, domain, path). */
function countLanded(wanted, jar) {
  const key = (c) => `${c.name}\u0000${String(c.domain || "").replace(/^\./, "")}\u0000${c.path || "/"}`;
  const have = new Set(jar.map(key));
  return wanted.filter((c) => have.has(key(c))).length;
}

function readCookies(id) {
  const file = cookiePath(id);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
}

/** For a stopped profile: queued for the next launch, applied once, then deleted. */
function stageCookieImport(id, cookies) {
  fs.mkdirSync(COOKIES_DIR, { recursive: true });
  const file = path.join(COOKIES_DIR, `${safeId(id)}.import.json`);
  // Merge with anything already staged so two imports before a launch both land.
  const staged = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
  fs.writeFileSync(file, JSON.stringify([...staged, ...cookies], null, 2));
  return staged.length + cookies.length;
}

function getSystemStats() {
  const sessions = listSessions();
  const proxies = listAllProxies();
  const { listFptFiles } = require("./fingerprint");
  const files = listFptFiles();
  const assignedFpts = new Set(reserved(readStore()).map((s) => s.fingerprintFile).filter(Boolean));
  const accounts = parseCsvAccounts();
  const totalCookies = sessions.reduce((acc, s) => acc + (s.cookieCount || 0), 0);
  return {
    sessionsTotal: sessions.length,
    proxiesTotal: proxies.length,
    proxiesFree: proxies.filter((p) => !p.isAssigned).length,
    fingerprintsTotal: files.length,
    fingerprintsFree: files.filter((f) => !assignedFpts.has(f)).length,
    accountsTotal: accounts.length,
    totalCookies,
  };
}

module.exports = {
  createSessionRecord,
  trashSession,
  restoreSession,
  listTrash,
  purgeTrash,
  cloneSession,
  normalizeCookies,
  countLanded,
  readCookies,
  stageCookieImport,
  safeId,
  TRASH_TTL_MS,
  getSession,
  listSessions,
  nextSessionIds,
  deleteSession,
  parseCsvAccounts,
  parseCsvText,
  newId,
  ensureSessions,
  syncSheetEdits,
  saveSessionPatch,
  openSession,
  openMany,
  parseProxy,
  loadProxies,
  listAllProxies,
  resolveProxyKey,
  publicRecord,
  listAllFingerprints,
  getSystemStats,
  generateFingerprint,
  PROXY_FILE,
  ACCOUNT_FILE,
  STORE_PATH,
};
