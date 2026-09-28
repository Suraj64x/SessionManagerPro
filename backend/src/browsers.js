// Which browser a profile runs on. See ENGINE.md §7.
//
// Every entry: { id, name, family: "chromium" | "firefox", kind, path, version, automation,
// installed, fingerprintBrowsers, note?, builtin?, custom? }. `kind` picks the worker
// (worker_runner.js ENGINES): "stealth" | "chromium" | "firefox-manual".
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { writeFileAtomic, readJsonSafe, withFileLock } = require("./fsutil");

const ROOT = path.resolve(__dirname, "..", "..");
const CUSTOM_FILE = path.join(ROOT, "data", "browsers.json");
const DEFAULT_BROWSER = "stealth-firefox";
const CACHE_MS = 60_000;

// Well-known installs, found under Program Files, Program Files (x86) and %LOCALAPPDATA%, or
// wherever the registry says (matched by the tail of the path).
const KNOWN = [
  { id: "chrome", name: "Google Chrome", family: "chromium", tail: "Google\\Chrome\\Application\\chrome.exe" },
  { id: "chrome-beta", name: "Chrome Beta", family: "chromium", tail: "Google\\Chrome Beta\\Application\\chrome.exe" },
  { id: "chrome-dev", name: "Chrome Dev", family: "chromium", tail: "Google\\Chrome Dev\\Application\\chrome.exe" },
  { id: "chrome-canary", name: "Chrome Canary", family: "chromium", tail: "Google\\Chrome SxS\\Application\\chrome.exe" },
  { id: "chromium", name: "Chromium", family: "chromium", tail: "Chromium\\Application\\chrome.exe" },
  { id: "edge", name: "Microsoft Edge", family: "chromium", tail: "Microsoft\\Edge\\Application\\msedge.exe" },
  { id: "brave", name: "Brave", family: "chromium", tail: "BraveSoftware\\Brave-Browser\\Application\\brave.exe" },
  { id: "firefox", name: "Firefox", family: "firefox", tail: "Mozilla Firefox\\firefox.exe" },
  { id: "firefox-dev", name: "Firefox Developer Edition", family: "firefox", tail: "Firefox Developer Edition\\firefox.exe" },
  { id: "firefox-nightly", name: "Firefox Nightly", family: "firefox", tail: "Firefox Nightly\\firefox.exe" },
];

const REG_KEYS = [
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths",
  "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths",
  "HKLM\\SOFTWARE\\Clients\\StartMenuInternet",
  "HKCU\\SOFTWARE\\Clients\\StartMenuInternet",
];

const NOTES = {
  chromium:
    "Runs the browser's own fingerprint; a bound Chrome fingerprint adds its OS, hardware, screen and GPU. Timezone, language, geolocation, DNS and WebRTC follow the proxy.",
  "firefox-manual":
    "Manual only: no scripts, warm-up or broadcast. The proxy login is handled by the panel's local tunnel, so Firefox never asks for it.",
  // Measured 2026-09-27 on GrizzEngine 149 (Bablosoft 30.2.0), headful and headless, bare and driven.
  bas: "Bablosoft BAS build: made to run under Bablosoft's own host. Here its Intl API (date and number formatting) hangs the page, so most sites won't work. IP, DNS and WebRTC stay clean through the tunnel. Use Stealth Firefox or Google Chrome for real browsing.",
};

/** The file version from the PE version resource (VS_FIXEDFILEINFO), or null. No process spawn. */
function fileVersion(file) {
  try {
    const b = fs.readFileSync(file);
    const key = Buffer.from("VS_VERSION_INFO", "utf16le");
    for (let at = b.indexOf(key); at >= 0; at = b.indexOf(key, at + 1)) {
      const i = b.indexOf(Buffer.from([0xbd, 0x04, 0xef, 0xfe]), at);
      if (i > 0 && i - at < 64) {
        const ms = b.readUInt32LE(i + 8);
        const ls = b.readUInt32LE(i + 12);
        return [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff].join(".");
      }
    }
  } catch {
    // unreadable: no version
  }
  return null;
}

