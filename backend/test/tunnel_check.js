// Checks backend/src/tunnel.js against in-process fakes on 127.0.0.1 only: an HTTP and an HTTPS
// proxy (Basic auth; CONNECT plus absolute-form forwarding, and one that allows CONNECT to the TLS
// port only, like providers that refuse CONNECT to port 80), a SOCKS5 proxy (username/password, plus a no-auth one), a SOCKS4a
// proxy, a plain and a TLS target (the self-signed test cert below). No internet. When Chrome is
// installed it also loads pages through the tunnel in headless Chrome (temp profile under the
// OS temp dir, no window), then kills it and removes the profile.
//
//   node backend/test/tunnel_check.js
"use strict";
const fs = require("fs");
const os = require("os");
const net = require("net");
const tls = require("tls");
const http = require("http");
const https = require("https");
const path = require("path");
const { once } = require("events");
const { spawn, execFileSync } = require("child_process");
const { startTunnel, connectVia, fetchVia, isLoopback } = require("../src/tunnel");

// Test-only self-signed cert: CN tls.test, SAN tls.test / localhost / 127.0.0.1, valid 2020–2120.
const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgsGXqlU+jUWXFclAM
U5fD4KiJ7COhcKfazp2dwPG3xkahRANCAARtoDlyVtItge6JWo7qbjM16b+ou7VM
FByf93xoRAjHH78B9EZ9hoco6++8wfjxOb7XAohwNDRQsiO/vkizgXfU
-----END PRIVATE KEY-----`;
const CERT = `-----BEGIN CERTIFICATE-----
MIIBozCCAUmgAwIBAgIUE4i29pyxprXSiGyZkbk0T/T5C5YwCgYIKoZIzj0EAwIw
EzERMA8GA1UEAwwIdGxzLnRlc3QwIBcNMjAwMTAxMDAwMDAwWhgPMjEyMDAxMDEw
MDAwMDBaMBMxETAPBgNVBAMMCHRscy50ZXN0MFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEbaA5clbSLYHuiVqO6m4zNem/qLu1TBQcn/d8aEQIxx+/AfRGfYaHKOvv
vMH48Tm+1wKIcDQ0ULIjv75Is4F31KN5MHcwHQYDVR0OBBYEFAaHH389KIQxBgcs
XB9F7qzfXgouMB8GA1UdIwQYMBaAFAaHH389KIQxBgcsXB9F7qzfXgouMCQGA1Ud
EQQdMBuCCHRscy50ZXN0gglsb2NhbGhvc3SHBH8AAAEwDwYDVR0TAQH/BAUwAwEB
/zAKBggqhkjOPQQDAgNIADBFAiBlhlTU2uSgIUtvcIIR1b917YnyvqQBvRfYwkOh
6OV/3AIhAJbMp1ndg7TWiPpv0IWGFr6PzfmaL5STEV/neH5Q2FKX
-----END CERTIFICATE-----`;
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const USER = "qa-user";
const PASS = { http: "Http-S3cret!pw", socks5: "Socks-S3cret!pw", wrong: "Wr0ng-S3cret!pw" };

const results = [];
const check = (name, ok, detail = "") =>
  results.push({ name, ok: !!ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail)?.slice(0, 400) });
process.on("uncaughtException", (err) => check("no uncaught exception", false, err.stack));
process.on("unhandledRejection", (err) => check("no unhandled rejection", false, err?.stack || String(err)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 5000) => {
  for (const end = Date.now() + ms; !fn(); await sleep(20)) if (Date.now() > end) return false;
  return true;
};
const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
const closed = (sock, ms = 5000) =>
  new Promise((resolve) => {
    if (sock.destroyed && sock.closed) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    sock.once("close", () => (clearTimeout(t), resolve(true)));
  });

// Paused-mode reads for the fakes and the raw clients.
async function readN(sock, n) {
  if (!n) return Buffer.alloc(0);
  for (;;) {
    const chunk = sock.read(n);
    if (chunk) return chunk;
    if (sock.readableEnded || sock.destroyed) throw new Error("closed");
    await new Promise((resolve) => {
      const go = () => (sock.off("readable", go).off("end", go).off("close", go), resolve());
      sock.on("readable", go).on("end", go).on("close", go);
    });
  }
}
async function readZ(sock) {
  let s = "";
  for (let c; (c = (await readN(sock, 1))[0]) !== 0; ) s += String.fromCharCode(c);
  return s;
}
async function readAll(sock, ms = 5000) {
  const chunks = [];
  sock.on("data", (c) => chunks.push(c));
  await closed(sock, ms);
  return Buffer.concat(chunks).toString();
}

// ---- targets -------------------------------------------------------------------------------
let targetConns = 0;
const seen = []; // { url, rawHeaders } of every request a target answered
function answer(req, res) {
  seen.push({ url: req.url, rawHeaders: req.rawHeaders });
  if (req.url === "/echo") return req.pipe(res);
  if (req.url === "/big") return res.end(Buffer.alloc(5 << 20, 98));
  res.end(`hello ${req.url}`);
}
const target = http.createServer(answer);
const tlsTarget = https.createServer({ key: KEY, cert: CERT }, answer);
for (const s of [target, tlsTarget]) s.on("connection", () => targetConns++);

// ---- fake upstream proxies -----------------------------------------------------------------
const ports = {};
// What the fakes may dial; anything else is refused, so nothing ever leaves the machine.
const reachable = (host, port) =>
  ["target.test", "tls.test", "127.0.0.1", "0:0:0:0:0:0:0:1"].includes(host) && [ports.target, ports.tls].includes(port);
function relay(sock, port, ok, head) {
  const out = net.connect(port, "127.0.0.1", () => {
    sock.write(ok);
    if (head?.length) out.write(head);
    sock.pipe(out);
    out.pipe(sock);
  });
  out.on("error", () => sock.destroy());
  sock.on("close", () => out.destroy());
}
// "banner.test": the proxy's reply and the first bytes of the stream arrive in one write, then echo.
const banner = (sock, ok) => (sock.write(Buffer.concat([Buffer.from(ok), Buffer.from("BANNER\n")])), sock.pipe(sock));

function fakeHttpProxy(server, log, { connectPorts } = {}) {
  const want = `Basic ${Buffer.from(`${USER}:${PASS.http}`).toString("base64")}`;
  // Absolute-form requests are forwarded like a real proxy: login checked, Proxy-* headers stripped.
  server.on("request", (req, res) => {
    const auth = req.headers["proxy-authorization"] === want;
    log.push({ method: req.method, url: req.url, auth });
    if (!auth) return res.writeHead(407, { "Proxy-Authenticate": "Basic" }).end();
    let u = null;
    try {
      u = new URL(req.url);
    } catch {}
    const port = Number(u?.port || 80);
    if (u?.protocol !== "http:" || !reachable(u.hostname, port)) return res.writeHead(502).end();
    const headers = req.rawHeaders.filter((_, i, a) => !/^proxy-/i.test(a[i - (i % 2)]));
    const out = http.request({ host: "127.0.0.1", port, method: req.method, path: u.pathname + u.search, headers, setHost: false }, (r) => {
      res.writeHead(r.statusCode, r.rawHeaders);
      r.pipe(res);
    });
    out.on("error", () => res.writeHead(502).end());
    req.pipe(out);
  });
  server.on("connect", (req, sock, head) => {
    sock.on("error", () => {});
    log.push({ method: "CONNECT", url: req.url, auth: req.headers["proxy-authorization"] === want });
    if (req.headers["proxy-authorization"] !== want) {
      return sock.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\nContent-Length: 0\r\n\r\n");
    }
    const i = req.url.lastIndexOf(":");
    const host = req.url.slice(0, i);
    const port = Number(req.url.slice(i + 1));
    if (connectPorts && !connectPorts.includes(port)) return sock.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    const ok = "HTTP/1.1 200 Connection Established\r\n\r\n";
    if (host === "banner.test") return banner(sock, ok);
    if (!reachable(host, port)) return sock.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
    relay(sock, port, ok, head);
  });
  return server;
}

const hex6 = (b) => b.toString("hex").match(/.{4}/g).map((g) => parseInt(g, 16).toString(16)).join(":");
function fakeSocks5(user, pass, log) {
  return net.createServer(async (sock) => {
    sock.on("error", () => {});
    try {
      const [, n] = await readN(sock, 2);
      const methods = [...(await readN(sock, n))];
      const method = user ? 2 : 0;
      if (!methods.includes(method)) return sock.end(Buffer.from([5, 0xff]));
      sock.write(Buffer.from([5, method]));
      if (user) {
        const [, ulen] = await readN(sock, 2);
        const u = (await readN(sock, ulen)).toString();
        const [plen] = await readN(sock, 1);
        const p = (await readN(sock, plen)).toString();
        log.push({ auth: u === user && p === pass });
        if (u !== user || p !== pass) return sock.end(Buffer.from([1, 1]));
        sock.write(Buffer.from([1, 0]));
      }
      const [, , , atyp] = await readN(sock, 4);
      const host =
        atyp === 1 ? [...(await readN(sock, 4))].join(".") : atyp === 3 ? (await readN(sock, (await readN(sock, 1))[0])).toString() : hex6(await readN(sock, 16));
      const port = (await readN(sock, 2)).readUInt16BE(0);
      log.push({ atyp, host, port });
      const ok = Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, port >> 8, port & 255]);
      if (host === "banner.test") return banner(sock, ok);
      if (!reachable(host, port)) return sock.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0]));
      relay(sock, port, ok);
    } catch {
      sock.destroy();
    }
  });
}

function fakeSocks4(log) {
  return net.createServer(async (sock) => {
    sock.on("error", () => {});
    try {
      const head = await readN(sock, 8);
      const port = head.readUInt16BE(2);
      const ip = [...head.subarray(4, 8)];
      const userid = await readZ(sock);
      const socks4a = ip[0] === 0 && ip[1] === 0 && ip[2] === 0 && ip[3] !== 0;
      const host = socks4a ? await readZ(sock) : ip.join(".");
      log.push({ userid, socks4a, host, port });
      const ok = Buffer.from([0, 0x5a, port >> 8, port & 255, 127, 0, 0, 1]);
      if (host === "banner.test") return banner(sock, ok);
      if (!reachable(host, port)) return sock.end(Buffer.from([0, 0x5b, 0, 0, 0, 0, 0, 0]));
      relay(sock, port, ok);
    } catch {
      sock.destroy();
    }
  });
}

// ---- clients -------------------------------------------------------------------------------
async function tunnelConnect(port, authority) {
  const sock = net.connect(port, "127.0.0.1");
  sock.on("error", () => {});
  await once(sock, "connect");
  sock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  let head = "";
  try {
    while (!head.endsWith("\r\n\r\n")) head += (await readN(sock, 1)).toString("latin1");
  } catch {
    return { status: 0, sock, head };
  }
  return { status: Number(head.split(" ")[1]), sock, head };
}
async function getOverTunnel(port, authority, pathName) {
  const { status, sock } = await tunnelConnect(port, authority);
  if (status !== 200) return sock.destroy(), { status };
  sock.write(`GET ${pathName} HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`);
  const text = await readAll(sock);
  return { status, body: text.split("\r\n\r\n").slice(1).join("\r\n\r\n") };
}
async function tlsGetOverTunnel(port, authority, pathName) {
  const { status, sock } = await tunnelConnect(port, authority);
  if (status !== 200) return sock.destroy(), `status ${status}`;
  const t = tls.connect({ socket: sock, servername: "tls.test", ca: CERT });
  t.on("error", () => {});
  t.write(`GET ${pathName} HTTP/1.1\r\nHost: tls.test\r\nConnection: close\r\n\r\n`);
  return readAll(t);
}
function plainGet(port, url) {
  return new Promise((resolve) => {
    http
      .get({ host: "127.0.0.1", port, path: url, headers: { host: new URL(url).host }, agent: false }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
      })
      .on("error", (err) => resolve({ status: 0, body: err.message }));
  });
}
// Raw bytes in, everything until the tunnel closes the socket out.
async function exchange(port, raw, ms = 3000) {
  const sock = net.connect(port, "127.0.0.1");
  sock.on("error", () => {});
  sock.write(raw);
  const chunks = [];
  sock.on("data", (c) => chunks.push(c));
  const didClose = await closed(sock, ms);
  sock.destroy();
  return { text: Buffer.concat(chunks).toString("latin1"), closed: didClose };
}
function readUntil(sock, text, ms = 3000) {
  let got = "";
  sock.on("data", (d) => (got += d));
  return waitFor(() => got.includes(text), ms).then(() => got);
}
const tryConnect = (host, port, ms) =>
  new Promise((resolve) => {
    const s = net.connect(port, host);
    const end = (ok) => (s.destroy(), resolve(ok));
    s.setTimeout(ms, () => end(false));
    s.on("connect", () => end(true)).on("error", () => end(false));
  });
const errors = []; // every error text the module produced; checked for passwords at the end
const failure = (p) => p.then(() => null, (err) => (errors.push(err.message), err));

// ---- checks --------------------------------------------------------------------------------
async function main() {
  ports.target = await listen(target);
  ports.tls = await listen(tlsTarget);
  const httpLog = [];
  const httpsLog = [];
  const s5Log = [];
  const s4Log = [];
  const holes = [];
  const P = {
    http: await listen(fakeHttpProxy(http.createServer(), httpLog)),
    https: await listen(fakeHttpProxy(https.createServer({ key: KEY, cert: CERT }), httpsLog)),
    socks5: await listen(fakeSocks5(USER, PASS.socks5, s5Log)),
    socks5open: await listen(fakeSocks5(null, null, s5Log)),
    socks4: await listen(fakeSocks4(s4Log)),
    hole: await listen(net.createServer((s) => (holes.push(s), s.resume(), s.on("error", () => {})))), // accepts, never answers
  };
  const deadServer = net.createServer();
  const dead = await listen(deadServer);
  await new Promise((r) => deadServer.close(r)); // nothing listens here any more

  const UP = {
    http: { scheme: "http", host: "127.0.0.1", port: P.http, username: USER, password: PASS.http },
    https: { scheme: "https", host: "127.0.0.1", port: P.https, username: USER, password: PASS.http, ca: CERT },
    socks5: { scheme: "socks5", host: "127.0.0.1", port: P.socks5, username: USER, password: PASS.socks5 },
    socks4: { scheme: "socks4", host: "127.0.0.1", port: P.socks4, username: USER, password: "" },
  };
  const opts = { onError: (e) => errors.push(e.message) };
  const T = `target.test:${ports.target}`;
  const S = `tls.test:${ports.tls}`;

  // Every upstream kind: CONNECT, plain http, TLS end to end, fetchVia, leftover handshake bytes.
  for (const [kind, up] of Object.entries(UP)) {
    const snaps = [];
    const t = await startTunnel(up, { ...opts, onStats: (s) => snaps.push(s) });
    const c = await getOverTunnel(t.port, T, `/connect-${kind}`);
    check(`${kind}: CONNECT through the tunnel reaches the target`, c.status === 200 && c.body === `hello /connect-${kind}`, c);
    const p = await plainGet(t.port, `http://${T}/plain-${kind}?q=1`);
    check(`${kind}: plain http:// request reaches the target`, p.status === 200 && p.body === `hello /plain-${kind}?q=1`, p);
    const tl = await tlsGetOverTunnel(t.port, S, `/tls-${kind}`);
    check(`${kind}: TLS end to end through CONNECT (verified)`, tl.endsWith(`hello /tls-${kind}`), tl);
    const f1 = await fetchVia(up, `http://${T}/fetch-${kind}`).catch((e) => e.message);
    check(`${kind}: fetchVia http://`, f1.status === 200 && f1.body === `hello /fetch-${kind}`, f1);
    const f2 = await fetchVia(up, `https://${S}/fetchs-${kind}`, { ca: CERT }).catch((e) => e.message);
    check(`${kind}: fetchVia https:// (SNI, verified against the test CA)`, f2.status === 200 && f2.body === `hello /fetchs-${kind}`, f2);
    const b = await connectVia(up, "banner.test", 7);
    b.write("ping\n");
    const got = await readUntil(b, "ping\n");
    b.destroy();
    check(`${kind}: bytes that arrive with the proxy's reply are kept`, got === "BANNER\nping\n", got);
    await waitFor(() => t.stats().active === 0, 2000);
    const st = t.stats();
    check(`${kind}: stats count the tunnels and bytes`, st.total === 3 && st.active === 0 && st.bytesUp > 0 && st.bytesDown > 0 && st.lastError === null, st);
    check(`${kind}: onStats ran on every open and close, last call = stats()`, snaps.length === 6 && JSON.stringify(snaps.at(-1)) === JSON.stringify(st), snaps);
    await t.close();
  }

  // What the upstreams and the target saw.
  const names = s5Log.filter((e) => e.host?.endsWith(".test"));
  check("socks5: every name went as ATYP 3 (the proxy resolved it, no local DNS)", names.length >= 5 && names.every((e) => e.atyp === 3), names);
  check("socks4: names went as SOCKS4a with the userid", s4Log.filter((e) => e.host.endsWith(".test")).every((e) => e.socks4a && e.userid === USER), s4Log);
  check(
    "http/https proxies got CONNECT for tunnels and absolute-form plain http, always with the login",
    [...httpLog, ...httpsLog].every((e) => e.auth && (e.method === "CONNECT" || /^http:\/\//.test(e.url))) && [...httpLog, ...httpsLog].some((e) => e.method === "GET"),
    [...httpLog, ...httpsLog]
  );
  check("the target never saw proxy headers", seen.every((r) => !r.rawHeaders.some((h, i) => i % 2 === 0 && /^proxy-/i.test(h))), seen);

  // Address types.
  let e4 = await connectVia(UP.socks5, "127.0.0.1", ports.target).then((s) => (s.destroy(), null), (e) => e.message);
  check("socks5: an IPv4 literal goes as ATYP 1", !e4 && s5Log.at(-1).atyp === 1 && s5Log.at(-1).host === "127.0.0.1", e4 || s5Log.at(-1));
  e4 = await connectVia(UP.socks5, "[::1]", ports.target).then((s) => (s.destroy(), null), (e) => e.message);
  check("socks5: an IPv6 literal goes as ATYP 4", !e4 && s5Log.at(-1).atyp === 4 && s5Log.at(-1).host === "0:0:0:0:0:0:0:1", e4 || s5Log.at(-1));
  e4 = await failure(connectVia(UP.socks5, "2001:db8::a:1.2.3.4", ports.target));
  check("socks5: an unreachable host is refused with the proxy's reason", /host unreachable/.test(e4?.message) && s5Log.at(-1).host === "2001:db8:0:0:0:a:102:304", [e4?.message, s5Log.at(-1)]);
  e4 = await connectVia(UP.socks4, "127.0.0.1", ports.target).then((s) => (s.destroy(), null), (e) => e.message);
  check("socks4: an IPv4 literal goes as plain SOCKS4", !e4 && s4Log.at(-1).socks4a === false && s4Log.at(-1).host === "127.0.0.1", e4 || s4Log.at(-1));
  const open = await fetchVia({ ...UP.socks5, port: P.socks5open }, `http://${T}/open`).catch((e) => e.message);
  check("socks5: a no-auth proxy works even when credentials are set", open.body === "hello /open", open);
  e4 = await failure(fetchVia({ ...UP.socks5, username: "", password: "" }, `http://${T}/`));
  check("socks5: a proxy that needs a login says so", /requires a username\/password/.test(e4?.message), e4?.message);
  e4 = await failure(fetchVia(UP.socks5, `https://${S}/`));
  check("fetchVia https verifies certificates by default", /self-signed|certificate/i.test(e4?.message), e4?.message);

  // Header handling on the plain path: hop-by-hop dropped, order kept, Proxy-Connection → Connection.
  {
    const t = await startTunnel(UP.socks5, opts);
    const r = await exchange(
      t.port,
      `GET http://${T}/order HTTP/1.1\r\nHost: ${T}\r\nProxy-Connection: keep-alive\r\nUser-Agent: qa-agent\r\nAccept: */*\r\nProxy-Authorization: Basic cXE6cXE=\r\n\r\n`,
      1000
    );
    const raw = seen.find((x) => x.url === "/order")?.rawHeaders;
    check("plain: headers reach the target in order, proxy headers dropped", JSON.stringify(raw) === JSON.stringify(["Host", T, "Connection", "keep-alive", "User-Agent", "qa-agent", "Accept", "*/*"]), [raw, r.text.slice(0, 80)]);
    check("plain: the response adds no Date the origin did not send", /hello \/order$/.test(r.text) && (r.text.match(/^date:/gim) || []).length === 1, r.text);
    await t.close();
  }

  // Kill switch: wrong login, upstream down, unverifiable upstream → 502, never a direct connection.
  // The target here is 127.0.0.1, which a direct fallback could reach; it must see nothing.
  const before = targetConns;
  const fallbacks = [
    ["http proxy, wrong password", { ...UP.http, password: PASS.wrong }, /rejected the username\/password \(407\)/],
    ["https proxy, wrong password", { ...UP.https, password: PASS.wrong }, /rejected the username\/password/],
    ["socks5 proxy, wrong password", { ...UP.socks5, password: PASS.wrong }, /rejected the username\/password/],
    ["socks5 proxy down", { ...UP.socks5, port: dead }, /ECONNREFUSED/],
    ["http proxy down", { ...UP.http, port: dead }, /ECONNREFUSED/],
    ["https proxy with an unverifiable certificate", { ...UP.https, ca: undefined }, /self-signed|certificate/i],
  ];
  for (const [name, up, why] of fallbacks) {
    const seenErrors = errors.length;
    const t = await startTunnel(up, opts);
    const c = await tunnelConnect(t.port, `127.0.0.1:${ports.target}`);
    const cClosed = await closed(c.sock, 3000);
    const p = await plainGet(t.port, `http://127.0.0.1:${ports.target}/direct`);
    await waitFor(() => t.stats().active === 0, 2000);
    const st = t.stats();
    // An HTTP proxy that refuses the login still took the connection for the plain request.
    const reached = /^https? proxy, wrong password/.test(name) ? 1 : 0;
    check(`kill switch (${name}): CONNECT → 502 and closed, plain → 502`, c.status === 502 && cClosed && p.status === 502 && p.body === "502 Bad Gateway\n", [c.head, p]);
    check(`kill switch (${name}): onError and lastError say why`, errors.length === seenErrors + 2 && why.test(st.lastError) && st.active === 0 && st.total === reached, st);
    await t.close();
  }
  check("kill switch: the target saw no connection at all", targetConns === before, `${targetConns - before} connections`);

  // A provider that allows CONNECT to the TLS port only (it refuses CONNECT to port 80, as the
  // user's does): plain http:// still works, sent in absolute form with the login.
  {
    const strictLog = [];
    const up = { ...UP.http, port: await listen(fakeHttpProxy(http.createServer(), strictLog, { connectPorts: [ports.tls] })) };
    const t = await startTunnel(up, opts);
    const p = await plainGet(t.port, `http://${T}/strict`);
    const tl = await tlsGetOverTunnel(t.port, S, "/strict-tls");
    const f = await fetchVia(up, `http://${T}/strict-fetch?x=1`).catch((e) => e.message);
    const w = await failure(fetchVia({ ...up, password: PASS.wrong }, `http://${T}/strict-wrong`));
    check("CONNECT-to-443-only proxy: plain http:// works (absolute form, with the login)", p.status === 200 && p.body === "hello /strict" && strictLog.some((e) => e.method === "GET" && e.auth), [p, strictLog]);
    check("CONNECT-to-443-only proxy: https still tunnels", tl.endsWith("hello /strict-tls"), tl);
    check("CONNECT-to-443-only proxy: fetchVia http:// works", f.status === 200 && f.body === "hello /strict-fetch?x=1", f);
    check("CONNECT-to-443-only proxy: fetchVia with a wrong login says so", /rejected the username\/password \(407\)/.test(w?.message), w?.message);
    await t.close();
  }

  // A silent proxy: connectVia gives up at its timeout and closes the socket.
  {
    const t0 = Date.now();
    const e = await failure(connectVia({ scheme: "socks5", host: "127.0.0.1", port: P.hole }, "target.test", 80, 300));
    check("connectVia times out on a silent proxy", /no answer within 0\.3s/.test(e?.message) && Date.now() - t0 < 2000, e?.message);
    check("… and closes the connection to it", await closed(holes[0], 2000));
  }

  // Malformed requests: 400 and the socket is closed; nothing is dialled.
  {
    const t = await startTunnel({ scheme: "socks5", host: "127.0.0.1", port: P.hole }, opts);
    const holesBefore = holes.length;
    for (const [name, raw] of [
      ["garbage", "HELLO THERE\r\n\r\n"],
      ["origin-form GET", "GET / HTTP/1.1\r\nHost: x\r\n\r\n"],
      ["https:// absolute URI", "GET https://target.test/ HTTP/1.1\r\nHost: target.test\r\n\r\n"],
      ["CONNECT without a port", "CONNECT target.test HTTP/1.1\r\nHost: target.test\r\n\r\n"],
      ["CONNECT with junk in the host", "CONNECT tar%0d%0aget.test:80 HTTP/1.1\r\n\r\n"],
      ["CONNECT with a bad port", "CONNECT target.test:99999 HTTP/1.1\r\n\r\n"],
    ]) {
      const r = await exchange(t.port, raw);
      check(`malformed (${name}) → 400 and the socket closes`, r.text.startsWith("HTTP/1.1 400") && r.closed, r);
    }
    check("malformed requests dialled nothing", holes.length === holesBefore && t.stats().total === 0, holes.length - holesBefore);
    await t.close();
  }

  // Loopback only.
  check("isLoopback accepts 127.0.0.1, ::1, ::ffff:127.0.0.1", isLoopback("127.0.0.1") && isLoopback("::1") && isLoopback("::ffff:127.0.0.1"));
  check("isLoopback refuses everything else", ![undefined, "", "0.0.0.0", "127.0.0.2", "10.0.0.5", "192.168.1.10", "::ffff:192.168.1.10", "fe80::1", "8.8.8.8"].some(isLoopback));
  {
    const t = await startTunnel(UP.socks5, opts);
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i.family === "IPv4" && !i.internal)?.address;
    if (lan) check(`the tunnel cannot be reached on ${lan} (listens on 127.0.0.1 only)`, !(await tryConnect(lan, t.port, 2000)));
    await t.close();
  }

  // Many concurrent connections.
  {
    const t = await startTunnel(UP.socks5, opts);
    const many = await Promise.all(Array.from({ length: 50 }, (_, i) => getOverTunnel(t.port, T, `/many-${i}`)));
    check("50 concurrent CONNECTs all reach the target", many.every((r, i) => r.body === `hello /many-${i}`), many.filter((r, i) => r.body !== `hello /many-${i}`));
    const plains = await Promise.all(Array.from({ length: 20 }, (_, i) => plainGet(t.port, `http://${T}/pmany-${i}`)));
    check("20 concurrent plain requests all reach the target", plains.every((r, i) => r.body === `hello /pmany-${i}`), plains.filter((r, i) => r.body !== `hello /pmany-${i}`));
    await waitFor(() => t.stats().active === 0, 3000);
    check("every tunnel is closed afterwards", t.stats().active === 0 && t.stats().total === 70, t.stats());
    await t.close();
  }

  // Byte counters, live and after close.
  {
    const t = await startTunnel(UP.socks5, opts);
    const { sock } = await tunnelConnect(t.port, T);
    const payload = Buffer.alloc(200_000, 97);
    let got = 0;
    sock.on("data", (d) => (got += d.length));
    sock.write(`POST /echo HTTP/1.1\r\nHost: ${T}\r\nContent-Length: ${payload.length}\r\n\r\n`);
    sock.write(payload);
    await waitFor(() => got >= payload.length, 5000);
    const live = t.stats();
    check("stats: live bytes of an open tunnel", live.active === 1 && live.bytesUp >= 200_000 && live.bytesDown >= 200_000, live);
    sock.destroy();
    await waitFor(() => t.stats().active === 0, 3000);
    const after = t.stats();
    check("stats: bytes kept after the tunnel closed", after.active === 0 && after.total === 1 && after.bytesUp >= live.bytesUp && after.bytesDown >= live.bytesDown, after);

    // The target sends 5 MiB and closes while the reader is stalled: nothing may be cut off.
    const big = await tunnelConnect(t.port, T);
    big.sock.write(`GET /big HTTP/1.1\r\nHost: ${T}\r\nConnection: close\r\n\r\n`);
    await sleep(500);
    const text = await readAll(big.sock, 10_000);
    const body = text.slice(text.indexOf("\r\n\r\n") + 4);
    check("a 5 MiB response to a stalled reader arrives complete when the target closes", body.length === 5 << 20, `${body.length} bytes`);
    await t.close();
  }

  // close(): kills open tunnels, idle clients and pending handshakes; frees the port; idempotent.
  {
    const t = await startTunnel(UP.socks5, opts);
    const open3 = await Promise.all([1, 2, 3].map(() => tunnelConnect(t.port, T)));
    const idle = net.connect(t.port, "127.0.0.1").on("error", () => {});
    await once(idle, "connect");
    const socks = [...open3.map((x) => x.sock), idle];
    const allClosed = Promise.all(socks.map((s) => closed(s, 2000)));
    check("close(): tunnels were open", open3.every((x) => x.status === 200) && t.stats().active === 3, t.stats());
    await Promise.all([t.close(), t.close()]);
    await t.close();
    check("close(): every client socket closed", (await allClosed).every(Boolean));
    check("close(): no tunnel left", t.stats().active === 0, t.stats());
    const rebind = net.createServer();
    const freed = await new Promise((r) => rebind.once("error", () => r(false)).listen(t.port, "127.0.0.1", () => rebind.close(() => r(true))));
    check("close(): the port is free again", freed);

    const hung = await startTunnel({ scheme: "socks5", host: "127.0.0.1", port: P.hole }, opts);
    const errorsBefore = errors.length;
    const holesBefore = holes.length;
    const pending = net.connect(hung.port, "127.0.0.1").on("error", () => {});
    pending.write(`CONNECT ${T} HTTP/1.1\r\nHost: ${T}\r\n\r\n`);
    await waitFor(() => holes.length > holesBefore, 3000);
    await hung.close();
    check("close(): a pending handshake is aborted on both sides", (await closed(pending, 2000)) && (await closed(holes.at(-1), 2000)));
    check("close(): an abort is not reported as an upstream error", errors.length === errorsBefore, errors.slice(errorsBefore));
  }

  // Input checks.
  check("startTunnel refuses an unusable upstream", /invalid upstream proxy/.test((await failure(startTunnel({ scheme: "ftp", host: "x", port: 1 })))?.message));
  check("connectVia refuses a target that could inject into CONNECT", /invalid target/.test((await failure(connectVia(UP.http, "a\r\nX: y", 80)))?.message));

  await chromeChecks(UP, s5Log, dead);

  const texts = errors.filter(Boolean);
  const secrets = Object.values(PASS).flatMap((p) => [p, encodeURIComponent(p), Buffer.from(`${USER}:${p}`).toString("base64")]);
  check(`no password (plain, URL-encoded or Basic) in any of the ${texts.length} error texts`, texts.length >= 12 && !texts.some((m) => secrets.some((s) => m.includes(s))), texts);
}

