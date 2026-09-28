// Local API: run one op on a profile, a running Chromium profile's CDP endpoint; browser settings
// (traffic saver, check pages). See README.md in this folder for deps.
const path = require("path");
const crypto = require("crypto");
const browsers = require("../browsers");

// Everything handle.rpc understands (ENGINE.md §1). The worker itself rejects an unknown op,
// so an op the engine team has not shipped yet fails with a readable error, not a 500.
const OPS = new Set([
  "goto", "click", "fill", "type", "press", "wait_for", "scroll", "eval", "info", "new_tab",
  "screenshot", "cookies", "add_cookies", "keyboard_type", "reload", "close_other_tabs", "tabs", "window",
  "human_move", "human_click", "human_type", "human_scroll", "human_wander", "human_scroll_burst",
]);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
// A profile that just launched may still be opening its start pages; the worker holds ops
// for up to 30 s before running it (ENGINE.md §1), so the deadline carries that wait too.
const START_ALLOWANCE_MS = 35_000;

const DEFAULT_CHECK_PAGES = [
  "https://pixelscan.net",
  "https://www.browserscan.net",
  "https://abrahamjuliot.github.io/creepjs/",
  "https://ipinfo.io",
];

/*
 * Leak check. The browser part runs in a throwaway tab of the profile (any engine with
 * automation) and reports what sites see; the server part learns this machine's real IPs and
 * DNS resolvers over its own, unproxied connection. A leak is the real one showing up inside.
 */
// A plain page with no content policy: Firefox shows JSON in its privileged viewer, whose
// policy blocks the probe's fetches, so the probes run from here instead (all send CORS *).
const LEAK_PAGE = "https://example.com/";

// Runs in the page (the eval op takes a function source). Kept free of outer references.
const LEAK_SCRIPT = `async (session) => {
  const get = async (url, ms) => {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    try { const r = await fetch(url + (url.includes('?') ? '&' : '?') + '_=' + Date.now(), { signal: c.signal }); return await r.json(); }
    catch { return null; } finally { clearTimeout(t); }
  };
  const out = { ipv4: null, ipv6: null, webrtc: { public: [], local: [], mdns: 0, error: null }, dns: [], geolocation: 'unavailable',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, language: navigator.language, languages: [...(navigator.languages || [])] };
  const [v4, v6] = await Promise.all([get('https://api.ipify.org?format=json', 9000), get('https://api6.ipify.org?format=json', 7000)]);
  out.ipv4 = v4 && v4.ip && !v4.ip.includes(':') ? v4.ip : null;
  out.ipv6 = v6 && v6.ip && v6.ip.includes(':') ? v6.ip : null;
  try {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] });
    const seen = new Set();
    pc.onicecandidate = (e) => { if (e.candidate && e.candidate.candidate) seen.add(e.candidate.candidate); };
    pc.createDataChannel('probe');
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((done) => {
      const t = setTimeout(done, 5000);
      pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); done(); } };
    });
    for (const line of ((pc.localDescription && pc.localDescription.sdp) || '').split(/\\r?\\n/)) if (line.startsWith('a=candidate:')) seen.add(line.slice(2));
    pc.close();
    const pub = new Set(), loc = new Set();
    for (const c of seen) {
      const f = c.split(' '); const addr = f[4]; const typ = f[f.indexOf('typ') + 1];
      if (!addr) continue;
      if (addr.endsWith('.local')) { out.webrtc.mdns++; continue; }
      (typ === 'host' ? loc : pub).add(addr);
    }
    out.webrtc.public = [...pub]; out.webrtc.local = [...loc];
  } catch (e) { out.webrtc.error = String((e && e.message) || e); }
  const rnd = () => Math.random().toString(36).slice(2, 10);
  const probes = await Promise.all(Array.from({ length: 6 }, () => get('https://' + session + '-' + rnd() + '.ipleak.net/dnsdetection/', 9000)));
  const resolvers = new Set();
  for (const p of probes) if (p && p.ip) for (const ip of Object.keys(p.ip)) resolvers.add(ip);
  out.dns = [...resolvers];
  out.dnsProbes = probes.filter(Boolean).length;
  try { out.geolocation = (await navigator.permissions.query({ name: 'geolocation' })).state; } catch {}
  return out;
}`;

