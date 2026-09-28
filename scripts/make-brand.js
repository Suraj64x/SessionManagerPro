// Renders assets/logo.svg into the app icon (assets/SessionManagerPro.ico) with headless
// Microsoft Edge — a throwaway profile, no window. Run after changing the logo:
//   node scripts/make-brand.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const ASSETS = path.join(ROOT, "assets");
const LOGO = fs.readFileSync(path.join(ASSETS, "logo.svg"), "utf8");
const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => fs.existsSync(p));
if (!EDGE) throw new Error("Microsoft Edge is needed to render the icons");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smp-brand-"));
let renders = 0;

/** Screenshots `html` at exactly w×h CSS pixels (scale 1) with a transparent background. */
function render(html, w, h) {
  // Own page, output and profile per call: msedge.exe can return before its child process
  // has written the file, and a lingering instance on a shared profile would take the next call.
  const n = ++renders;
  const page = path.join(tmp, `page${n}.html`);
  const out = path.join(tmp, `shot${n}.png`);
  fs.writeFileSync(page, `<!doctype html><html><body style="margin:0;background:transparent">${html}</body></html>`);
  execFileSync(
    EDGE,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--default-background-color=00000000",
      `--user-data-dir=${path.join(tmp, `profile${n}`)}`,
      `--window-size=${w},${h}`,
      `--screenshot=${out}`,
      pathToFileURL(page).href,
    ],
    { stdio: "ignore", timeout: 60_000 }
  );
  const until = Date.now() + 20_000;
  while (!fs.existsSync(out) || fs.statSync(out).size === 0) {
    if (Date.now() > until) throw new Error(`Edge wrote no screenshot for ${w}x${h}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); // let the write finish
  const png = fs.readFileSync(out);
  const size = [png.readUInt32BE(16), png.readUInt32BE(20)];
  if (size[0] !== w || size[1] !== h) throw new Error(`rendered ${size} instead of ${w}x${h}`);
  return png;
}

/** Decodes an 8-bit RGBA, non-interlaced PNG (what Chromium writes) into raw RGBA rows. */
function decodePng(png) {
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  if (png[24] !== 8 || png[25] !== 6 || png[28] !== 0) throw new Error("expected 8-bit RGBA, non-interlaced PNG");
  const idat = [];
  for (let at = 8; at < png.length; ) {
    const len = png.readUInt32BE(at);
    if (png.toString("latin1", at + 4, at + 8) === "IDAT") idat.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? px[y * stride + x - 4] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? px[(y - 1) * stride + x - 4] : 0;
      const p = a + b - c;
      const pred = [0, a, b, (a + b) >> 1, Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c][filter];
      px[y * stride + x] = (line[x] + pred) & 0xff;
    }
  }
  return { w, h, px };
}

/** A classic 32-bit DIB icon image (BGRA, bottom-up, plus an all-zero AND mask). */
function dib({ w, h, px }) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(w, 4);
  header.writeInt32LE(h * 2, 8); // colour + mask
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const colour = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const d = ((h - 1 - y) * w + x) * 4;
      colour[d] = px[s + 2];
      colour[d + 1] = px[s + 1];
      colour[d + 2] = px[s];
      colour[d + 3] = px[s + 3];
    }
  }
  const mask = Buffer.alloc((Math.ceil(w / 32) * 4) * h);
  return Buffer.concat([header, colour, mask]);
}

function ico(images) {
  const dir = Buffer.alloc(6 + 16 * images.length);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(images.length, 4);
  let offset = dir.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    dir[e] = size >= 256 ? 0 : size;
    dir[e + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([dir, ...images.map((i) => i.data)]);
}

const logoAt = (size) => LOGO.replace(/width="36" height="36"/, `width="${size}" height="${size}"`);

try {
  // 256 stays PNG (Explorer's large views); the small sizes are DIBs, which every Windows
  // API — including the tray's System.Drawing.Icon — reads.
  const images = [16, 20, 24, 32, 40, 48, 64, 256].map((size) => {
    const png = render(`<div style="display:block;width:${size}px;height:${size}px">${logoAt(size)}</div>`, size, size);
    return { size, data: size >= 256 ? png : dib(decodePng(png)) };
  });
  fs.writeFileSync(path.join(ASSETS, "SessionManagerPro.ico"), ico(images));
  console.log(`assets/SessionManagerPro.ico — ${images.map((i) => i.size).join(", ")} px`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
