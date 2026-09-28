"""
Chromium worker for SessionManagerPro: drives an installed Chrome / Edge / Brave / Chromium
over raw CDP (nodriver launches the browser and holds the websocket; no chromedriver, no
automation flags). Speaks exactly the JSON-lines protocol of browser_worker.py — see ENGINE.md.

The browser runs on the profile's own --user-data-dir, so cookies and logins persist
natively; they are also dumped to --cookies-file for export, history and counts.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

# First: it re-wraps the standard streams as UTF-8 before anything else can print.
from worker_common import WinCtl, emit, kill_with_worker, log_err, read_proxy, read_stdin, taskbar_identity

# stdout is the protocol. nodriver (and anything it imports) may print: send that to stderr.
sys.stdout = sys.stderr

try:
    import nodriver
except ImportError:
    emit("error", error="the Chromium engine (nodriver) is missing from this install — reinstall SessionManagerPro")
    os._exit(1)

START_WAIT_S = 30
MANUAL_CLOSE = "closed by user"


def _raw(method: str, params: Dict[str, Any]):
    """A CDP command in the generator shape nodriver's Connection.send expects; returns raw JSON."""
    result = yield {"method": method, "params": params}
    return result


class ChromeConfig(nodriver.Config):
    """nodriver's arguments minus two it always adds: `--remote-allow-origins=*` (would let any
    web page drive the DevTools port) and its site-isolation opt-out (a real Chrome keeps it)."""

    DROP = {"--remote-allow-origins=*", "--disable-features=IsolateOrigins,site-per-process"}

    def __call__(self):
        return [a for a in super().__call__() if a not in self.DROP]


# ------------------------------------------------------------------ geo and language


def proxy_url(p: Dict[str, Any], with_auth: bool = True) -> str:
    from urllib.parse import quote

    scheme = "socks5h" if p["scheme"].startswith("socks") else p["scheme"]
    auth = f"{quote(p['username'], safe='')}:{quote(p['password'], safe='')}@" if with_auth and p["username"] else ""
    return f"{scheme}://{auth}{p['host']}:{p['port']}"


def resolve_geo(proxy: Dict[str, Any]) -> Dict[str, Any]:
    """The proxy's EXIT IP geo, in one request through the proxy (what server.js testProxy does)."""
    import requests

    s = requests.Session()
    s.trust_env = False  # only this proxy, never the machine's
    url = proxy_url(proxy)
    try:
        r = s.get("http://ip-api.com/json?fields=status,message,query,countryCode,timezone,lat,lon",
                  proxies={"http": url, "https": url}, timeout=(6, 8))
    except requests.exceptions.ProxyError as e:
        raise RuntimeError(f"the proxy {proxy['host']}:{proxy['port']} did not answer ({str(e)[:160]})")
    except requests.RequestException as e:
        raise RuntimeError(f"could not reach the geo service through the proxy ({str(e)[:160]})")
    if r.status_code == 407:
        raise RuntimeError("the proxy rejected the credentials")
    try:
        g = r.json()
    except ValueError:
        g = {}
    if g.get("status") != "success" or not g.get("timezone"):
        raise RuntimeError(f"the geo service could not place the proxy's exit IP ({g.get('message') or r.status_code})")
    try:
        from invisible_core._geo import _COUNTRY_LOCALE  # the engine's own country -> locale table
    except Exception:
        _COUNTRY_LOCALE = {}
    cc = str(g.get("countryCode") or "").upper()
    return {"exitIp": g.get("query"), "country": cc or None, "timezone": g["timezone"],
            "lat": g.get("lat"), "lon": g.get("lon"), "locale": _COUNTRY_LOCALE.get(cc, "en-US")}


def known_geo(raw: Optional[str]) -> Optional[Dict[str, Any]]:
    """The exit geo the panel already looked up (worker_runner.js exitGeo), in resolve_geo's shape."""
    try:
        g = json.loads(raw) if raw else None
        if not (g and g.get("ip") and g.get("timezone")):
            return None
        from invisible_core._geo import _COUNTRY_LOCALE
        cc = str(g.get("country") or "").upper()
        return {"exitIp": g["ip"], "country": cc or None, "timezone": g["timezone"],
                "lat": g.get("lat"), "lon": g.get("lon"), "locale": _COUNTRY_LOCALE.get(cc, "en-US")}
    except Exception as e:
        log_err(f"known geo ignored: {e}")
        return None


def languages_for(locale: str) -> List[str]:
    lang = locale.split("-")[0]
    return [locale, lang] if lang == "en" else [locale, lang, "en-US", "en"]


def write_prefs(profile_dir: Path, languages: Optional[List[str]]):
    """Profile prefs a flag can't set: WebRTC may only use the proxy, and navigator.languages /
    Accept-Language (which come from this pref, not from any CDP call, so workers agree)."""
    f = profile_dir / "Default" / "Preferences"
    try:
        prefs = json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}
    except Exception:
        return log_err("Preferences unreadable; WebRTC and language prefs not written")
    prefs.setdefault("webrtc", {}).update(ip_handling_policy="disable_non_proxied_udp",
                                          multiple_routes_enabled=False, nonproxied_udp_enabled=False)
    if languages:
        prefs.setdefault("intl", {})["accept_languages"] = ",".join(languages)
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_suffix(".smp.tmp")
    tmp.write_text(json.dumps(prefs), encoding="utf-8")
    tmp.replace(f)


# ------------------------------------------------------------------ fingerprint (Chrome dumps only)