// Languages a country's residents commonly browse in, for the Language row (region match wins).
const COUNTRY_LANGS = {
  US: ["en", "es"], GB: ["en"], CA: ["en", "fr"], AU: ["en"], NZ: ["en"], IE: ["en"], IN: ["en", "hi"], SG: ["en", "zh"],
  DE: ["de"], AT: ["de"], CH: ["de", "fr", "it"], FR: ["fr"], BE: ["nl", "fr"], NL: ["nl"], ES: ["es", "ca"], MX: ["es"],
  AR: ["es"], CO: ["es"], CL: ["es"], PE: ["es"], IT: ["it"], PT: ["pt"], BR: ["pt"], PL: ["pl"], CZ: ["cs"], SK: ["sk"],
  RU: ["ru"], UA: ["uk", "ru"], BY: ["ru", "be"], KZ: ["ru", "kk"], TR: ["tr"], GR: ["el"], RO: ["ro"], HU: ["hu"],
  BG: ["bg"], RS: ["sr"], HR: ["hr"], SE: ["sv"], NO: ["nb", "no", "nn"], DK: ["da"], FI: ["fi", "sv"], JP: ["ja"],
  KR: ["ko"], CN: ["zh"], TW: ["zh"], HK: ["zh", "en"], VN: ["vi"], TH: ["th"], ID: ["id"], MY: ["ms", "en"],
  PH: ["en", "fil", "tl"], IL: ["he"], SA: ["ar"], AE: ["ar", "en"], EG: ["ar"], ZA: ["en", "af"], NG: ["en"], PK: ["ur", "en"],
  BD: ["bn"], IR: ["fa"],
};

/** RFC 1918, CGNAT, link-local and unique-local: an address that only exists on this LAN. */
const isPrivateIp = (ip) =>
  /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.|127\.)/.test(ip) ||
  /^(fc|fd|fe8|fe9|fea|feb)/i.test(ip) || ip === "::1";