// ---- real browser --------------------------------------------------------------------------
function dumpDom(dir, proxyPort, url, extra = []) {
  return new Promise((resolve) => {
    const args = [
      "--headless=new",
      `--user-data-dir=${dir}`,
      `--proxy-server=http://127.0.0.1:${proxyPort}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-extensions",
      "--disable-breakpad",
      ...extra,
      "--dump-dom",
      url,
    ];
    const child = spawn(CHROME, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on("error", () => {});
    child.on("close", () => (clearTimeout(timer), resolve(out)));
  });
}
// Kills every chrome.exe started with this test's profile dir; returns how many there were.
function killChrome(dir) {
  const ps = `$p = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${path.basename(dir)}*' }); $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; $p.Count`;
  try {
    return Number(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", timeout: 30_000 }).trim());
  } catch {
    return NaN;
  }
}
async function chromeChecks(UP, s5Log, deadPort) {
  if (!fs.existsSync(CHROME)) return check("headless Chrome (skipped: Chrome is not installed)", true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smp-qa-tunnel-"));
  const t = await startTunnel(UP.socks5);
  const dead = await startTunnel({ ...UP.socks5, port: deadPort });
  let leftover = NaN;
  try {
    const logBefore = s5Log.length;
    const page = await dumpDom(dir, t.port, `http://target.test:${ports.target}/chrome-http`);
    check("Chrome: an http:// page loads through the tunnel and SOCKS5 with a password", page.includes("hello /chrome-http"), page.slice(0, 300));
    const tlsPage = await dumpDom(dir, t.port, `https://tls.test:${ports.tls}/chrome-https`, ["--ignore-certificate-errors"]);
    check("Chrome: an https:// page loads through CONNECT", tlsPage.includes("hello /chrome-https"), tlsPage.slice(0, 300));
    const asked = s5Log.slice(logBefore);
    check("Chrome: the proxy resolved both names (ATYP 3); Chrome resolved nothing", ["target.test", "tls.test"].every((h) => asked.some((e) => e.host === h && e.atyp === 3)), asked);
    const before = targetConns;
    const deadPage = await dumpDom(dir, dead.port, `http://127.0.0.1:${ports.target}/chrome-dead`, ["--proxy-bypass-list=<-loopback>"]);
    check("Chrome: with the upstream down the page fails and nothing connects directly", deadPage.includes("502 Bad Gateway") && !deadPage.includes("hello /chrome-dead") && targetConns === before, deadPage.slice(0, 200));
  } finally {
    await t.close();
    await dead.close();
    leftover = killChrome(dir);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
  check(`Chrome: no browser process left behind (${leftover} still ran after --dump-dom), temp profile removed`, !fs.existsSync(dir) && killChrome(dir) === 0);
}

(async () => {
  setTimeout(() => {
    console.log("FAIL  the check hung");
    process.exit(1);
  }, 180_000).unref();
  try {
    await main();
  } catch (err) {
    check("check ran to the end", false, err.stack);
  }
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  — ${r.detail}`}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
