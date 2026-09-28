const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const EventEmitter = require("events");
const { startTunnel, fetchVia } = require("./tunnel");

// Point to root directory (two levels up from backend/src)
const ROOT = path.resolve(__dirname, "..", "..");

// The bundled runtime an installer ships; the engine cache sits beside it.
const RUNTIME_PYTHON = path.join(ROOT, "runtime", "python", "python.exe");
const RUNTIME_ENGINE = path.join(ROOT, "runtime", "engine");

/**
 * The Python that runs the worker: SMP_PYTHON, the bundled runtime, then a developer
 * checkout's .venv. Null when none exists — never a system Python, whose site-packages
 * would not hold the pinned engine.
 */
function findPythonExe() {
  const candidates = [process.env.SMP_PYTHON, RUNTIME_PYTHON, path.join(ROOT, ".venv", "Scripts", "python.exe")];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

/** The worker's environment: the parent's, minus anything that could redirect Python. */
function workerEnv() {
  const env = { ...process.env };
  delete env.PYTHONHOME;
  delete env.PYTHONPATH;
  env.PYTHONNOUSERSITE = "1";
  // The engine would otherwise pip-install into site-packages on a version mismatch.
  env.INVISIBLE_CORE_AUTOFIX = "off";
  if (!env.INVISIBLE_PLAYWRIGHT_CACHE_DIR && fs.existsSync(RUNTIME_ENGINE)) {
    env.INVISIBLE_PLAYWRIGHT_CACHE_DIR = RUNTIME_ENGINE;
  }
  return env;
}

/**
 * Deterministic 31-bit seed generator for session id
 */
function deriveSeed(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash << 5) - hash + id.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 2147483647 || 42;
}

/**
 * Convert existing fingerprint object / file attributes into invisible_playwright pin dict
 */
function buildPinConfig(record) {
  const fp = record.fingerprint;
  if (!fp) return null;

  const pin = {};
  if (fp.viewport?.width) pin["screen.width"] = Number(fp.viewport.width);
  if (fp.viewport?.height) pin["screen.height"] = Number(fp.viewport.height);
  if (fp.hardwareConcurrency) pin["hardware.concurrency"] = Number(fp.hardwareConcurrency);
  if (fp.webgl?.vendor) pin["gpu.vendor"] = fp.webgl.vendor;
  if (fp.webgl?.renderer) pin["gpu.renderer"] = fp.webgl.renderer;

  return Object.keys(pin).length ? pin : null;
}

/**
 * The parts of a bound fingerprint a Chromium browser can wear coherently, or null. Only a
 * Chrome-on-Windows dump qualifies (this host is Windows); the browser brand and version always
 * stay the real binary's, so the UA string and brands never come from here. See ENGINE.md §7.
 */