module.exports = function register(app, deps) {
  const { orchestrator, scripts, appSettings, isWebUrl } = deps;
  // isWebUrl also admits about:blank, which is not a check page.
  const isHttp = (u) => u !== "about:blank" && isWebUrl(u);
  // Same folder and naming as scripts.js, so /api/screenshots serves both.
  const safeSegment = (id) => String(id).replace(/[<>:"/\\|?*]/g, "_");

  appSettings.register("checkPages", DEFAULT_CHECK_PAGES, (v) => {
    if (!Array.isArray(v)) throw new Error("checkPages must be a list of URLs");
    const urls = [...new Set(v.map((u) => String(u).trim()).filter(Boolean))];
    if (urls.length < 1 || urls.length > 10 || !urls.every(isHttp)) {
      throw new Error("checkPages must be 1–10 http(s) URLs");
    }
    return urls;
  });

  // Read by the automation feature: block images/autoplay on hidden and automated runs only.
  appSettings.register("trafficSaver", false, (v) => {
    if (typeof v !== "boolean") throw new Error("trafficSaver must be true or false");
    return v;
  });

  // One Playwright op on a running profile, for curl/Python/Node callers. The automation door on
  // every engine; Stealth Firefox has no other (its engine lives inside the app's worker).
  app.post("/api/sessions/:id/op", async (req, res) => {
    const id = req.params.id;
    const { op, ...payload } = req.body || {};
    if (typeof op !== "string" || !OPS.has(op)) {
      return res.status(400).json({ error: `op must be one of: ${[...OPS].join(", ")}` });
    }
    const live = orchestrator.live.get(id);
    if (!live) return res.status(404).json({ error: "profile is not running" });

    // `timeout` is both the Playwright deadline (in the payload) and, plus an allowance, the
    // RPC deadline, capped so one stuck call cannot hold a connection for ever.
    const ms = Math.min(Number(payload.timeout) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    if (payload.timeout !== undefined) payload.timeout = ms;

    let shotUrl;
    if (op === "screenshot") {
      const name = `${Date.now()}.png`;
      payload.path = path.join(scripts.SHOTS, safeSegment(id), name);
      shotUrl = `/api/screenshots/${encodeURIComponent(safeSegment(id))}/${name}`;
    }
    try {
      const value = await live.handle.rpc(op, payload, ms + START_ALLOWANCE_MS);
      res.json({ ok: true, value: shotUrl || value });
    } catch (err) {
      // The worker's own message: a selector that matched nothing, a timeout, an unknown op.
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // A running Chromium profile's DevTools websocket, for Playwright's connectOverCDP or
  // Puppeteer's connect (like Dolphin{anty}'s wsEndpoint). POST, so X-SMP guards it. The port
  // is the one nodriver opened on 127.0.0.1, reported by the worker's `ready` (ENGINE.md §7).
  app.post("/api/sessions/:id/cdp", async (req, res) => {
    const id = req.params.id;
    const rec = deps.manager.getSession(id);
    const live = orchestrator.live.get(id);
    if (!rec && !live) return res.status(404).json({ error: "profile not found" });
    const port = live?.handle?.cdpPort;
    if (!port) {
      // Records without `browser` are Stealth Firefox.
      const b = rec?.browser && rec.browser !== browsers.DEFAULT_BROWSER ? await browsers.find(rec.browser) : { kind: "stealth" };
      const error =
        b?.kind === "stealth"
          ? "Stealth Firefox has no CDP endpoint: its engine runs inside the app's worker. Use POST /api/sessions/:id/op"
          : b?.kind === "firefox-manual"
            ? `${b.name} has no CDP endpoint: it is a manual-only browser`
            : "profile is not running — launch it first";
      return res.status(409).json({ error });
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) });
      const { webSocketDebuggerUrl } = await r.json();
      if (!webSocketDebuggerUrl) throw new Error(`HTTP ${r.status}`);
      res.json({ wsEndpoint: webSocketDebuggerUrl });
    } catch (err) {
      res.status(502).json({ error: `the browser did not answer on its DevTools port (${err.message})` });
    }
  });

  /* ---------------- leak check ---------------- */

  const getJson = async (url, ms = 8000) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  };
  const dnsProbe = (session) => `https://${session}-${crypto.randomBytes(4).toString("hex")}.ipleak.net/dnsdetection/`;

  // This machine's own view over its direct connection: its real IPs, and the resolvers its
  // lookups arrive from. It changes rarely, so checks a few minutes apart share it.
  let baseline = null;
  async function machineBaseline() {
    if (baseline && Date.now() - baseline.at < 10 * 60_000) return baseline;
    const session = crypto.randomBytes(20).toString("hex");
    const [v4, v6, ...probes] = await Promise.all([
      getJson("https://api.ipify.org?format=json"),
      getJson("https://api6.ipify.org?format=json", 6000),
      ...Array.from({ length: 4 }, () => getJson(dnsProbe(session))),
    ]);
    const resolvers = new Set();
    for (const p of probes) if (p?.ip) for (const ip of Object.keys(p.ip)) resolvers.add(ip);
    baseline = {
      at: Date.now(),
      ipv4: v4?.ip && !String(v4.ip).includes(":") ? v4.ip : null,
      ipv6: v6?.ip && String(v6.ip).includes(":") ? v6.ip : null,
      resolvers: [...resolvers],
    };
    return baseline;
  }

  const geoCache = new Map();
  async function ipGeo(ip) {
    if (geoCache.has(ip)) return geoCache.get(ip);
    const g = await getJson(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,city,timezone`, 6000);
    const out = g?.status === "success" ? { country: g.country, countryCode: g.countryCode, city: g.city, timezone: g.timezone } : null;
    if (out) geoCache.set(ip, out);
    return out;
  }

  /** "+05:30"-style UTC offset of a zone right now, to accept aliases (Asia/Calcutta = Asia/Kolkata). */
  const offsetOf = (tz) => {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value;
    } catch {
      return null;
    }
  };

  /** The user's leak table: each row is pass (as wanted), fail (a leak) or warn (can't confirm). */
  function judge(page, base, geo, rec) {
    const rows = [];
    const add = (key, label, value, status, note = "") => rows.push({ key, label, value, status, note });
    const real = new Set([base.ipv4, base.ipv6].filter(Boolean));
    const proxied = Boolean(rec?.proxy?.host);

    if (!page.ipv4) add("ipv4", "Remote IPv4", "—", "warn", "No answer through the proxy");
    else if (real.has(page.ipv4)) add("ipv4", "Remote IPv4", page.ipv4, "fail", proxied ? "Your real IP: the proxy is bypassed" : "Your real IP: this profile has no proxy");
    else add("ipv4", "Remote IPv4", page.ipv4, "pass", geo ? [geo.city, geo.country].filter(Boolean).join(", ") : "The proxy's IP");

    if (!page.ipv6) add("ipv6", "Remote IPv6", "None", "pass", "No IPv6 route");
    else if (real.has(page.ipv6)) add("ipv6", "Remote IPv6", page.ipv6, "fail", "Your real IPv6 bypasses the proxy");
    else add("ipv6", "Remote IPv6", page.ipv6, "pass", "The proxy's IPv6");

    const pub = page.webrtc?.public || [];
    const leaked = pub.filter((ip) => real.has(ip));
    if (leaked.length) add("webrtc", "WebRTC public IP", leaked.join(", "), "fail", "Your real IP is exposed through WebRTC");
    else if (!pub.length) add("webrtc", "WebRTC public IP", "None", "pass", page.webrtc?.error ? "WebRTC unavailable" : proxied ? "WebRTC only through the proxy" : "No public candidate");
    else if (pub.every((ip) => ip === page.ipv4 || ip === page.ipv6)) add("webrtc", "WebRTC public IP", pub.join(", "), "pass", "Same as the proxy");
    else add("webrtc", "WebRTC public IP", pub.join(", "), "warn", "Not your IP, but not the proxy's either");

    const local = page.webrtc?.local || [];
    if (local.length) add("local", "Local IP", local.join(", "), "fail", "A LAN address is exposed through WebRTC");
    else add("local", "Local IP", page.webrtc?.mdns ? "Hidden (mDNS)" : "None", "pass");

    const dns = page.dns || [];
    const ownDns = new Set(base.resolvers || []);
    if (!dns.length) add("dns", "DNS", "—", "warn", page.dnsProbes ? "No resolver reported" : "The DNS test service didn't answer");
    else if (dns.some((ip) => ownDns.has(ip))) add("dns", "DNS", dns.join(", "), "fail", "Your own resolver answered: lookups bypass the proxy");
    else if (!ownDns.size) add("dns", "DNS", dns.join(", "), "warn", "Your own resolver couldn't be measured to compare");
    else add("dns", "DNS", dns.join(", "), "pass", "Not your ISP's resolver");

    const g = page.geolocation;
    if (g === "granted") {
      const spoof = rec?.geolocation === "spoof";
      add("geo", "Geolocation API", "Allowed", spoof ? "pass" : "fail", spoof ? "Spoofed to the proxy's location" : "Sites can read a location without asking");
    } else add("geo", "Geolocation API", g === "denied" ? "Blocked" : g === "prompt" ? "Asks first" : "Unavailable", "pass", g === "prompt" ? "Not granted" : "");

    if (!geo?.timezone) add("tz", "Timezone", page.timezone || "—", "warn", "Proxy location unknown");
    else if (geo.timezone === page.timezone || offsetOf(geo.timezone) === offsetOf(page.timezone)) add("tz", "Timezone", page.timezone, "pass", "Matches the proxy's location");
    else add("tz", "Timezone", page.timezone, "fail", `The proxy is in ${geo.timezone}`);

    const lang = page.language || page.languages?.[0] || "";
    const [code, region] = lang.split("-");
    if (!geo?.countryCode) add("lang", "Language", lang || "—", "warn", "Proxy location unknown");
    else if (region?.toUpperCase() === geo.countryCode || (COUNTRY_LANGS[geo.countryCode] || []).includes(String(code).toLowerCase())) {
      add("lang", "Language", (page.languages || [lang]).join(", "), "pass", `Consistent with ${geo.country}`);
    } else add("lang", "Language", (page.languages || [lang]).join(", "), "warn", `Unusual for ${geo.country}`);

    return rows;
  }

  // Runs in a throwaway tab of a running profile, so it needs an engine with automation.
  app.post("/api/sessions/:id/leakcheck", async (req, res) => {
    const id = req.params.id;
    const live = orchestrator.live.get(id);
    if (!live) return res.status(404).json({ error: "profile is not running — launch it first" });
    const rec = deps.manager.getSession(id);
    const [base, page] = await Promise.all([
      machineBaseline(),
      (async () => {
        let tab = null;
        try {
          tab = await live.handle.rpc("new_tab", { url: LEAK_PAGE }, 60_000 + START_ALLOWANCE_MS);
          return await live.handle.rpc("eval", { code: LEAK_SCRIPT, arg: crypto.randomBytes(20).toString("hex"), pageId: tab?.pageId }, 90_000);
        } catch (err) {
          return { error: err.message };
        } finally {
          // Older engines without close_tab keep the tab; the check itself is unaffected.
          if (tab?.pageId != null) live.handle.rpc("close_tab", { pageId: tab.pageId }, 10_000).catch(() => {});
        }
      })(),
    ]);
    if (page.error) return res.status(409).json({ error: `The leak check couldn't run in this browser: ${page.error}` });
    const geo = page.ipv4 ? await ipGeo(page.ipv4) : null;
    const rows = judge(page, base, geo, rec);
    const verdict = rows.some((r) => r.status === "fail") ? "leak" : rows.some((r) => r.status === "warn") ? "check" : "clean";
    const at = new Date().toISOString();
    const failed = rows.filter((r) => r.status === "fail").map((r) => r.label);
    deps.log(
      verdict === "leak" ? "error" : verdict === "check" ? "warn" : "success",
      "PROXY",
      verdict === "clean" ? "Leak check: clean" : verdict === "leak" ? `Leak check: ${failed.join(", ")} leaking` : "Leak check: passed with warnings",
      id
    );
    deps.manager.saveSessionPatch(id, { leakCheck: { at, verdict, failed } }).catch(() => {});
    res.json({ at, verdict, rows, engine: rec?.browser || "stealth-firefox" });
  });
};