# Runs first in every document and frame. Only what CDP can't set natively; each patched
# function keeps the native name, length, no-prototype shape and toString.
FP_JS = r"""(() => {
  const fp = __FP__;
  const real = new WeakMap();
  const nativeToString = Function.prototype.toString;
  const toString = { toString() { return Reflect.apply(nativeToString, real.get(this) || this, arguments); } }.toString;
  real.set(toString, nativeToString);
  Object.defineProperty(Function.prototype, 'toString', { ...Object.getOwnPropertyDescriptor(Function.prototype, 'toString'), value: toString });
  const getter = (proto, prop, value) => {
    const d = proto && Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.get || value === undefined || value === null) return;
    const native = d.get;
    // The native getter runs first, so a wrong receiver still throws "Illegal invocation".
    const fake = Object.getOwnPropertyDescriptor({ get [prop]() { Reflect.apply(native, this, []); return value; } }, prop).get;
    real.set(fake, native);
    Object.defineProperty(proto, prop, { ...d, get: fake });
  };
  const webgl = (proto) => {
    const d = proto && Object.getOwnPropertyDescriptor(proto, 'getParameter');
    if (!d || !fp.webgl) return;
    const native = d.value;
    const fake = { getParameter(p) {
      const v = Reflect.apply(native, this, arguments);
      return p === 0x9245 ? fp.webgl.vendor : p === 0x9246 ? fp.webgl.renderer : v;
    } }.getParameter;
    real.set(fake, native);
    Object.defineProperty(proto, 'getParameter', { ...d, value: fake });
  };
  webgl(self.WebGLRenderingContext && WebGLRenderingContext.prototype);
  webgl(self.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
  getter(self.Navigator && Navigator.prototype, 'deviceMemory', fp.deviceMemory);
  if (fp.screen) for (const k of ['availWidth', 'availHeight', 'colorDepth', 'pixelDepth']) getter(self.Screen && Screen.prototype, k, fp.screen[k]);
})();"""

SANE_DPR = {1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3}


# ------------------------------------------------------------------ cookies (Playwright shape <-> CDP)


def pw_cookie(c: Dict[str, Any]) -> Dict[str, Any]:
    return {"name": c["name"], "value": c["value"], "domain": c["domain"], "path": c.get("path", "/"),
            "expires": -1 if c.get("session") else c.get("expires", -1),
            "httpOnly": bool(c.get("httpOnly")), "secure": bool(c.get("secure")),
            "sameSite": c.get("sameSite") or "Lax"}


def cdp_cookie(c: Dict[str, Any]) -> Dict[str, Any]:
    out = {k: c[k] for k in ("name", "url", "domain", "path", "secure", "httpOnly") if c.get(k) is not None}
    out["value"] = str(c.get("value", ""))
    if c.get("sameSite") in ("Strict", "Lax", "None"):
        out["sameSite"] = c["sameSite"]
    if isinstance(c.get("expires"), (int, float)) and c["expires"] > 0:
        out["expires"] = c["expires"]
    return out


# ------------------------------------------------------------------ keyboard

NAMED_KEYS = {
    "Enter": (13, "\r"), "Tab": (9, "\t"), "Backspace": (8, ""), "Delete": (46, ""), "Escape": (27, ""),
    "ArrowLeft": (37, ""), "ArrowUp": (38, ""), "ArrowRight": (39, ""), "ArrowDown": (40, ""),
    "Home": (36, ""), "End": (35, ""), "PageUp": (33, ""), "PageDown": (34, ""), "Insert": (45, ""),
    "Space": (32, " "), **{f"F{i}": (111 + i, "") for i in range(1, 13)},
}
MODIFIERS = {"Alt": (1, 18), "Control": (2, 17), "Meta": (4, 91), "Shift": (8, 16), "ControlOrMeta": (2, 17)}


def key_event(key: str) -> Dict[str, Any]:
    """CDP fields for one key: key, code, virtual key code, text (and Shift for capitals)."""
    key = {"\n": "Enter", "\r": "Enter", "\t": "Tab", " ": "Space"}.get(key, key)
    if key in NAMED_KEYS:
        vk, text = NAMED_KEYS[key]
        return {"key": " " if key == "Space" else key, "code": key, "windowsVirtualKeyCode": vk, "text": text}
    if len(key) != 1:
        raise ValueError(f'unknown key "{key}"')
    up = key.upper()
    if key.isascii() and key.isalpha():
        return {"key": key, "code": f"Key{up}", "windowsVirtualKeyCode": ord(up), "text": key,
                "modifiers": 8 if key == up else 0}
    if key.isdigit():
        return {"key": key, "code": f"Digit{key}", "windowsVirtualKeyCode": ord(key), "text": key}
    return {"key": key, "code": "", "windowsVirtualKeyCode": 0, "text": key}


# In-page element helper, run through evaluate(): one query, shared by every selector op.
FIND_JS = """(a) => {
  const el = document.querySelector(a.sel);
  const vis = !!el && (() => { const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden'; })();
  const ok = { attached: !!el, detached: !el, visible: vis, hidden: !vis }[a.state];
  if (!ok || !a.act) return ok;
  if (a.act === 'focus') { el.focus(); return true; }
  if (a.act === 'center') { el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
  if (a.act === 'select') {
    const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
    if (!field && !el.isContentEditable) throw new Error('Element is not an <input>, <textarea> or [contenteditable] element');
    el.focus();
    if (field) el.select(); else { const r = document.createRange(); r.selectNodeContents(el);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    return true;
  }
}"""


class Tab:
    def __init__(self, pid: int, target_id: str, session: str, url: str, title: str):
        self.pid, self.target_id, self.session = pid, target_id, session
        self.url, self.title = url, title
        self.closed = False
        self.ready = asyncio.get_running_loop().create_future()
        self.frame_id: Optional[str] = None
        self.loader: Optional[str] = None
        self.lifecycle: Dict[str, set] = {}  # loaderId -> lifecycle event names seen
        self.changed = asyncio.Condition()