function chromiumFingerprint(record) {
  const fp = record.fingerprint;
  const ua = String(fp?.userAgent || "");
  if (!/Chrome\//.test(ua) || /Firefox\//.test(ua) || !/Windows/.test(ua)) return null;
  const uad = fp.userAgentData && fp.userAgentData.platform === "Windows" ? fp.userAgentData : null;
  const gpu = fp.webgl?.renderer || "";
  return {
    platform: fp.platform || "Win32",
    uad: uad && {
      platform: "Windows",
      platformVersion: uad.platformVersion,
      architecture: uad.architecture,
      bitness: uad.bitness,
      model: uad.model || "",
      mobile: Boolean(uad.mobile),
      wow64: Boolean(uad.wow64),
    },
    hardwareConcurrency: Number(fp.hardwareConcurrency) || undefined,
    // The values a real Chrome can report.
    deviceMemory: [0.25, 0.5, 1, 2, 4, 8, 16, 32].includes(Number(fp.deviceMemory)) ? Number(fp.deviceMemory) : undefined,
    screen: fp.screen,
    dpr: fp.viewport?.deviceScaleFactor,
    languages: fp.languages,
    // A software renderer (SwiftShader, llvmpipe, Basic Render) is a bot tell: never claim one.
    webgl: fp.webgl?.vendor && gpu && !/swiftshader|llvmpipe|basic render|software/i.test(gpu) ? fp.webgl : undefined,
  };
}

/**
 * The engines a profile can run on, by browsers.js `kind`. Each worker speaks the protocol in
 * ENGINE.md; `args` adds its own flags to the common ones.
 */
const ENGINES = {
  stealth: {
    script: "browser_worker.py",
    label: "invisible_playwright worker",
    args: (record, browser, geo, opts = {}) => {
      const pin = buildPinConfig(record);
      const icon = opts.slot && !opts.headless ? threadIcon(opts.slot) : null;
      return [
        ...(pin ? [`--pin=${JSON.stringify(pin)}`] : []),
        ...(geo ? [`--geo=${JSON.stringify(geo)}`] : []),
        ...(icon ? [`--icon=${icon}`] : []),
      ];
    },
    // No launch counter: the engine would fetch a GitHub asset at every start, possibly before the
    // proxy is applied. WebRTC behind a proxy (ENGINE.md §2), measured 2026-09-27:
    // - default "masked": the page's own STUN/TURN servers are ignored and Firefox's only STUN
    //   server is a dead local port, so no STUN request leaves this machine; the engine then
    //   shows the page the proxy's exit IP as its public address (its srflx fallback), like a
    //   browser behind NAT. The engine's own setting sent 6 STUN requests from this machine to a
    //   page-chosen server; this sends none.
    // - "off": nothing outside the proxy at all, and no candidates (iphey's test never finishes).
    prefs: (record) => ({
      "invisible_firefox.usage_ping.enabled": false,
      ...(record.proxy?.host &&
        (record.webrtc === "off"
          ? { "media.peerconnection.ice.proxy_only_if_behind_proxy": true }
          : {
              "media.peerconnection.use_document_iceservers": false,
              "media.peerconnection.default_iceservers": JSON.stringify([{ urls: ["stun:127.0.0.1:3479"] }]),
            })),
    }),
  },
  chromium: {
    script: "chromium_worker.py",
    label: "Chromium worker",
    args: (record, browser, geo) => {
      const fp = chromiumFingerprint(record);
      return [
        `--browser-path=${browser.path}`,
        `--geolocation=${record.geolocation === "spoof" ? "spoof" : "block"}`,
        ...(fp ? [`--fingerprint=${JSON.stringify(fp)}`] : []),
        ...(geo ? [`--geo=${JSON.stringify(geo)}`] : []),
      ];
    },
  },
  "firefox-manual": {
    script: "firefox_manual.py",
    label: "Firefox",
    args: (record, browser) => [`--browser-path=${browser.path}`, `--geolocation=${record.geolocation === "spoof" ? "spoof" : "block"}`],
  },
};

const IANA = /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+$/;

const ICON_DIR = path.join(process.env.LOCALAPPDATA || require("os").tmpdir(), "SessionManagerPro", "icons");
const iconJobs = new Set();
let darkTaskbar = null;

/**
 * Thread `n`'s taskbar icon for a Stealth Firefox window (thread_icon.ps1: the Firefox
 * silhouette, white inside, the number on it). The path comes back at once; the first time a
 * number is used the file is drawn in the background (~1 s) and cached, and the worker puts it
 * on the window as soon as it exists. A dark taskbar gets the variant with a light halo.
 */
function threadIcon(n) {
  if (process.platform !== "win32") return null;
  if (darkTaskbar === null) {
    try {
      const out = require("child_process").execFileSync(
        "reg",
        ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize", "/v", "SystemUsesLightTheme"],
        { encoding: "utf8", windowsHide: true, timeout: 3000 }
      );
      darkTaskbar = /\b0x0\b/.test(out);
    } catch {
      darkTaskbar = false;
    }
  }
  const file = path.join(ICON_DIR, `stealth-${darkTaskbar ? "dark" : "light"}-${n}.ico`);
  if (!fs.existsSync(file) && !iconJobs.has(file)) {
    iconJobs.add(file);
    fs.mkdirSync(ICON_DIR, { recursive: true });
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "thread_icon.ps1"), "-Number", String(n), "-Out", file];
    if (darkTaskbar) args.push("-Dark");
    require("child_process").execFile("powershell.exe", args, { windowsHide: true, timeout: 30000 }, () => iconJobs.delete(file));
  }
  return file;
}

