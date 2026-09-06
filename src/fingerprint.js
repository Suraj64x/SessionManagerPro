const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const FPTS_DIR = path.resolve(__dirname, "..", "resources", "fpts");

const TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
];

function timezoneFromHost(host) {
  let n = 0;
  for (const ch of String(host)) n = (n + ch.charCodeAt(0)) % TIMEZONES.length;
  return TIMEZONES[n];
}

function listFptFiles() {
  if (!fs.existsSync(FPTS_DIR)) return [];
  return fs
    .readdirSync(FPTS_DIR)
    .filter((f) => f.endsWith(".json.gz") || f.endsWith(".json"));
}

function loadFptRaw(file) {
  const buf = fs.readFileSync(path.join(FPTS_DIR, file));
  const raw = file.endsWith(".gz") ? zlib.gunzipSync(buf) : buf;
  return JSON.parse(raw.toString("utf8"));
}

function parseLang(lang) {
  const parts = String(lang || "en-US")
    .split(",")
    .map((s) => s.split(";")[0].trim())
    .filter(Boolean);
  return {
    locale: parts[0] || "en-US",
    languages: parts.length ? parts : ["en-US", "en"],
  };
}

function decodeUserAgentData(b64) {
  if (!b64) return null;
  try {
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

async function lookupProxyGeo(proxy) {
  if (!proxy?.host) return null;
  try {
    const res = await fetch(
      `http://ip-api.com/json/${proxy.host}?fields=status,timezone,countryCode,lat,lon`,
      { signal: AbortSignal.timeout(2500) },
    );
    const data = await res.json();
    if (data.status === "success" && data.timezone) return data;
  } catch {
    // offline or rate-limited
  }
  return null;
}

async function buildFingerprint(file, proxy) {
  const raw = loadFptRaw(file);
  const attr = raw.attr || {};
  const ua = raw.ua || attr["navigator.userAgent"] || "";
  const chromeVersion = (ua.match(/Chrome\/([\d.]+)/) || [])[1] || "149.0.0.0";
  const { locale, languages } = parseLang(raw.lang);
  const geo = await lookupProxyGeo(proxy);
  const width = Number(attr["screen.width"] || raw.width || 1920);
  const height = Number(attr["screen.height"] || raw.height || 1080);
  const dpr = Number(attr["window.devicePixelRatio"] || 1) || 1;
  return {
    file,
    chromeVersion,
    userAgent: ua,
    platform: attr["navigator.platform"] || "Win32",
    locale,
    languages,
    timezone: geo?.timezone || (proxy?.host ? timezoneFromHost(proxy.host) : "America/New_York"),
    hardwareConcurrency: Number(attr.hardwareConcurrency || 8),
    deviceMemory: Number(attr.deviceMemory || 8),
    maxTouchPoints: Number(attr.maxTouchPoints || 0),
    vendor: attr["navigator.vendor"] || "Google Inc.",
    appVersion: attr["navigator.appVersion"] || "",
    viewport: { width, height, deviceScaleFactor: dpr },
    screen: {
      width,
      height,
      availWidth: Number(attr["screen.availWidth"] || width),
      availHeight: Number(attr["screen.availHeight"] || height),
      colorDepth: Number(attr["screen.colorDepth"] || 24),
      pixelDepth: Number(attr["screen.pixelDepth"] || 24),
    },
    webgl: {
      vendor: raw.webgl_properties?.unmaskedVendor || "Google Inc. (Intel)",
      renderer:
        raw.webgl_properties?.unmaskedRenderer ||
        "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    },
    userAgentData: decodeUserAgentData(raw.useragentdata),
    geo: geo
      ? { countryCode: geo.countryCode, lat: geo.lat, lon: geo.lon }
      : undefined,
  };
}

async function generateFingerprint(proxy, usedFiles = []) {
  const free = listFptFiles().filter((f) => !usedFiles.includes(f));
  if (!free.length) throw new Error("no unused fingerprints left in resources/fpts");
  return buildFingerprint(free[Math.floor(Math.random() * free.length)], proxy);
}

function chromeMajor(fp) {
  return String(fp.chromeVersion || "149").split(".")[0];
}

async function applyFingerprint(page, fp) {
  const major = chromeMajor(fp);
  const uad = fp.userAgentData;
  await page.setUserAgent(fp.userAgent);
  await page.setExtraHTTPHeaders({
    "Accept-Language": `${fp.locale},${fp.languages.filter((l) => l !== fp.locale).join(",")};q=0.9`,
  });
  const client = await page.createCDPSession();
  await client.send("Emulation.setTimezoneOverride", { timezoneId: fp.timezone });
  await client.send("Emulation.setLocaleOverride", { locale: fp.locale });
  await client.send("Emulation.setUserAgentOverride", {
    userAgent: fp.userAgent,
    acceptLanguage: fp.locale,
    platform: fp.platform === "Win32" ? "Windows" : fp.platform,
    userAgentMetadata: uad
      ? {
          brands: uad.brands || [],
          fullVersion: uad.fullVersion || fp.chromeVersion,
          fullVersionList: uad.fullVersionList || [],
          platform: uad.platform || "Windows",
          platformVersion: uad.platformVersion || "15.0.0",
          architecture: uad.architecture || "x86",
          model: uad.model || "",
          mobile: Boolean(uad.mobile),
          bitness: uad.bitness || "64",
          wow64: Boolean(uad.wow64),
        }
      : {
          brands: [
            { brand: "Google Chrome", version: major },
            { brand: "Chromium", version: major },
            { brand: "Not.A/Brand", version: "24" },
          ],
          fullVersion: fp.chromeVersion,
          platform: "Windows",
          platformVersion: "15.0.0",
          architecture: "x86",
          model: "",
          mobile: false,
          bitness: "64",
          wow64: false,
        },
  });
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: fp.viewport.width,
    height: fp.viewport.height,
    deviceScaleFactor: fp.viewport.deviceScaleFactor,
    mobile: false,
  });
  if (fp.geo?.lat != null && fp.geo?.lon != null) {
    await client.send("Emulation.setGeolocationOverride", {
      latitude: fp.geo.lat,
      longitude: fp.geo.lon,
      accuracy: 80,
    });
  }
  await page.evaluateOnNewDocument((fp) => {
    const nav = {
      hardwareConcurrency: fp.hardwareConcurrency,
      deviceMemory: fp.deviceMemory,
      platform: fp.platform,
      language: fp.locale,
      languages: fp.languages,
      userAgent: fp.userAgent,
      vendor: fp.vendor || "Google Inc.",
      maxTouchPoints: fp.maxTouchPoints || 0,
    };
    if (fp.appVersion) nav.appVersion = fp.appVersion;
    for (const [key, value] of Object.entries(nav)) {
      Object.defineProperty(navigator, key, { get: () => value });
    }
    for (const [key, value] of Object.entries(fp.screen)) {
      Object.defineProperty(screen, key, { get: () => value });
    }
    const proto = WebGLRenderingContext.prototype;
    const original = proto.getParameter;
    proto.getParameter = function (param) {
      if (param === 37445) return fp.webgl.vendor;
      if (param === 37446) return fp.webgl.renderer;
      return original.call(this, param);
    };
  }, fp);
}

module.exports = {
  FPTS_DIR,
  listFptFiles,
  buildFingerprint,
  generateFingerprint,
  applyFingerprint,
};