function regExePaths(key) {
  return new Promise((resolve) => {
    execFile("reg", ["query", key, "/s"], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err && !stdout) return resolve([]);
      const out = [];
      for (const m of String(stdout).matchAll(/REG_SZ\s+"?([A-Za-z]:\\[^"\r\n]+?\.exe)/gi)) out.push(m[1]);
      resolve(out);
    });
  });
}

function playwrightBuilds() {
  const dir = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.LOCALAPPDATA || "", "ms-playwright");
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    let m = n.match(/^chromium-(\d+)$/); // not chromium_headless_shell: not a full browser
    if (m) {
      const exe = ["chrome-win64", "chrome-win"].map((d) => path.join(dir, n, d, "chrome.exe")).find((p) => fs.existsSync(p));
      if (exe) out.push({ id: `pw-chromium-${m[1]}`, label: "Playwright Chromium", family: "chromium", path: exe });
    }
    m = n.match(/^firefox-(\d+)$/);
    if (m && fs.existsSync(path.join(dir, n, "firefox", "firefox.exe"))) {
      out.push({ id: `pw-firefox-${m[1]}`, label: "Playwright Firefox", family: "firefox", path: path.join(dir, n, "firefox", "firefox.exe") });
    }
  }
  return out;
}

function entry({ id, name, family, path: exe, version, ...extra }) {
  const kind = family === "chromium" ? "chromium" : "firefox-manual";
  return {
    id,
    name,
    family,
    kind,
    path: exe,
    version: version === undefined ? fileVersion(exe) : version,
    automation: kind !== "firefox-manual",
    installed: fs.existsSync(exe),
    // Which fingerprint dumps (fingerprint.js browserName) the engine applies.
    fingerprintBrowsers: kind === "chromium" ? ["Chrome"] : [],
    note: NOTES[kind],
    ...extra,
  };
}

const ENGINE_EXES = ["chrome.exe", "chromium.exe", "worker.exe", "msedge.exe", "brave.exe", "firefox.exe"];
const cmpVersion = (a, b) => {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};

/**
 * %LOCALAPPDATA%\SessionManagerPro\engines\<Name>\<version>\: each <Name> is one engine (id
 * from the name, "GrizzEngine" -> "grizz"), its highest version folder holding a browser wins.
 */
function engineFolders() {
  const dir = path.join(process.env.LOCALAPPDATA || "", "SessionManagerPro", "engines");
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return out;
  }
  for (const name of names) {
    const found = [];
    let versions = [];
    try {
      versions = fs.readdirSync(path.join(dir, name), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue;
    }
    for (const v of versions) {
      const vdir = path.join(dir, name, v);
      const family = fs.existsSync(path.join(vdir, "chrome.dll")) ? "chromium" : fs.existsSync(path.join(vdir, "xul.dll")) ? "firefox" : null;
      const exe = ENGINE_EXES.map((e) => path.join(vdir, e)).find((p) => fs.existsSync(p));
      // Bablosoft BAS builds ship their browser as worker.exe beside their Proxy.dll.
      const bas = /worker\.exe$/i.test(exe || "") && fs.existsSync(path.join(vdir, "Proxy.dll"));
      if (family && exe) found.push({ family, path: exe, version: fileVersion(exe) || v, bas });
    }
    if (!found.length) continue;
    found.sort((a, b) => cmpVersion(b.version, a.version));
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-?engine$/, "").replace(/^-|-$/g, "") || "engine";
    const { bas, ...best } = found[0];
    out.push(entry({ id: slug, name, ...best, engineFolder: true, versions: found.map((f) => f.version), ...(bas && { note: NOTES.bas, limited: true }) }));
  }
  return out;
}