/**
 * The proxy exit's IP, country, timezone and position, asked through the proxy itself: one
 * lookup per launch, handed to the worker so the browser's timezone and language match what
 * detectors see. ipinfo.io matched Fingerprint Pro on every exit tested (2026-09-27) where
 * Stealth Firefox's bundled database and ip-api.com did not (Virginia exits placed in
 * America/Chicago: "VPN, timezone mismatch"); ip-api.com is the fallback. Null when neither
 * answers: the worker then finds the geo itself, as before.
 */
async function exitGeo(proxy) {
  const up = { ...proxy, scheme: proxy.scheme || "http", port: Number(proxy.port) };
  const ask = async (url, pick) => {
    try {
      const g = pick(JSON.parse((await fetchVia(up, url, { timeoutMs: 5000 })).body));
      return g && g.ip && IANA.test(g.timezone || "") ? g : null;
    } catch {
      return null;
    }
  };
  const loc = (s) => String(s || "").split(",").map(Number);
  return (
    (await ask("https://ipinfo.io/json", (j) => ({ ip: j.ip, country: j.country, timezone: j.timezone, lat: loc(j.loc)[0], lon: loc(j.loc)[1] }))) ||
    (await ask("http://ip-api.com/json?fields=status,query,countryCode,timezone,lat,lon", (j) =>
      j.status === "success" ? { ip: j.query, country: j.countryCode, timezone: j.timezone, lat: j.lat, lon: j.lon } : null
    ))
  );
}

/** The engine and browser entry for a record; rejects when its browser has gone. */
async function engineFor(record) {
  const browsers = require("./browsers"); // lazy: browsers.js requires this module
  const id = record.browser || browsers.DEFAULT_BROWSER;
  if (id === browsers.DEFAULT_BROWSER) return { engine: ENGINES.stealth, browser: null };
  const browser = await browsers.find(id);
  if (!browser || !browser.installed || !ENGINES[browser.kind]) {
    throw new Error(`${browser?.name || browsers.nameOf(id)} is not installed any more — pick another browser for this profile`);
  }
  return { engine: ENGINES[browser.kind], browser };
}

/**
 * Launch the profile's browser worker (Stealth Firefox unless record.browser says otherwise)
 */
async function launchWorker(record, opts = {}) {
  const { engine, browser } = await engineFor(record);
  // Every proxied browser talks to a local tunnel with no password, and the tunnel logs in to the
  // real proxy (tunnel.js): the password never reaches the browser, a failing proxy is a 502 and
  // never a direct connection, and Stealth Firefox 151 (engine firefox-29) can't take its
  // HTTP-auth path, which accepted the proxy but sent pages out on this machine's own IP.
  const tunnel = record.proxy?.host
    ? await startTunnel({ ...record.proxy, scheme: record.proxy.scheme || "http", port: Number(record.proxy.port) })
    : null;
  try {
    const geo = tunnel ? await exitGeo(record.proxy) : null;
    return await spawnWorker(record, opts, engine, browser, tunnel, geo);
  } catch (err) {
    await tunnel?.close();
    throw err;
  }
}

