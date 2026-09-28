// Per-profile local proxy tunnel. The browser is pointed at http://127.0.0.1:<port> with no
// credentials; every connection it makes leaves through the profile's upstream proxy
// (http, https, socks4, socks5 — the manager.parseProxy record) with the credentials, and the
// upstream resolves every hostname. There is no direct path: when the upstream is down, refuses
// or rejects the login, the browser gets a 502 (kill switch). Node core only.
//
// https and every other CONNECT is tunnelled. A plain http:// request goes to an http/https
// upstream the way a browser sends it, in absolute form with Proxy-Authorization, because many
// providers refuse CONNECT to port 80; over SOCKS it is tunnelled to host:80.
//
//   const t = await startTunnel(record.proxy, { onError, onStats });
//   t.url      "http://127.0.0.1:<port>", the browser's proxy (no username/password)
//   t.stats()  { active, total, bytesUp, bytesDown, lastError }
//   await t.close();
"use strict";
const net = require("net");
const tls = require("tls");
const http = require("http");
const { pipeline } = require("stream");

const CONNECT_MS = 15_000;
const IDLE_MS = 5 * 60_000;
const MAX_BODY = 1 << 20; // fetchVia
const HOP = new Set(["connection", "proxy-connection", "keep-alive", "proxy-authorization", "proxy-authenticate", "te", "trailer", "upgrade"]);
const SOCKS5_REPLIES = [, "general failure", "not allowed by the proxy", "network unreachable", "host unreachable", "connection refused", "TTL expired", "command not supported", "address type not supported"];
const noop = () => {};
// Upstreams that take plain http:// requests in absolute form (the proxy strips Proxy-Authorization).
const FORWARDS = new Set(["http", "https"]);
const basicAuth = (up) => (up.username || up.password ? `Basic ${Buffer.from(`${up.username || ""}:${up.password || ""}`).toString("base64")}` : "");
const where = (up) => `${up.scheme} proxy ${bare(up.host)}:${Number(up.port)}: `;
const LOGIN_REFUSED = "rejected the username/password (407)";
const bare = (h) => String(h ?? "").replace(/^\[(.*)\]$/, "$1");
const validPort = (p) => Number.isInteger(p) && p > 0 && p < 65536;
// A name or an IP literal: nothing that could smuggle bytes into a CONNECT line or a SOCKS field.
const validHost = (h) => net.isIP(h) > 0 || /^[a-z0-9_.-]{1,253}$/i.test(h);

/** The tunnel listens on 127.0.0.1 only; this is the per-connection guard on top of that. */
const isLoopback = (addr) => addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";

// Every error that leaves this module goes through here, so the password never does.
function cleanError(err, up, where = "") {
  let msg = where + (err?.message || String(err));
  if (up?.password) msg = msg.split(String(up.password)).join("***");
  return Object.assign(new Error(msg), { code: err?.code });
}

// Resolves with the first need(buf) bytes the proxy sends (need returns 0 while it wants more,
// and throws on a bad reply). Bytes past them already belong to the tunnel: pushed back.
function readMsg(sock, need) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const stop = () => {
      sock.off("data", onData).off("end", onEnd).off("close", onEnd).off("error", onError);
      sock.pause();
    };
    const onError = (err) => {
      stop();
      reject(err);
    };
    const onEnd = () => onError(new Error("closed the connection during the handshake"));
    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      let n;
      try {
        n = need(buf);
      } catch (err) {
        return onError(err);
      }
      if (!n || buf.length < n) return;
      stop();
      if (buf.length > n) sock.unshift(buf.subarray(n));
      resolve(buf.subarray(0, n));
    }
    sock.on("data", onData).on("end", onEnd).on("close", onEnd).on("error", onError);
    sock.resume();
  });
}