async function detectInstalled() {
  if (process.platform !== "win32") return [];
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean);
  const candidates = [];
  for (const k of KNOWN) for (const r of roots) candidates.push(path.join(r, k.tail));
  for (const list of await Promise.all(REG_KEYS.map(regExePaths))) candidates.push(...list);

  const found = new Map();
  for (const p of candidates) {
    const k = KNOWN.find((x) => p.toLowerCase().endsWith(x.tail.toLowerCase()));
    if (k && !found.has(k.id) && fs.existsSync(p)) found.set(k.id, entry({ id: k.id, name: k.name, family: k.family, path: p }));
  }
  const out = KNOWN.map((k) => found.get(k.id)).filter(Boolean);
  for (const b of playwrightBuilds()) {
    const version = fileVersion(b.path);
    const { label, ...rest } = b;
    out.push(entry({ ...rest, name: `${label}${version ? ` ${version}` : ""}`, version }));
  }
  const taken = new Set(out.map((b) => b.id));
  return [...out, ...engineFolders().filter((b) => !taken.has(b.id))];
}

function stealthEntry() {
  // Lazy: worker_runner requires this module, and features/engine requires worker_runner.
  const { versions } = require("./features/engine");
  const { findPythonExe } = require("./worker_runner");
  return {
    id: DEFAULT_BROWSER,
    name: "Stealth Firefox",
    family: "firefox",
    kind: "stealth",
    path: null,
    version: versions.firefox || null,
    automation: true,
    installed: Boolean(findPythonExe() && versions.engine),
    // Pins only screen, cores and GPU from a dump, which is browser-neutral.
    fingerprintBrowsers: ["Chrome", "Firefox"],
    builtin: true,
  };
}

/* ---------------- custom builds (data/browsers.json) ---------------- */

/**
 * The user's custom builds. `strict` (for a read-modify-write) throws on a damaged file rather
 * than reading it as empty, which would be written back empty; the listing just shows none.
 */
function readCustom({ strict = false } = {}) {
  try {
    const list = readJsonSafe(CUSTOM_FILE, { fallback: [] });
    return Array.isArray(list) ? list : [];
  } catch (err) {
    if (strict) throw err;
    return [];
  }
}

/** A read-modify-write of data/browsers.json, locked across processes. */
function updateCustom(fn) {
  return withFileLock(CUSTOM_FILE, () => {
    const next = fn(readCustom({ strict: true }));
    writeFileAtomic(CUSTOM_FILE, JSON.stringify(next, null, 2));
  });
}

const CHROMIUM_EXES = /^(chrome|chromium|msedge|brave|thorium|vivaldi|opera|yandex|cent_browser|iridium|supermium|ungoogled-chromium)\.exe$/i;
const FIREFOX_EXES = /^(firefox|camoufox|librewolf|waterfox|floorp|zen|mullvadbrowser|palemoon|mercury)\.exe$/i;

/** "chromium" | "firefox" from the exe name, else from the engine DLL next to it (or in a version folder). */
function familyOf(exe) {
  const base = path.basename(exe);
  if (CHROMIUM_EXES.test(base)) return "chromium";
  if (FIREFOX_EXES.test(base)) return "firefox";
  const dir = path.dirname(exe);
  const has = (dll) => {
    if (fs.existsSync(path.join(dir, dll))) return true;
    try {
      // Chrome-style installs keep the engine in a version folder (Application\153.0.1.2\chrome.dll).
      return fs.readdirSync(dir, { withFileTypes: true }).some((d) => d.isDirectory() && /^\d+\.\d+/.test(d.name) && fs.existsSync(path.join(dir, d.name, dll)));
    } catch {
      return false;
    }
  };
  if (has("xul.dll")) return "firefox";
  if (has("chrome.dll") || has("msedge.dll")) return "chromium";
  return null;
}

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