function spawnWorker(record, opts, engine, browser, tunnel, geo) {
  return new Promise((resolve, reject) => {
    const pythonExe = findPythonExe();
    if (!pythonExe) {
      return reject(new Error(`Python runtime missing — expected ${RUNTIME_PYTHON} (reinstall SessionManagerPro)`));
    }
    const seed = record.seed || deriveSeed(record.id);

    const args = [
      path.join(__dirname, engine.script),
      ...engine.args(record, browser, geo, opts),
      `--id=${record.id}`,
      `--profile-dir=${record.userDataDir}`,
      `--seed=${seed}`,
    ];

    // A launch-wide URL wins, then the profile's own start pages, then last session's tabs.
    const startUrls = opts.url ? [opts.url] : record.startUrls?.length ? record.startUrls : record.tabs || [];
    for (const url of startUrls.slice(0, 10)) args.push(`--url=${url}`);

    if (opts.headless) args.push("--headless");
    // The engine's own prefs win over a caller's: a script must not reopen a leak.
    const prefs = { ...(opts.prefs && typeof opts.prefs === "object" ? opts.prefs : {}), ...engine.prefs?.(record) };
    if (Object.keys(prefs).length) args.push(`--prefs=${JSON.stringify(prefs)}`);

    // The proxy goes through the environment, never the command line. It is the local tunnel,
    // so the worker and the browser never hold the real proxy's password.
    const env = workerEnv();
    if (tunnel) {
      env.SMP_PROXY = JSON.stringify({ scheme: "http", host: "127.0.0.1", port: tunnel.port, username: "", password: "" });
    }

    // Timezone and locale are deliberately not passed. The stored values were looked up
    // from the proxy HOST; left unset, invisible_playwright derives both from the proxy's
    // EXIT IP — and a zone that disagrees with the exit IP is the tz_mismatch it guards against.

    const cookiesFile = path.join(ROOT, "data", "cookies", `${record.id}.json`);
    args.push(`--cookies-file=${cookiesFile}`);

    // Written by scripts.js before launch; the worker injects each one on every page.
    if (opts.initScriptsFile) {
      args.push(`--init-scripts=${opts.initScriptsFile}`);
    }
    // Staged by the cookie-import endpoint; the worker adds them once, then deletes the file.
    const cookiesImport = path.join(ROOT, "data", "cookies", `${record.id}.import.json`);
    if (fs.existsSync(cookiesImport)) {
      args.push(`--cookies-import=${cookiesImport}`);
    }

    // -E -s: ignore PYTHON* variables and the user site-packages, so only the runtime's
    // own packages (the pinned engine) are importable.
    const proc = spawn(pythonExe, ["-E", "-s", ...args], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: false,
      env,
    });
    // A write to a worker that just died raises EPIPE on the stream; never let that escape.
    proc.stdin.on("error", () => {});

    const handle = new EventEmitter();
    handle.id = record.id;
    handle.process = proc;
    handle.tabs = record.tabs || [];
    handle.cookieCount = record.cookieCount || 0;
    handle.seed = seed;
    handle.browser = handle; // Backwards-compatible proxy for orchestrator
    handle.tunnel = tunnel; // stats() for anyone who wants the traffic figures

    let settled = false;
    let stdoutBuffer = "";

    // Request/response over the same JSON-lines pipe. Each call carries a reqId the
    // worker echoes back in its `reply` event.
    let seq = 0;
    const pending = new Map();

    handle.rpc = (op, payload = {}, timeoutMs = 35000) =>
      new Promise((res, rej) => {
        if (!proc.stdin.writable) return rej(new Error("browser is not running"));
        const reqId = ++seq;
        let line;
        try {
          // Payload first: a caller's fields must never override the command or its id.
          line = JSON.stringify({ ...payload, cmd: op, reqId }) + "\n";
        } catch (err) {
          // e.g. a circular or BigInt argument: fail now instead of waiting out the timeout
          return rej(new Error(`${op}: arguments can't be sent to the browser (${err.message.split("\n")[0]})`));
        }
        const timer = setTimeout(() => {
          pending.delete(reqId);
          rej(new Error(`${op} timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
        timer.unref?.();
        pending.set(reqId, { res, rej, timer });
        try {
          proc.stdin.write(line);
        } catch (err) {
          clearTimeout(timer);
          pending.delete(reqId);
          rej(err);
        }
      });

    const failPending = (why) => {
      for (const { rej, timer } of pending.values()) {
        clearTimeout(timer);
        rej(new Error(why));
      }
      pending.clear();
    };

    function sendCmd(cmd) {
      if (proc.stdin.writable) {
        try {
          proc.stdin.write(JSON.stringify(cmd) + "\n");
        } catch {}
      }
    }

    // Resolves when the worker reports the profile closed (its cookies are saved), not when
    // the browser has quit: Firefox needs ~2 s more. `handle.exited` is that later moment.
    handle.exited = new Promise((res) => proc.once("exit", res));
    handle.close = () => {
      handle.closedByUser = true;
      sendCmd({ cmd: "close" });
      // A browser that saved but will not quit is hung: end it.
      const kill = setTimeout(() => {
        try {
          proc.kill();
        } catch {}
      }, 15000);
      kill.unref?.();
      handle.exited.then(() => clearTimeout(kill));
      if (proc.exitCode !== null) return Promise.resolve();
      return new Promise((res) => {
        handle.once("disconnected", res);
        handle.exited.then(res);
      });
    };

    handle.newPage = async (url) => {
      sendCmd({ cmd: "new_page", url });
    };

    proc.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          const ev = msg.event;

          if (ev === "ready") {
            if (msg.tabs) handle.tabs = msg.tabs;
            if (msg.cookieCount !== undefined) handle.cookieCount = msg.cookieCount;
            if (msg.seed !== undefined) handle.seed = msg.seed;
            // "ready" fires before anyone can subscribe; keep what the launcher needs.
            handle.headless = Boolean(msg.headless);
            handle.exitIp = msg.exitIp;
            handle.country = msg.country;
            handle.cdpPort = msg.cdpPort; // Chromium only: the browser's DevTools port (POST /api/sessions/:id/cdp)

            if (!settled) {
              settled = true;
              resolve(handle);
            }
            handle.emit("ready", msg);
          } else if (ev === "tabs") {
            if (msg.tabs) handle.tabs = msg.tabs;
            handle.emit("tabs", msg.tabs);
          } else if (ev === "cookies") {
            if (msg.count !== undefined) handle.cookieCount = msg.count;
            handle.emit("cookies", msg.count);
          } else if (ev === "disconnected" || ev === "closed") {
            handle.emit("disconnected", msg.reason || "browser closed");
          } else if (ev === "error") {
            const err = new Error(msg.error || "Worker error");
            // Before "ready" nobody is subscribed yet: surface the real cause to the launcher
            // instead of the generic "exited prematurely" that follows.
            if (!settled) {
              settled = true;
              reject(err);
            }
            if (handle.listenerCount("error")) handle.emit("error", err);
          } else if (ev === "reply") {
            const call = pending.get(msg.reqId);
            if (call) {
              pending.delete(msg.reqId);
              clearTimeout(call.timer);
              if (msg.ok) call.res(msg.result);
              else call.rej(new Error(msg.error || "script failed"));
            }
          } else if (ev === "init_scripts" || ev === "cookies_imported" || ev === "cookies_import_failed") {
            // These fire during startup, before anyone can subscribe; keep them for the launcher.
            handle.launchNotes = [...(handle.launchNotes || []), msg];
          }
        } catch {
          // Non-JSON worker message (debug log)
        }
      }
    });

    proc.stderr.on("data", (chunk) => {
      const txt = chunk.toString("utf8").trim();
      if (txt) {
        console.warn(`[worker:${record.id}] ${txt}`);
      }
    });

    proc.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
      // An "error" event with no listener is rethrown by EventEmitter and would take down
      // the whole server (e.g. Python missing). Only forward it once someone is listening.
      if (handle.listenerCount("error")) handle.emit("error", err);
    });

    proc.on("exit", (code, signal) => {
      tunnel?.close();
      failPending("browser closed");
      if (!settled) {
        settled = true;
        reject(new Error(`Worker process exited prematurely with code ${code}`));
      }
      handle.emit("disconnected", code === 0 ? "browser closed" : `exit code ${code}`);
    });

    // Timeout safety: 30s to initialize
    const safetyTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          proc.kill();
        } catch {}
        reject(new Error(`Timeout waiting for ${engine.label} to be ready`));
      }
    }, 30000);
    safetyTimer.unref?.();
  });
}

module.exports = {
  findPythonExe,
  workerEnv,
  deriveSeed,
  launchWorker,
  chromiumFingerprint,
  exitGeo,
  ENGINES,
};