async function httpConnect(sock, up, host, port) {
  const target = net.isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
  const auth = basicAuth(up) ? `Proxy-Authorization: ${basicAuth(up)}\r\n` : "";
  sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`);
  const reply = await readMsg(sock, (b) => {
    const end = b.indexOf("\r\n\r\n");
    if (end < 0 && b.length > 16384) throw new Error("sent an oversized reply");
    return end < 0 ? 0 : end + 4;
  });
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(reply.toString("latin1"))?.[1]);
  if (status >= 200 && status < 300) return;
  throw new Error(status === 407 ? LOGIN_REFUSED : status ? `answered ${status} to CONNECT` : "sent a malformed reply");
}

// RFC 1928 + RFC 1929. Names go as ATYP 3 so the proxy resolves them; IP literals need no DNS.
async function socks5(sock, up, host, port) {
  const user = Buffer.from(up.username || "");
  const pass = Buffer.from(up.password || "");
  const login = user.length > 0 || pass.length > 0;
  if (user.length > 255 || pass.length > 255) throw new Error("username or password is longer than 255 bytes");
  sock.write(Buffer.from(login ? [5, 2, 0, 2] : [5, 1, 0]));
  const [version, method] = await readMsg(sock, () => 2);
  if (version !== 5) throw new Error("is not a SOCKS5 proxy");
  if (login && method === 2) {
    sock.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
    if ((await readMsg(sock, () => 2))[1] !== 0) throw new Error("rejected the username/password");
  } else if (method !== 0) {
    throw new Error(login ? "accepts none of the offered login methods" : "requires a username/password");
  }
  const ip = net.isIP(host);
  const addr =
    ip === 4
      ? Buffer.from([1, ...host.split(".").map(Number)])
      : ip === 6
        ? Buffer.concat([Buffer.from([4]), ipv6Bytes(host)])
        : Buffer.concat([Buffer.from([3, Buffer.byteLength(host)]), Buffer.from(host)]);
  sock.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, Buffer.from([port >> 8, port & 255])]));
  await readMsg(sock, (b) => {
    if (b.length >= 2 && b[1] !== 0) throw new Error(`could not connect (${SOCKS5_REPLIES[b[1]] || `code ${b[1]}`})`);
    if (b.length < 5) return 0;
    const len = { 1: 4, 3: 1 + b[4], 4: 16 }[b[3]];
    if (b[0] !== 5 || !len) throw new Error("sent a malformed reply");
    return 4 + len + 2;
  });
}

function ipv6Bytes(ip) {
  const hex = ip
    .replace(/%.*$/, "")
    .replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_, a, b, c, d) => `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`);
  const [head, tail] = hex.split("::").map((s) => (s ? s.split(":") : []));
  const groups = tail ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail] : head;
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16), i * 2));
  return out;
}

// SOCKS4a: address 0.0.0.1 plus the name, so the proxy resolves it. SOCKS4 has no password.
async function socks4(sock, up, host, port) {
  const ip = net.isIP(host);
  if (ip === 6) throw new Error("cannot reach IPv6 addresses (SOCKS4)");
  sock.write(
    Buffer.concat([
      Buffer.from([4, 1, port >> 8, port & 255, ...(ip ? host.split(".").map(Number) : [0, 0, 0, 1])]),
      Buffer.from(`${up.username || ""}\0${ip ? "" : `${host}\0`}`),
    ])
  );
  const [, status] = await readMsg(sock, () => 8);
  if (status !== 0x5a) throw new Error(`could not connect (SOCKS4 code ${status})`);
}

const HANDSHAKES = { http: httpConnect, https: httpConnect, socks5, socks4 };

/**
 * connectVia(upstream, host, port, timeoutMs = 15000, signal?) → Promise<net.Socket>
 * A raw TCP connection to host:port through the upstream proxy; the proxy resolves the name.
 * Only the proxy itself is ever dialled. `upstream.ca` (optional) pins the CA of an https
 * proxy; otherwise Node's bundled roots verify it. `signal` aborts a pending handshake.
 */
function connectVia(upstream, host, port, timeoutMs = CONNECT_MS, signal) {
  const up = upstream || {};
  const handshake = HANDSHAKES[up.scheme];
  host = bare(host);
  port = Number(port);
  if (!handshake || !bare(up.host) || !validPort(Number(up.port))) return Promise.reject(cleanError(new Error("invalid upstream proxy"), up));
  if (!validHost(host) || !validPort(port)) return Promise.reject(cleanError(new Error("invalid target"), up, where(up)));
  return dial(up, timeoutMs, signal, (sock) => handshake(sock, up, host, port));
}

// A connection to the upstream proxy itself (TLS for https), resolved once `handshake(sock)` has.
function dial(up, timeoutMs, signal, handshake) {
  return new Promise((resolve, reject) => {
    let sock, timer;
    const fail = (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      sock?.destroy();
      reject(cleanError(err, up, where(up)));
    };
    const onAbort = () => fail(new Error("aborted"));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => fail(new Error(`no answer within ${timeoutMs / 1000}s`)), timeoutMs);
    const phost = bare(up.host);
    const opts = { host: phost, port: Number(up.port), noDelay: true };
    sock =
      up.scheme === "https"
        ? tls.connect({ ...opts, servername: net.isIP(phost) ? undefined : phost, ca: up.ca, ALPNProtocols: ["http/1.1"] })
        : net.connect(opts);
    sock.on("error", fail);
    sock.once(up.scheme === "https" ? "secureConnect" : "connect", () =>
      Promise.resolve(handshake(sock)).then(() => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        sock.off("error", fail).on("error", noop);
        sock.readableFlowing = null; // whoever reads next (pipe, 'data', http) starts the flow
        resolve(sock);
      }, fail)
    );
  });
}

// Drops hop-by-hop headers from a rawHeaders list. Towards the target the browser's
// (Proxy-)Connection header stays in its place, as Connection: the header order of a direct request.
function endToEnd(raw, toTarget) {
  const out = [];
  let conn = false;
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i].toLowerCase();
    if (toTarget && !conn && (name === "connection" || name === "proxy-connection")) {
      out.push("Connection", raw[i + 1]);
      conn = true;
    } else if (!HOP.has(name)) out.push(raw[i], raw[i + 1]);
  }
  return out;
}

// Generic text only: a page can read the body of a same-origin plain-http 502.
function reply(res, code) {
  if (res.headersSent) return res.destroy();
  res.writeHead(code, { "Content-Type": "text/plain", Connection: "close" }).end(`${code} ${http.STATUS_CODES[code]}\n`);
}

const refuse = (sock, status) => sock.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => sock.destroy());

/**
 * startTunnel(upstream, { onError, onStats } = {}) → Promise<{ port, url, close(), stats() }>
 * onError(err) runs for every connection the upstream could not carry (the browser got a 502);
 * onStats(stats()) whenever a tunnel opens or closes or an error is recorded. close() destroys
 * every socket and resolves once the port is free and every tunnel has closed; it is idempotent.
 */
function startTunnel(upstream, { onError, onStats } = {}) {
  const up = { ...upstream };
  if (!HANDSHAKES[up.scheme] || !bare(up.host) || !validPort(Number(up.port))) {
    return Promise.reject(new Error("invalid upstream proxy: expected { scheme: http|https|socks4|socks5, host, port }"));
  }
  const clients = new Set();
  const tunnels = new Map(); // upstream socket -> its byte counters when the tunnel opened
  const done = { total: 0, bytesUp: 0, bytesDown: 0, lastError: null };
  const stats = () => {
    let { bytesUp, bytesDown } = done;
    for (const [s, at] of tunnels) {
      bytesUp += s.bytesWritten - at.w;
      bytesDown += s.bytesRead - at.r;
    }
    return { active: tunnels.size, total: done.total, bytesUp, bytesDown, lastError: done.lastError };
  };
  const notify = (fn, arg) => {
    try {
      fn?.(arg);
    } catch {
      // a throwing callback must not take the tunnel down
    }
  };
  const failed = (err) => {
    done.lastError = err.message;
    notify(onError, err);
    notify(onStats, stats());
  };

  // forward: a connection to the proxy itself, for one absolute-form http:// request.
  async function open(host, port, signal, forward = false) {
    const s = forward ? await dial(up, CONNECT_MS, signal, noop) : await connectVia(up, host, port, CONNECT_MS, signal);
    s.setTimeout(IDLE_MS, () => s.destroy());
    tunnels.set(s, { r: s.bytesRead, w: s.bytesWritten });
    done.total++;
    s.once("close", () => {
      const at = tunnels.get(s);
      done.bytesUp += s.bytesWritten - at.w;
      done.bytesDown += s.bytesRead - at.r;
      tunnels.delete(s);
      notify(onStats, stats());
    });
    notify(onStats, stats());
    return s;
  }

  // CONNECT host:port — https, wss, and anything else the browser tunnels.
  async function onConnect(req, client, head) {
    client.on("error", noop); // the http server stops handling this socket's errors after CONNECT
    client.setTimeout(IDLE_MS, () => client.destroy());
    const i = req.url.lastIndexOf(":");
    const host = bare(req.url.slice(0, i));
    const port = /^\d{1,5}$/.test(req.url.slice(i + 1)) ? Number(req.url.slice(i + 1)) : 0;
    if (i < 1 || !validHost(host) || !validPort(port)) return refuse(client, "400 Bad Request");
    const ac = new AbortController();
    client.once("close", () => ac.abort());
    let s;
    try {
      s = await open(host, port, ac.signal);
    } catch (err) {
      if (!ac.signal.aborted) {
        failed(err);
        refuse(client, "502 Bad Gateway");
      }
      return;
    }
    if (client.destroyed) return s.destroy();
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) s.write(head);
    pipeline(client, s, noop);
    pipeline(s, client, noop);
  }

  // Absolute-URI http:// requests. An http/https upstream gets them in absolute form with
  // Proxy-Authorization (the proxy strips it; many refuse CONNECT to port 80). A SOCKS upstream
  // tunnels to host:port and gets origin-form. A 407 is a 502 here, never a login prompt.
  // ponytail: one upstream connection per plain request, no keep-alive pool towards the target;
  // add an http.Agent keyed by host:port if plain-http volume ever matters.
  async function onRequest(req, res) {
    res.sendDate = false; // add nothing the origin did not send
    const origin = /^http:\/\/[^/?#]+/i.exec(req.url)?.[0];
    let u = null;
    try {
      u = new URL(origin);
    } catch {}
    if (!u || !validHost(bare(u.hostname))) return reply(res, 400);
    const forward = FORWARDS.has(up.scheme);
    const ac = new AbortController();
    res.once("close", () => ac.abort());
    let s;
    try {
      s = await open(bare(u.hostname), u.port ? Number(u.port) : 80, ac.signal, forward);
    } catch (err) {
      if (!ac.signal.aborted) {
        failed(err);
        reply(res, 502);
      }
      return;
    }
    if (ac.signal.aborted) return s.destroy();
    res.once("close", () => s.destroy());
    const headers = endToEnd(req.rawHeaders, true);
    const h = headers.findIndex((v, n) => n % 2 === 0 && v.toLowerCase() === "host");
    if (h < 0) headers.unshift("Host", u.host);
    else headers[h + 1] = u.host; // RFC 9112 §3.2.2: the absolute URI wins
    if (forward && basicAuth(up)) headers.push("Proxy-Authorization", basicAuth(up));
    const rest = req.url.slice(origin.length);
    const target = rest[0] === "/" ? rest : `/${rest}`;
    const out = http.request({ createConnection: () => s, method: req.method, path: forward ? origin + target : target, headers, setHost: false });
    out.on("error", () => reply(res, 502));
    out.on("response", (inc) => {
      if (forward && inc.statusCode === 407) {
        s.destroy();
        failed(cleanError(new Error(LOGIN_REFUSED), up, where(up)));
        return reply(res, 502);
      }
      res.writeHead(inc.statusCode, inc.statusMessage, endToEnd(inc.rawHeaders, false));
      pipeline(inc, res, noop);
    });
    req.pipe(out);
  }

  const server = http.createServer({ requestTimeout: 0 });
  server.timeout = IDLE_MS;
  server.on("connection", (sock) => {
    if (!isLoopback(sock.remoteAddress)) return sock.destroy();
    clients.add(sock);
    sock.once("close", () => clients.delete(sock));
  });
  server.on("connect", (req, client, head) => onConnect(req, client, head).catch(() => client.destroy()));
  server.on("request", (req, res) => onRequest(req, res).catch(() => res.destroy()));

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject).on("error", (err) => (done.lastError = err.message));
      const { port } = server.address();
      let closing;
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        stats,
        close: () =>
          (closing ??= new Promise((ok) => {
            const gone = [...tunnels.keys()].map((s) => new Promise((r) => s.once("close", r)));
            server.close(() => Promise.all(gone).then(() => ok()));
            for (const s of clients) s.destroy();
            for (const s of tunnels.keys()) s.destroy();
          })),
      });
    });
  });
}

/**
 * fetchVia(upstream, url, { timeoutMs = 15000, ca } = {}) → Promise<{ status, headers, body }>
 * One GET of an http:// or https:// URL through the upstream proxy (name resolved by the proxy;
 * https with SNI, verified against `ca` or Node's bundled roots). body is a utf-8 string of at
 * most 1 MiB; redirects are not followed; timeoutMs bounds the whole exchange.
 */
async function fetchVia(upstream, url, { timeoutMs = CONNECT_MS, ca } = {}) {
  const u = new URL(url);
  const secure = u.protocol === "https:";
  if (!secure && u.protocol !== "http:") throw new Error("fetchVia needs an http:// or https:// URL");
  const host = bare(u.hostname);
  const deadline = Date.now() + timeoutMs;
  const forward = !secure && FORWARDS.has(upstream?.scheme);
  if (forward && !validHost(host)) throw new Error("invalid target");
  const raw = forward
    ? await dial(upstream, timeoutMs, undefined, noop)
    : await connectVia(upstream, host, u.port ? Number(u.port) : secure ? 443 : 80, timeoutMs);
  return new Promise((resolve, reject) => {
    const sock = secure ? tls.connect({ socket: raw, servername: net.isIP(host) ? undefined : host, ca, ALPNProtocols: ["http/1.1"] }) : raw;
    let timer;
    const finish = (err, result) => {
      clearTimeout(timer);
      sock.destroy();
      raw.destroy();
      if (err) reject(cleanError(err, upstream));
      else resolve(result);
    };
    timer = setTimeout(() => finish(new Error(`no response within ${timeoutMs / 1000}s`)), Math.max(1, deadline - Date.now()));
    sock.on("error", finish);
    const headers = { Host: u.host, Connection: "close" };
    if (forward && basicAuth(upstream)) headers["Proxy-Authorization"] = basicAuth(upstream);
    const path = `${forward ? u.origin : ""}${u.pathname}${u.search}`;
    const req = http.request({ createConnection: () => sock, path, headers }, (res) => {
      if (forward && res.statusCode === 407) return finish(new Error(where(upstream) + LOGIN_REFUSED));
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        chunks.push(c);
        if ((size += c.length) > MAX_BODY) finish(new Error("response larger than 1 MiB"));
      });
      res.on("end", () => finish(null, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", finish);
    });
    req.on("error", finish);
    req.end();
  });
}

module.exports = { startTunnel, connectVia, fetchVia, isLoopback };