class ChromiumWorker:
    def __init__(self, args: argparse.Namespace):
        self.session_id = args.id
        self.browser_path = args.browser_path
        self.profile_dir = Path(args.profile_dir).resolve()
        self.seed = args.seed
        self.headless = args.headless
        self.initial_urls = [u for u in (args.url or []) if u]
        self.cookies_file = Path(args.cookies_file).resolve() if args.cookies_file else None
        self.init_scripts_file = Path(args.init_scripts).resolve() if args.init_scripts else None
        self.cookies_import_file = Path(args.cookies_import).resolve() if args.cookies_import else None
        self.proxy = read_proxy()
        # "block" (default): no page gets a position. "spoof": granted, at the exit IP's coordinates.
        self.geolocation = args.geolocation if args.geolocation in ("block", "spoof") else "block"
        self.geo_arg = args.geo
        self.fp: Dict[str, Any] = {}
        if args.fingerprint:
            try:
                self.fp = json.loads(args.fingerprint) or {}
            except Exception as e:
                log_err(f"Failed to parse fingerprint: {e}")
        self.browser = None
        self.geo: Dict[str, Any] = {}
        self.languages: Optional[List[str]] = None
        self.scripts: List[str] = []  # fingerprint patch (if any) + auto-run scripts, every document
        self.ua_override: Optional[Dict[str, Any]] = None
        self.tabs: Dict[int, Tab] = {}
        self.by_session: Dict[str, Tab] = {}
        self.by_target: Dict[str, Tab] = {}
        self.target_waiters: Dict[str, asyncio.Future] = {}
        self.page_seq = 0
        self.last_page: Optional[Tab] = None
        self.started = False
        self.start_task = None
        self.winctl: Optional[WinCtl] = None
        self.closing = False
        self.closed_by_user = False
        self.done = asyncio.Event()
        self.queue: asyncio.Queue[str] = asyncio.Queue()

    # -------------------------------------------------------------- CDP plumbing

    async def cdp(self, method: str, session: Optional[str] = None, **params):
        kw = {"sessionId": session} if session else {}
        try:
            return await self.browser.send(_raw(method, params), **kw)
        except nodriver.ProtocolException as e:
            raise RuntimeError(getattr(e, "message", None) or str(e).strip().splitlines()[0]) from None

    async def quiet(self, coro):
        try:
            return await coro
        except Exception:
            return None

    async def on_cdp(self, message: Dict[str, Any], tx_id=None):
        """Every CDP event, raw (replaces nodriver's typed parsing, which drops events whose
        enums are newer than its protocol snapshot). Runs on the socket reader: never await
        a command here — spawn a task instead."""
        method, p, sid = message.get("method"), message.get("params") or {}, message.get("sessionId")
        tab = self.by_session.get(sid) if sid else None
        try:
            if method == "Target.attachedToTarget":
                info, child = p["targetInfo"], p["sessionId"]
                if info.get("type") == "page" and not info.get("subtype"):
                    asyncio.create_task(self.adopt(child, info, p.get("waitingForDebugger")))
                elif info.get("type") == "iframe":
                    asyncio.create_task(self.adopt_frame(child, p.get("waitingForDebugger")))
                elif p.get("waitingForDebugger"):
                    asyncio.create_task(self.release(child))
            elif method == "Target.targetInfoChanged":
                info = p["targetInfo"]
                t = self.by_target.get(info["targetId"])
                if t:
                    t.url, t.title = info.get("url", t.url), info.get("title", t.title)
            elif method in ("Target.targetDestroyed", "Target.detachedFromTarget"):
                t = self.by_target.get(p.get("targetId")) or self.by_session.get(p.get("sessionId"))
                if t:
                    self.forget(t)
            elif tab is None:
                return
            elif method == "Page.frameNavigated" and not p["frame"].get("parentId"):
                f = p["frame"]
                tab.frame_id, tab.loader = f["id"], f.get("loaderId")
                tab.url = f["url"] + (f.get("urlFragment") or "")
                self.last_page = tab
                if self.started and not self.closing:
                    emit("tabs", tabs=self.collect_tabs(), currentUrl=tab.url)
                asyncio.create_task(self.notify(tab))
            elif method == "Page.navigatedWithinDocument" and p.get("frameId") == tab.frame_id:
                tab.url = p["url"]
            elif method == "Page.lifecycleEvent" and (tab.frame_id is None or p.get("frameId") == tab.frame_id):
                tab.lifecycle.setdefault(p["loaderId"], set()).add(p["name"])
                asyncio.create_task(self.notify(tab))
            elif method == "Fetch.requestPaused":
                asyncio.create_task(self.quiet(self.cdp("Fetch.continueRequest", sid, requestId=p["requestId"])))
            elif method == "Fetch.authRequired":
                asyncio.create_task(self.quiet(self.answer_auth(sid, p)))
            elif method == "Page.javascriptDialogOpening" and self.headless:
                # Nobody can click a headless dialog, and it would block every script on the tab.
                asyncio.create_task(self.quiet(self.cdp("Page.handleJavaScriptDialog", sid, accept=False)))
        except Exception as e:
            log_err(f"event {method}: {e}")

    async def notify(self, tab: Tab):
        async with tab.changed:
            tab.changed.notify_all()

    async def answer_auth(self, sid: str, p: Dict[str, Any]):
        """Proxy credentials go through CDP, never onto the command line. Site logins are left to the browser."""
        proxy = self.proxy or {}
        if p.get("authChallenge", {}).get("source") == "Proxy" and proxy.get("username"):
            resp = {"response": "ProvideCredentials", "username": proxy["username"], "password": proxy["password"]}
        else:
            resp = {"response": "Default"}
        await self.cdp("Fetch.continueWithAuth", sid, requestId=p["requestId"], authChallengeResponse=resp)

    async def release(self, sid: str):
        """A paused target that is not a tab or frame: let it run, then let go of it."""
        await self.quiet(self.cdp("Runtime.runIfWaitingForDebugger", sid))
        await self.quiet(self.cdp("Target.detachFromTarget", sessionId=sid))

    def overrides(self, sid: str, tab: bool) -> list:
        """Everything a document must see before its first script: geo, identity, patches."""
        out = []
        g = self.geo
        if g:
            out.append(self.cdp("Emulation.setTimezoneOverride", sid, timezoneId=g["timezone"]))
            if self.geolocation == "spoof" and g.get("lat") is not None and g.get("lon") is not None:
                out.append(self.cdp("Emulation.setGeolocationOverride", sid, latitude=g["lat"], longitude=g["lon"], accuracy=50))
        if self.languages:
            out.append(self.cdp("Emulation.setLocaleOverride", sid, locale=self.languages[0]))
        if self.ua_override:
            out.append(self.cdp("Emulation.setUserAgentOverride", sid, **self.ua_override))
        if self.fp.get("hardwareConcurrency"):
            out.append(self.cdp("Emulation.setHardwareConcurrencyOverride", sid, hardwareConcurrency=int(self.fp["hardwareConcurrency"])))
        metrics = self.screen_metrics()
        if metrics and tab:
            out.append(self.cdp("Emulation.setDeviceMetricsOverride", sid, **metrics))
        for source in self.scripts:
            out.append(self.cdp("Page.addScriptToEvaluateOnNewDocument", sid, source=source))
        # Cross-site iframes are their own targets: they get the same treatment, paused until then.
        out.append(self.cdp("Target.setAutoAttach", sid, autoAttach=True, waitForDebuggerOnStart=True, flatten=True,
                            filter=[{"type": "iframe", "exclude": False}]))
        return out

    def screen_metrics(self) -> Optional[Dict[str, Any]]:
        """Headless only: a headless browser has no monitor (800x600 by default, a bot tell), so it
        gets the fingerprint's screen. Headful keeps the real monitor, which the window matches."""
        if not self.headless:
            return None
        s = self.fp.get("screen") or {}
        dpr = self.fp.get("dpr")
        return {"width": 0, "height": 0, "mobile": False,  # 0 = keep the real viewport
                "deviceScaleFactor": dpr if dpr in SANE_DPR else 0,
                "screenWidth": int(s.get("width") or 1920), "screenHeight": int(s.get("height") or 1080)}

    async def run_all(self, what: str, coros: list):
        for r in await asyncio.gather(*coros, return_exceptions=True):
            if isinstance(r, Exception):
                log_err(f"{what}: {r}")

    # -------------------------------------------------------------- tabs

    async def adopt(self, sid: str, info: Dict[str, Any], waiting: bool):
        """A new tab: overrides, scripts and proxy auth are in place before its first document
        runs (it is paused until then when it was opened after launch)."""
        if info["targetId"] in self.by_target:
            return
        self.page_seq += 1
        tab = Tab(self.page_seq, info["targetId"], sid, info.get("url", ""), info.get("title", ""))
        self.tabs[tab.pid] = tab
        self.by_session[sid] = tab
        self.by_target[tab.target_id] = tab
        setup = [self.cdp("Page.enable", sid), self.cdp("Page.setLifecycleEventsEnabled", sid, enabled=True),
                 *self.overrides(sid, True)]
        if self.proxy and self.proxy["username"]:
            setup.append(self.cdp("Fetch.enable", sid, handleAuthRequests=True, patterns=[{"urlPattern": "*"}]))
        await self.run_all("tab setup", setup)
        try:
            frame = (await self.cdp("Page.getFrameTree", sid))["frameTree"]["frame"]
            tab.frame_id, tab.loader = frame["id"], frame.get("loaderId")
        except Exception:
            pass
        if waiting:
            await self.quiet(self.cdp("Runtime.runIfWaitingForDebugger", sid))
        self.last_page = tab
        if not tab.ready.done():
            tab.ready.set_result(True)
        w = self.target_waiters.pop(tab.target_id, None)
        if w and not w.done():
            w.set_result(tab)

    async def adopt_frame(self, sid: str, waiting: bool):
        await self.run_all("frame setup", self.overrides(sid, False))
        if waiting:
            await self.quiet(self.cdp("Runtime.runIfWaitingForDebugger", sid))

    def forget(self, tab: Tab):
        if tab.closed:
            return
        tab.closed = True
        self.tabs.pop(tab.pid, None)
        self.by_session.pop(tab.session, None)
        self.by_target.pop(tab.target_id, None)
        if not self.started or self.closing:
            return
        if self.tabs:
            emit("tabs", tabs=self.collect_tabs())
        else:
            # Closing the last tab closes the profile, as in the Firefox engine. The saved tabs
            # are not overwritten with an empty list.
            self.closed_by_user = True
            emit("disconnected", reason=MANUAL_CLOSE)
            asyncio.create_task(self.shutdown())

    def open_tabs(self) -> List[Tab]:
        return [t for t in self.tabs.values() if not t.closed]

    def collect_tabs(self) -> List[str]:
        return [t.url for t in self.open_tabs() if t.url and t.url != "about:blank"]

    def active_page(self) -> Tab:
        tabs = self.open_tabs()
        if not tabs:
            raise RuntimeError("no open tab")
        if self.last_page is not None and not self.last_page.closed:
            return self.last_page
        return tabs[-1]

    def page_for(self, cmd: Dict[str, Any]) -> Tab:
        pid = cmd.get("pageId")
        if pid is not None:
            tab = self.tabs.get(int(pid))
            if tab is None or tab.closed:
                raise RuntimeError("the tab this script was driving has been closed")
            return tab
        return self.active_page()

    async def create_tab(self, url: Optional[str] = None, timeout: float = 30000, background: bool = False) -> Tab:
        target = (await self.cdp("Target.createTarget", url="about:blank", background=background))["targetId"]
        tab = self.by_target.get(target)
        if tab is None:
            fut = self.target_waiters.setdefault(target, asyncio.get_running_loop().create_future())
            tab = await asyncio.wait_for(fut, 15)
        await tab.ready
        if url:
            await self.navigate(tab, url, "domcontentloaded", timeout)
        if not background:
            self.last_page = tab
        return tab

    async def close_tab(self, tab: Tab):
        await self.quiet(self.cdp("Target.closeTarget", targetId=tab.target_id))
        self.forget(tab)

    # -------------------------------------------------------------- navigation

    async def wait_lifecycle(self, tab: Tab, loader: Optional[str], wait_until: str, timeout_ms: float):
        """Until document `loader` (the current one when None) reached `wait_until`."""
        if wait_until == "commit":
            return
        names = {"load": "load", "domcontentloaded": "DOMContentLoaded", "networkidle": "networkIdle"}
        if wait_until not in names:
            raise ValueError(f"waitUntil must be load, domcontentloaded, networkidle or commit, not {wait_until}")

        def reached():
            if tab.closed:
                raise RuntimeError("the tab was closed while it was loading")
            return names[wait_until] in tab.lifecycle.get(loader or tab.loader or "", ())

        async def wait():
            async with tab.changed:
                await tab.changed.wait_for(reached)

        await asyncio.wait_for(wait(), timeout_ms / 1000 if timeout_ms else None)

    async def navigate(self, tab: Tab, url: str, wait_until: str, timeout_ms: float):
        try:
            r = await asyncio.wait_for(self.cdp("Page.navigate", tab.session, url=url), timeout_ms / 1000 if timeout_ms else None)
            if r.get("errorText"):
                raise RuntimeError(f"{r['errorText']} at {url}")
            if r.get("loaderId"):  # none: a same-document navigation, already done
                await self.wait_lifecycle(tab, r["loaderId"], wait_until, timeout_ms)
        except asyncio.TimeoutError:
            raise RuntimeError(f"goto: timeout {int(timeout_ms)}ms exceeded navigating to {url}") from None

    # -------------------------------------------------------------- page helpers

    async def evaluate(self, tab: Tab, code: str, arg: Any = None, timeout_ms: float = 0, gesture: bool = False):
        """Playwright's evaluate: `code` is an expression, or a function source called with `arg`.
        Not as a user gesture unless asked: that would hand the page user activation
        (`navigator.userActivation`) with no input event behind it, for every internal read."""
        expr = ("(async () => { const __smpFn = (\n" + code + "\n);\n"
                "return typeof __smpFn === 'function' ? await __smpFn(" + ("undefined" if arg is None else json.dumps(arg)) +
                ") : await __smpFn; })()")
        call = self.cdp("Runtime.evaluate", tab.session, expression=expr, awaitPromise=True,
                        returnByValue=True, userGesture=gesture)
        r = await (asyncio.wait_for(call, timeout_ms / 1000) if timeout_ms else call)
        if r.get("exceptionDetails"):
            d = r["exceptionDetails"]
            text = (d.get("exception") or {}).get("description") or d.get("text") or "page error"
            raise RuntimeError(text.strip().splitlines()[0])
        res = r.get("result") or {}
        if "unserializableValue" in res:
            raise ValueError("result is not JSON-serialisable (NaN, Infinity or a circular value)")
        return res.get("value")

    async def eval_retry(self, tab: Tab, code: str, arg: Any, timeout_ms: float, gesture: bool = False):
        try:
            return await self.evaluate(tab, code, arg, gesture=gesture)
        except RuntimeError as e:
            # A navigation replaced the document mid-call: once the new page has a DOM, run again.
            msg = str(e).lower()
            if "context was destroyed" not in msg and "cannot find context" not in msg:
                raise
            await self.wait_lifecycle(tab, None, "domcontentloaded", timeout_ms)
            return await self.evaluate(tab, code, arg, gesture=gesture)

    async def element(self, tab: Tab, selector: str, state: str = "visible", act: Optional[str] = None,
                      timeout_ms: float = 30000, op: str = "wait_for"):
        """Poll until `selector` is in `state`, then optionally act on it. `timeout_ms` 0 waits forever."""
        if state not in ("attached", "detached", "visible", "hidden"):
            raise ValueError("state must be attached, detached, visible or hidden")
        loop = asyncio.get_running_loop()
        end = loop.time() + timeout_ms / 1000 if timeout_ms else None
        while True:
            try:
                out = await self.evaluate(tab, FIND_JS, {"sel": selector, "state": state, "act": act}, 10000)
            except RuntimeError as e:
                if "context" not in str(e).lower():  # a navigation in between: just poll again
                    raise
                out = None
            if out:
                return out
            if end is not None and loop.time() >= end:
                raise RuntimeError(f'{op}: timeout {int(timeout_ms)}ms exceeded waiting for "{selector}" to be {state}')
            await asyncio.sleep(0.1)

    async def mouse(self, tab: Tab, type_: str, x: float, y: float, **extra):
        await self.cdp("Input.dispatchMouseEvent", tab.session, type=type_, x=x, y=y, **extra)
        tab.mouse_xy = (x, y)  # where the pointer is now: human_* paths start here (human_input.py)

    async def key(self, tab: Tab, spec: str):
        """One press, e.g. "Enter", "a", "Control+a"."""
        *mods, main = spec.split("+") if spec != "+" else ["+"]
        bits = 0
        for m in mods:
            if m not in MODIFIERS:
                raise ValueError(f'unknown modifier "{m}" in "{spec}"')
            bits |= MODIFIERS[m][0]
            await self.cdp("Input.dispatchKeyEvent", tab.session, type="rawKeyDown", key=m, windowsVirtualKeyCode=MODIFIERS[m][1], modifiers=bits)
        await self.press_one(tab, key_event(main), bits)
        for m in reversed(mods):
            bits &= ~MODIFIERS[m][0]
            await self.cdp("Input.dispatchKeyEvent", tab.session, type="keyUp", key=m, windowsVirtualKeyCode=MODIFIERS[m][1], modifiers=bits)

    async def press_one(self, tab: Tab, ev: Dict[str, Any], mods: int = 0):
        mods |= ev.pop("modifiers", 0)
        text = ev.pop("text", "")
        if mods & 7:
            text = ""  # a Ctrl/Alt/Meta chord types nothing
        common = {**ev, "modifiers": mods, "nativeVirtualKeyCode": ev["windowsVirtualKeyCode"]}
        down = {**common, "type": "keyDown" if text else "rawKeyDown"}
        if text:
            down.update(text=text, unmodifiedText=text)
        await self.cdp("Input.dispatchKeyEvent", tab.session, **down)
        await self.cdp("Input.dispatchKeyEvent", tab.session, **common, type="keyUp")

    async def type_text(self, tab: Tab, text: str, delay_ms: float):
        for i, ch in enumerate(text):
            if i and delay_ms:
                await asyncio.sleep(delay_ms / 1000)
            await self.press_one(tab, key_event(ch))

    async def title_of(self, tab: Tab) -> str:
        try:
            return await self.evaluate(tab, "document.title", None, 3000)
        except Exception:
            return tab.title

    # -------------------------------------------------------------- cookies

    async def all_cookies(self) -> List[Dict[str, Any]]:
        return [pw_cookie(c) for c in (await self.cdp("Storage.getCookies")).get("cookies", [])]

    async def set_cookies(self, cookies: List[Dict[str, Any]]) -> int:
        """One by one, so a single cookie the browser refuses does not sink the batch."""
        results = await asyncio.gather(*(self.cdp("Storage.setCookies", cookies=[cdp_cookie(c)]) for c in cookies),
                                       return_exceptions=True)
        return sum(1 for r in results if not isinstance(r, Exception))

    async def dump_cookies(self, force: bool = False) -> int:
        if not self.browser or (self.closing and not force):
            return 0
        try:
            cookies = await asyncio.wait_for(self.all_cookies(), 5)
            if self.cookies_file:
                self.cookies_file.parent.mkdir(parents=True, exist_ok=True)
                tmp = self.cookies_file.with_suffix(".tmp")
                tmp.write_text(json.dumps(cookies, indent=2), encoding="utf-8")
                tmp.replace(self.cookies_file)
            emit("cookies", count=len(cookies))
            return len(cookies)
        except Exception:
            return 0

    # -------------------------------------------------------------- RPC

    async def handle_command(self, raw: str):
        if raw == "__EOF__":
            log_err("Parent pipe closed. Shutting down worker.")
            return await self.shutdown()
        try:
            cmd = json.loads(raw)
            action = cmd.get("cmd")
            if cmd.get("reqId") is not None:
                asyncio.create_task(self.handle_rpc(cmd["reqId"], action, cmd))
            elif action == "close":
                await self.shutdown()
            elif action == "new_page" and not self.closing:
                await self.create_tab(cmd.get("url"))
            elif action == "get_state":
                emit("state", tabs=self.collect_tabs(), cookieCount=await self.dump_cookies())
        except Exception as e:
            log_err(f"Error executing command: {e}")

    async def handle_rpc(self, req_id, op: str, cmd: Dict[str, Any]):
        try:
            result = await self.run_op(op, cmd)
            try:
                json.dumps(result, default=str, allow_nan=False)
            except ValueError:
                raise ValueError("result is not JSON-serialisable (NaN, Infinity or a circular value)")
            emit("reply", reqId=req_id, ok=True, result=result)
        except Exception as e:
            text = str(e) or ("timed out" if isinstance(e, asyncio.TimeoutError) else type(e).__name__)
            emit("reply", reqId=req_id, ok=False, error=text.strip().splitlines()[0][:500])

    async def run_op(self, op: str, cmd: Dict[str, Any]):
        if self.closing or not self.browser:
            raise RuntimeError("browser is closing")
        if self.start_task is not None and not self.start_task.done():
            try:
                await asyncio.wait_for(asyncio.shield(self.start_task), timeout=START_WAIT_S)
            except Exception:
                pass

        def num(key, default):
            value = cmd.get(key)
            return float(default if value is None else value)

        timeout = num("timeout", 30000)

        if op == "new_tab":
            tab = await self.create_tab(cmd.get("url"), timeout)
            return {"url": tab.url, "pageId": tab.pid}
        if op == "close_tab":
            if cmd.get("pageId") is None:
                raise ValueError("close_tab needs the pageId of the tab to close")
            tab = self.page_for(cmd)
            if len(self.open_tabs()) <= 1:
                raise RuntimeError("close_tab refuses to close the last open tab (the profile would close with it)")
            await self.close_tab(tab)
            return True
        if op == "cookies":
            return await self.all_cookies()
        if op == "add_cookies":
            await self.set_cookies(cmd.get("cookies") or [])
            return await self.dump_cookies()

        tab = self.page_for(cmd)
        await tab.ready
        s = tab.session
        if op == "eval":
            return await self.eval_retry(tab, cmd["code"], cmd.get("arg"), timeout, bool(cmd.get("userGesture")))
        if op == "goto":
            await self.navigate(tab, cmd["url"], cmd.get("waitUntil") or "domcontentloaded", timeout)
            self.last_page = tab
            return tab.url
        if op == "reload":
            old = tab.loader
            await self.cdp("Page.reload", s)
            async with tab.changed:
                await asyncio.wait_for(tab.changed.wait_for(lambda: tab.loader != old or tab.closed), timeout / 1000 or None)
            await self.wait_lifecycle(tab, tab.loader, cmd.get("waitUntil") or "domcontentloaded", timeout)
            return tab.url
        if op == "click":
            pt = await self.element(tab, cmd["selector"], "visible", "center", timeout, "click")
            await self.mouse(tab, "mouseMoved", pt["x"], pt["y"])
            await self.mouse(tab, "mousePressed", pt["x"], pt["y"], button="left", clickCount=1)
            await self.mouse(tab, "mouseReleased", pt["x"], pt["y"], button="left", clickCount=1)
            return None
        if op == "fill":
            await self.element(tab, cmd["selector"], "visible", "select", timeout, "fill")
            value = str(cmd.get("value", ""))
            if value:
                await self.cdp("Input.insertText", s, text=value)
            else:
                await self.evaluate(tab, "document.execCommand('delete')")
            return None
        if op == "type":
            await self.element(tab, cmd["selector"], "visible", "focus", timeout, "type")
            await self.type_text(tab, str(cmd.get("text", "")), num("delay", 70))
            return None
        if op == "press":
            if cmd.get("selector"):
                await self.element(tab, cmd["selector"], "visible", "focus", timeout, "press")
            await self.key(tab, cmd["key"])
            return None
        if op == "keyboard_type":
            await self.type_text(tab, str(cmd.get("text", "")), num("delay", 80))
            return True
        if op == "wait_for":
            await self.element(tab, cmd["selector"], cmd.get("state") or "visible", None, timeout)
            return None
        if op == "scroll":
            size = await self.evaluate(tab, "({ w: innerWidth, h: innerHeight })")
            await self.mouse(tab, "mouseWheel", size["w"] / 2, size["h"] / 2, deltaX=0, deltaY=num("dy", 600))
            return None
        if op == "screenshot":
            path = Path(cmd["path"])
            path.parent.mkdir(parents=True, exist_ok=True)
            opts: Dict[str, Any] = {"format": "png"}
            if cmd.get("fullPage"):
                size = (await self.cdp("Page.getLayoutMetrics", s))["cssContentSize"]
                opts.update(captureBeyondViewport=True,
                            clip={"x": 0, "y": 0, "width": size["width"], "height": size["height"], "scale": 1})
            shot = await asyncio.wait_for(self.cdp("Page.captureScreenshot", s, **opts), timeout / 1000 or None)
            path.write_bytes(base64.b64decode(shot["data"]))
            return str(path)
        if op == "info":
            return {"url": tab.url, "title": await self.title_of(tab), "pageId": tab.pid,
                    "headless": self.headless, **self.public_geo()}
        if op == "tabs":
            active = self.active_page()
            return [{"pageId": t.pid, "url": t.url, "title": await self.title_of(t), "active": t is active}
                    for t in self.open_tabs()]
        if op == "close_other_tabs":
            others = [t for t in self.open_tabs() if t is not tab]
            for t in others:
                await self.close_tab(t)
            self.last_page = tab
            return len(others)
        if op == "window":
            if self.headless or sys.platform != "win32":
                raise RuntimeError("no browser window found (headless)")
            if self.winctl is None:
                self.winctl = WinCtl()
            return self.winctl.run(str(cmd.get("action") or "bounds"), cmd.get("rect"))
        if op.startswith("human_"):
            import human_input  # human_move/click/type/scroll/wander/scroll_burst: one model for both engines
            return await human_input.run(tab, lambda: human_input.CdpInput(self, tab), op, cmd, self.seed, timeout)
        raise ValueError(f"unknown op: {op}")

    def public_geo(self) -> Dict[str, Any]:
        return {k: self.geo[k] for k in ("exitIp", "country") if self.geo.get(k)}

    # -------------------------------------------------------------- lifecycle

    async def identity(self):
        """The UA override, when one is needed: headless says "HeadlessChrome", and a Chrome
        fingerprint brings its OS parts. Brand and version always stay the real binary's: they
        are read from the browser itself, on a secure page (userAgentData needs one)."""
        product = await self.cdp("Browser.getVersion")
        ua = product.get("userAgent", "")
        if not (self.headless or self.fp):
            return
        tab = await self.create_tab(background=True)
        try:
            await self.navigate(tab, f"http://127.0.0.1:{self.browser.config.port}/json/version", "commit", 10000)
            low = None
            for _ in range(50):  # until the secure document is in
                low = await self.quiet(self.evaluate(tab, "isSecureContext && navigator.userAgentData && navigator.userAgentData.toJSON()", None, 2000))
                if low:
                    break
                await asyncio.sleep(0.1)
            if not low:
                raise RuntimeError(f"no userAgentData on {tab.url}")
            high = await self.quiet(self.evaluate(tab, "navigator.userAgentData.getHighEntropyValues(['fullVersionList', "
                                                       "'uaFullVersion', 'platformVersion', 'architecture', 'bitness', "
                                                       "'model', 'wow64'])", None, 3000)) or {}
            full = str(product.get("product", "")).split("/")[-1]
            meta = {"brands": low["brands"], "platform": low.get("platform", "Windows"), "mobile": bool(low.get("mobile")),
                    # Some builds never answer high-entropy hints: then the real full version from
                    # the browser itself, and GREASE brands as <major>.0.0.0 like Chrome does.
                    "fullVersionList": high.get("fullVersionList") or [
                        {"brand": b["brand"], "version": f"{b['version']}.0.0.0" if "not" in b["brand"].lower() else full}
                        for b in low["brands"]],
                    "fullVersion": high.get("uaFullVersion") or full,
                    "platformVersion": high.get("platformVersion", ""), "architecture": high.get("architecture", "x86"),
                    "bitness": high.get("bitness", "64"), "model": high.get("model", ""), "wow64": bool(high.get("wow64"))}
            meta.update({k: v for k, v in (self.fp.get("uad") or {}).items() if v is not None})
            self.ua_override = {"userAgent": ua.replace("HeadlessChrome/", "Chrome/"),
                                "platform": self.fp.get("platform") or "Win32", "userAgentMetadata": meta}
        except Exception as e:
            log_err(f"could not read the browser's own client hints, UA left as is: {e!r}")
        finally:
            await self.close_tab(tab)
        if self.ua_override:
            await self.run_all("UA override", [self.cdp("Emulation.setUserAgentOverride", t.session, **self.ua_override)
                                               for t in self.open_tabs()])

    async def apply_launch_extras(self):
        if self.cookies_import_file and self.cookies_import_file.exists():
            try:
                cookies = json.loads(self.cookies_import_file.read_text(encoding="utf-8"))
                await self.set_cookies(cookies)
                key = lambda c: (c.get("name"), str(c.get("domain", "")).lstrip("."), c.get("path") or "/")
                have = {key(c) for c in await self.all_cookies()}
                emit("cookies_imported", count=sum(1 for c in cookies if key(c) in have), total=len(cookies))
                self.cookies_import_file.unlink(missing_ok=True)
            except Exception as e:
                failed = self.cookies_import_file.with_suffix(".failed.json")
                try:
                    self.cookies_import_file.replace(failed)
                except Exception:
                    pass
                emit("cookies_import_failed", error=f"{str(e)[:250]} (kept as {failed.name})")

    async def open_start_urls(self):
        for i, url in enumerate(self.initial_urls):
            if self.closing:
                return
            try:
                tabs = self.open_tabs()
                if i == 0 and tabs:
                    await self.navigate(tabs[0], url, "domcontentloaded", 30000)
                    self.last_page = tabs[0]
                else:
                    await self.create_tab(url)
            except Exception as e:
                log_err(f"Start URL failed ({url}): {e}")

    async def periodic(self):
        while not self.closing:
            await asyncio.sleep(6)
            if self.closing:
                break
            await self.dump_cookies()
            emit("tabs", tabs=self.collect_tabs())

    async def commands(self):
        while not self.closing:
            await self.handle_command(await self.queue.get())

    async def watch_process(self):
        await self.browser._process.wait()
        if not self.closing:
            # The browser went away on its own: the user quit it (or it crashed).
            self.closed_by_user = True
            emit("disconnected", reason="browser closed")
            await self.shutdown()

    async def shutdown(self):
        if self.closing:
            return
        self.closing = True
        try:
            if self.browser:
                await self.dump_cookies(force=True)
                proc = self.browser._process
                if proc and proc.returncode is None:
                    await self.quiet(asyncio.wait_for(self.cdp("Browser.close"), 2))
                    try:
                        await asyncio.wait_for(proc.wait(), 2)
                    except asyncio.TimeoutError:
                        proc.kill()
        except Exception as e:
            log_err(f"Error during browser close: {e}")
        finally:
            emit("closed", reason=MANUAL_CLOSE if self.closed_by_user else "normal termination")
            self.done.set()

    def launch_args(self) -> List[str]:
        args = [
            "--no-first-run", "--no-default-browser-check",
            # WebRTC may only use the proxy (the profile prefs say the same): no direct UDP.
            "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
            "--webrtc-ip-handling-policy=disable_non_proxied_udp",
            "--disable-quic",
            "--disable-features=Translate,Prerender2",
        ]
        if self.proxy:
            if self.proxy["scheme"].startswith("socks") and self.proxy["username"]:
                raise RuntimeError("Chromium browsers can't log in to a SOCKS proxy with a password — "
                                   "use an HTTP proxy or Stealth Firefox for this profile")
            args.append(f"--proxy-server={proxy_url(self.proxy, with_auth=False).replace('socks5h://', 'socks5://')}")
            # No local DNS at all, v4 or v6: every name is resolved by the proxy. Only the proxy's
            # own host (and loopback, which never goes through a proxy) may be looked up here.
            args.append(f"--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE {self.proxy['host']} , EXCLUDE localhost")
        if self.languages:
            args.append(f"--lang={self.languages[0]}")
        if self.headless:
            s = self.fp.get("screen") or {}
            args.append(f"--window-size={int(s.get('availWidth') or 1920)},{int(s.get('availHeight') or 1040)}")
        args.append("about:blank")  # never the new-tab page, which loads remote content before we attach
        return args

    async def run(self):
        loop = asyncio.get_running_loop()
        read_stdin(loop, self.queue, lambda: not self.closing)
        self.profile_dir.mkdir(parents=True, exist_ok=True)
        emit("starting", id=self.session_id, profileDir=str(self.profile_dir), python=sys.version.split()[0])
        try:
            if not self.browser_path or not Path(self.browser_path).exists():
                raise RuntimeError(f"browser not found at {self.browser_path}")
            self.launch_args()  # refuses what Chrome can't do (a SOCKS password) before any network
            if self.proxy:
                self.geo = known_geo(self.geo_arg) or await asyncio.to_thread(resolve_geo, self.proxy)
                self.languages = languages_for(self.geo["locale"])
            elif self.fp.get("languages"):
                self.languages = list(self.fp["languages"])
            write_prefs(self.profile_dir, self.languages)
            if self.fp:
                self.scripts.append(FP_JS.replace("__FP__", json.dumps(self.fp)))
            init_scripts = []
            if self.init_scripts_file and self.init_scripts_file.exists():
                try:
                    init_scripts = json.loads(self.init_scripts_file.read_text(encoding="utf-8"))
                except Exception as e:
                    log_err(f"Failed to read init scripts: {e}")
            self.scripts += init_scripts
            config = ChromeConfig(user_data_dir=str(self.profile_dir), headless=self.headless,
                                  browser_executable_path=self.browser_path, browser_args=self.launch_args())
            if not self.headless:
                # Its own taskbar button, not one shared by every profile of this browser (worker_common).
                taskbar_identity(self.session_id, lambda: not self.closing)
            self.browser = await nodriver.Browser.create(config)
            kill_with_worker(self.browser._process.pid)
            self.browser.process_event = self.on_cdp
            await self.cdp("Target.setDiscoverTargets", discover=True)
            # Geolocation is denied to every origin unless the profile opts in to a spoofed position.
            spoof = self.geolocation == "spoof" and self.geo.get("lat") is not None
            await self.quiet(self.cdp("Browser.setPermission", permission={"name": "geolocation"},
                                      setting="granted" if spoof else "denied"))
            await self.cdp("Target.setAutoAttach", autoAttach=True, waitForDebuggerOnStart=True, flatten=True,
                           filter=[{"type": "page", "exclude": False}])
            if init_scripts:
                emit("init_scripts", count=len(init_scripts))
            end = loop.time() + 15
            while not self.open_tabs() and loop.time() < end:
                await asyncio.sleep(0.05)
            if not self.open_tabs():
                await self.create_tab()
            await asyncio.gather(*(t.ready for t in self.open_tabs()))
            await self.identity()
            await self.apply_launch_extras()
            self.started = True
            # cdpPort: nodriver's DevTools port on 127.0.0.1, for POST /api/sessions/:id/cdp (ENGINE.md §7).
            emit("ready", id=self.session_id, seed=self.seed, tabs=self.collect_tabs(),
                 cookieCount=await self.dump_cookies(), headless=self.headless,
                 cdpPort=self.browser.config.port, **self.public_geo())
        except Exception as e:
            msg = str(e).strip() or type(e).__name__
            if "Failed to connect to browser" in msg:
                msg = "the browser did not start — is this profile already open in it?"
            log_err(f"Session launch error: {msg}")
            emit("error", error=msg)
            if self.browser and self.browser._process and self.browser._process.returncode is None:
                self.browser._process.kill()
            raise
        if self.initial_urls:
            self.start_task = asyncio.create_task(self.open_start_urls())
        tasks = [asyncio.create_task(c) for c in (self.periodic(), self.commands(), self.watch_process())]
        await self.done.wait()
        for t in tasks:
            t.cancel()


def main():
    parser = argparse.ArgumentParser(description="Chromium browser worker")
    parser.add_argument("--id", required=True)
    parser.add_argument("--profile-dir", required=True)
    parser.add_argument("--browser-path", required=True)
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--url", action="append", default=None)
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--cookies-file", default=None)
    parser.add_argument("--init-scripts", default=None)
    parser.add_argument("--cookies-import", default=None)
    parser.add_argument("--fingerprint", default=None, help="JSON: the coherent part of a Chrome fingerprint")
    parser.add_argument("--geolocation", default="block", help="block | spoof")
    parser.add_argument("--geo", default=None, help="JSON {ip, country, timezone, lat, lon} of the proxy exit")
    parser.add_argument("--prefs", default=None, help="Firefox prefs: ignored by Chromium")
    args, _ = parser.parse_known_args()
    try:
        asyncio.run(ChromiumWorker(args).run())
        os._exit(0)
    except BaseException:
        os._exit(1)


if __name__ == "__main__":
    main()