/** Adds a user-picked build. Throws an Error with `.status` (400/409) for the panel. */
async function addCustom({ path: raw, name } = {}) {
  const exe = String(raw || "").trim().replace(/^"(.*)"$/, "$1");
  if (!exe || !path.isAbsolute(exe)) throw bad("path must be the full path to the browser's .exe");
  if (!/\.exe$/i.test(exe)) throw bad("path must point to an .exe file");
  let st;
  try {
    st = fs.statSync(exe);
  } catch {
    throw bad(`no file at ${exe}`);
  }
  if (!st.isFile()) throw bad(`${exe} is not a file`);
  const family = familyOf(exe);
  if (!family) throw bad(`can't tell whether ${path.basename(exe)} is a Chromium or a Firefox build`);
  const version = fileVersion(exe);
  if (!version) throw bad(`${path.basename(exe)} carries no version information — is it a browser?`);

  const all = await list();
  const same = all.find((b) => b.path && path.resolve(b.path).toLowerCase() === path.resolve(exe).toLowerCase());
  if (same) throw bad(`that build is already listed as ${same.name}`, 409);

  const label = String(name || "").trim().slice(0, 60) || `${path.basename(exe, ".exe")} ${version}`;
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "build";
  const taken = new Set(all.map((b) => b.id));
  let id = `custom-${slug}`;
  for (let n = 2; taken.has(id); n++) id = `custom-${slug}-${n}`;

  await updateCustom((custom) => [...custom, { id, name: label, family, path: exe }]);
  return (await list()).find((b) => b.id === id);
}

/** Removes a custom build; `usedBy` = how many profiles (live or trashed) point at it. */
function removeCustom(id, usedBy) {
  return updateCustom((custom) => {
    if (!custom.some((c) => c.id === id)) throw bad("no custom browser with that id", 404);
    if (usedBy > 0) throw bad(`used by ${usedBy} profile${usedBy === 1 ? "" : "s"} — move them to another browser first`, 409);
    return custom.filter((c) => c.id !== id);
  });
}

/* ---------------- the list ---------------- */

let cached = null; // { at, value: detected[] }
let inflight = null;

function detected() {
  if (cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.value);
  if (!inflight) {
    inflight = detectInstalled()
      .then((value) => ((cached = { at: Date.now(), value }), value))
      .finally(() => (inflight = null));
  }
  return inflight;
}

/** Stealth Firefox first, then what is installed, then the user's custom builds. */
/**
 * What the panel offers: Stealth Firefox, builds in the engines folder (GrizzEngine), Firefox
 * builds (manual only) and the user's own custom builds. An installed Chrome, Edge or Brave and
 * Playwright's Chromium are detected but NOT offered: on those every profile shares the machine's
 * canvas, GPU and fonts, so they are the same device to a detector however the proxy changes.
 * A profile that already names one still launches — `everyBrowser()` keeps resolving it.
 */
const OFFERED = (b) => b.builtin || b.custom || b.engineFolder || b.kind === "firefox-manual";

/** Everything found, offered or not: ids on existing profiles must keep resolving. */
async function everyBrowser() {
  const custom = readCustom().map((c) => entry({ id: c.id, name: c.name, family: c.family, path: c.path, custom: true }));
  return [stealthEntry(), ...(await detected()), ...custom];
}

async function list() {
  return (await everyBrowser()).filter(OFFERED);
}

async function find(id) {
  return (await everyBrowser()).find((b) => b.id === id) || null;
}

/** A readable name even for a browser that has disappeared ("Brave", "chrome-beta"). */
function nameOf(id) {
  if (id === DEFAULT_BROWSER) return "Stealth Firefox";
  return (
    KNOWN.find((k) => k.id === id)?.name ||
    readCustom().find((c) => c.id === id)?.name ||
    cached?.value?.find((b) => b.id === id)?.name ||
    String(id)
  );
}

/** The id to store on a record, or throws a message fit for a 400. */
async function validId(id) {
  if (typeof id !== "string" || !id.trim()) throw new Error("browser must be a browser id from GET /api/browsers");
  const b = await find(id.trim());
  if (!b) throw new Error(`unknown browser "${id}" — see GET /api/browsers`);
  if (!b.installed) throw new Error(`${b.name} is not installed`);
  return b.id;
}

module.exports = { DEFAULT_BROWSER, CUSTOM_FILE, list, everyBrowser, find, nameOf, validId, addCustom, removeCustom, fileVersion, familyOf };
