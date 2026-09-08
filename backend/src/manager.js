const fs = require("fs");
const path = require("path");
const { connect } = require("puppeteer-real-browser");
const { createCursor } = require("ghost-cursor");
const { generateFingerprint, applyFingerprint, buildFingerprint } = require("./fingerprint");

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

// ponytail: global lock, per-account locks if create-throughput matters
let lock = Promise.resolve();
function withLock(fn) {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

function safeId(id) {
  const cleaned = String(id).trim().replace(/[<>:"/\\|?*]/g, "_").slice(0, 120);
  if (!cleaned) throw new Error("session id is empty");
  return cleaned;
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
  const lines = fs
    .readFileSync(ACCOUNT_FILE, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim());
  const headers = splitCsvLine(lines[0]);
  const iEmail = headers.indexOf("Email");
  if (iEmail < 0) throw new Error("AccountFile.csv is missing an Email column");
  const names = [];
  for (const line of lines.slice(1)) {
    const name = (splitCsvLine(line)[iEmail] || "").trim();
    if (name) names.push(name);
  }
  return names;
}

function readStore() {
  if (!fs.existsSync(STORE_PATH)) return { sessions: {} };
  return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
}

function writeStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STORE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_PATH);
  try {
    require("./sheet").writeSessionSheet(Object.values(store.sessions || {}));
  } catch {
    // sheet is a view; do not fail the save
  }
}

function parseProxy(line) {
  const u = new URL(line.trim());
  return {
    host: u.hostname,
    port: Number(u.port),
    username: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
  };
}

function loadProxies() {
  const files = fs.existsSync(PROXY_DIR)
    ? fs.readdirSync(PROXY_DIR).filter((f) => f.endsWith(".txt"))
    : [];
  const lines = [];
  for (const file of files.length ? files : ["proxiesgood.txt"]) {
    const full = path.join(PROXY_DIR, file);
    if (!fs.existsSync(full)) continue;
    for (const line of fs.readFileSync(full, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) lines.push(trimmed);
    }
  }
  return [...new Set(lines)].map(parseProxy);
}

function proxyKey(p) {
  return `${p.host}:${p.port}`;
}

function pickUnusedProxy(store) {
  const used = new Set(
    Object.values(store.sessions).map((s) => s.proxy && proxyKey(s.proxy)).filter(Boolean),
  );
  const free = loadProxies().filter((p) => !used.has(proxyKey(p)));
  if (!free.length) throw new Error("no unused proxies left in resources/proxies");
  return free[Math.floor(Math.random() * free.length)];
}

function pickUnusedFpt(store) {
  const { listFptFiles } = require("./fingerprint");
  const used = new Set(
    Object.values(store.sessions).map((s) => s.fingerprintFile).filter(Boolean),
  );
  const free = listFptFiles().filter((f) => !used.has(f));
  if (!free.length) throw new Error("no unused fingerprints left in resources/fpts");
  return free[Math.floor(Math.random() * free.length)];
}

function createSessionRecord(id, extras = {}) {
  return withLock(async () => {
    const sid = safeId(id);
    const store = readStore();
    if (store.sessions[sid]) return store.sessions[sid];
    const proxy = extras.proxy || pickUnusedProxy(store);
    const fingerprintFile = extras.fingerprintFile || pickUnusedFpt(store);
    const record = {
      id: sid,
      email: extras.email || sid,
      proxy,
      fingerprintFile,
      fingerprint: extras.fingerprint || (await buildFingerprint(fingerprintFile, proxy)),
      userDataDir: path.join(PROFILES_DIR, sid),
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

async function ensureSessions(names) {
  const created = [];
  const existing = [];
  for (const name of names) {
    const already = getSession(name);
    if (already) existing.push(already);
    else created.push(await createSessionRecord(name, { email: name }));
  }
  return { created, existing };
}

function getSession(id) {
  return readStore().sessions[safeId(id)] || null;
}

function listSessions() {
  return Object.values(readStore().sessions);
}

function nextSessionIds(count, prefix = "session") {
  const existing = new Set(listSessions().map((s) => s.id));
  const ids = [];
  let n = 1;
  while (ids.length < count) {
    const id = `${prefix}-${n}`;
    if (!existing.has(id)) ids.push(id);
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
    if (!name) continue;
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
    Object.assign(rec, patch, { updatedAt: new Date().toISOString() });
    store.sessions[sid] = rec;
    writeStore(store);
    return rec;
  });
}

async function attachPage(page, record) {
  if (page.__smAttached) return page;
  page.__smAttached = true;
  if (record.proxy.username) {
    await page.authenticate({
      username: record.proxy.username,
      password: record.proxy.password,
    });
  }
  await applyFingerprint(page, record.fingerprint);
  const cursor = createCursor(page);
  page.realCursor = cursor;
  page.realClick = cursor.click.bind(cursor);
  return page;
}

async function collectTabs(browser) {
  const pages = await browser.pages();
  return pages.map((p) => p.url()).filter((u) => u && u !== "about:blank");
}

async function dumpCookies(browser) {
  const pages = await browser.pages();
  const page = pages[0];
  if (!page) return [];
  const client = await page.createCDPSession();
  const { cookies } = await client.send("Network.getAllCookies");
  return cookies || [];
}

async function saveCookies(id, browser) {
  const cookies = await dumpCookies(browser);
  fs.mkdirSync(COOKIES_DIR, { recursive: true });
  fs.writeFileSync(cookiePath(id), JSON.stringify(cookies, null, 2));
  return cookies.length;
}

async function restoreCookies(page, id) {
  const file = cookiePath(id);
  if (!fs.existsSync(file)) return 0;
  const cookies = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!cookies.length) return 0;
  const client = await page.createCDPSession();
  await client.send("Network.setCookies", { cookies });
  return cookies.length;
}

async function persistSession(id, browser) {
  try {
    const tabs = await collectTabs(browser);
    const cookieCount = await saveCookies(id, browser);
    await saveSessionPatch(id, { tabs, cookieCount });
  } catch {
    // browser already gone
  }
}

async function openSession(id, opts = {}) {
  const record = getSession(id) || (await createSessionRecord(id));
  const fp = record.fingerprint;
  const { browser, page } = await connect({
    headless: opts.headless ?? false,
    ignoreAllFlags: true,
    args: [
      `--window-size=${fp.viewport.width},${fp.viewport.height}`,
      `--lang=${fp.locale}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    ],
    customConfig: {
      userDataDir: record.userDataDir,
    },
    proxy: record.proxy,
    turnstile: false,
    connectOption: {
      defaultViewport: {
        width: fp.viewport.width,
        height: fp.viewport.height,
        deviceScaleFactor: fp.viewport.deviceScaleFactor,
      },
    },
  });

  await attachPage(page, record);

  browser.on("targetcreated", async (target) => {
    if (target.type() !== "page") return;
    try {
      const p = await target.page();
      if (p) await attachPage(p, record);
    } catch {
      // target closed before attach
    }
  });

  await restoreCookies(page, record.id);

  const persist = () => persistSession(record.id, browser);
  const timer = setInterval(persist, 8000);
  timer.unref?.();
  browser.on("disconnected", () => {
    clearInterval(timer);
    persist();
  });

  const restore = opts.url ? [opts.url] : record.tabs || [];
  if (restore[0]) {
    await page.goto(restore[0], { waitUntil: "domcontentloaded" });
  }
  for (const url of restore.slice(1)) {
    const extra = await browser.newPage();
    await attachPage(extra, record);
    await extra.goto(url, { waitUntil: "domcontentloaded" });
  }

  await saveSessionPatch(record.id, { lastOpenedAt: new Date().toISOString() });

  return {
    id: record.id,
    session: getSession(record.id),
    browser,
    page,
    cursor: page.realCursor,
    close: async () => {
      await persistSession(record.id, browser);
      clearInterval(timer);
      await browser.close();
    },
  };
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
  const proxies = loadProxies();
  return proxies.map((p) => {
    const key = proxyKey(p);
    const assignedSessionId = assignedMap.get(key) || null;
    return {
      key,
      host: p.host,
      port: p.port,
      username: p.username || "",
      isAssigned: Boolean(assignedSessionId),
      assignedTo: assignedSessionId,
      url: `http://${p.username ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password || "")}@` : ""}${p.host}:${p.port}`,
    };
  });
}

function listAllFingerprints() {
  const { listFptFiles, inspectFingerprint } = require("./fingerprint");
  const store = readStore();
  const assignedMap = new Map();
  for (const s of Object.values(store.sessions)) {
    if (s.fingerprintFile) assignedMap.set(s.fingerprintFile, s.id);
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

function getSystemStats() {
  const sessions = listSessions();
  const proxies = listAllProxies();
  const { listFptFiles } = require("./fingerprint");
  const files = listFptFiles();
  const assignedFpts = new Set(sessions.map((s) => s.fingerprintFile).filter(Boolean));
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
  getSession,
  listSessions,
  nextSessionIds,
  deleteSession,
  parseCsvAccounts,
  ensureSessions,
  syncSheetEdits,
  saveSessionPatch,
  openSession,
  openMany,
  parseProxy,
  loadProxies,
  listAllProxies,
  listAllFingerprints,
  getSystemStats,
  generateFingerprint,
  PROXY_FILE,
  ACCOUNT_FILE,
  STORE_PATH,
};
