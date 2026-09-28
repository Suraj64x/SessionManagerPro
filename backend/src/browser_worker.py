"""
InvisiblePlaywright Worker Process for SessionManagerPro.
Manages a persistent, undetected Firefox session using invisible_playwright.
Communicates with Node.js backend over JSON lines via stdin/stdout.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import threading
from pathlib import Path
from typing import Any, Dict, Optional

# First: it re-wraps the standard streams as UTF-8 before anything else can print.
from worker_common import WinCtl, emit, log_err, taskbar_identity

from invisible_playwright.async_api import InvisiblePlaywright


def lookup_country(ip: Optional[str]) -> Optional[str]:
    """ISO country code from the geoip database the engine already fetched at launch.
    A local file read only: ensure_geoip_mmdb() would do a network HEAD on every call."""
    if not ip:
        return None
    try:
        from invisible_core._geo import _geo_record
        from invisible_core._geoip_db import _cached_geoip_mmdb
        db = os.environ.get("STEALTHFOX_GEOIP_MMDB") or _cached_geoip_mmdb()
        rec = _geo_record(ip, db) if db else None
        return ((rec or {}).get("country") or {}).get("iso_code") or None
    except Exception:
        return None


def use_known_geo(geo: Dict[str, Any]) -> Optional[str]:
    """Hand the engine the exit IP's geo the panel already looked up (worker_runner.js exitGeo).
    The engine then skips its own egress round-trip (~2 s) and its bundled database, which puts
    some US ISP exits in the wrong zone: Virginia IPs in America/Chicago, which Fingerprint Pro
    reports as "VPN (timezone mismatch)" (measured 2026-09-27). Returns the exit country's locale,
    or None when this engine version doesn't have the hook (the launch then goes as before)."""
    try:
        import invisible_playwright.async_api as api
        from invisible_core import _geo

        def known(_timezone, proxy):
            return _geo.SessionGeo(geo["timezone"], geo["ip"], geo.get("lat"), geo.get("lon"),
                                   _geo._srflx_soppresso(proxy, geo["ip"]))

        api.prepare_session_geo = known
        return _geo._COUNTRY_LOCALE.get(str(geo.get("country") or "").upper(), "en-US")
    except Exception as e:
        log_err(f"known geo not applied, the engine resolves it: {e}")
        return None


def bind_in_background() -> None:
    """The engine ties Firefox's processes to this worker (a job object) by scanning until the
    tree settles, ~2.7 s in front of every launch (measured 2026-09-27). That only matters if the
    worker is killed, so it runs beside the launch instead of before it."""
    try:
        import invisible_playwright.async_api as api

        bind = api.InvisiblePlaywright._bind_process_tree
        api.InvisiblePlaywright._bind_process_tree = (
            lambda self: threading.Thread(target=bind, args=(self,), daemon=True).start())
    except Exception as e:
        log_err(f"process binding stays inline: {e}")


class BrowserWorker:
    def __init__(self, args: argparse.Namespace):
        self.session_id = args.id
        self.profile_dir = Path(args.profile_dir).resolve()
        self.seed = int(args.seed) if args.seed is not None else None
        self.headless = args.headless
        self.initial_urls = [u for u in (args.url or []) if u]
        self.timezone = args.timezone or ""
        self.locale = args.locale or "auto"
        self.icon = args.icon  # this thread's numbered taskbar icon (.ico), drawn by the panel
        # {ip, country, timezone, lat, lon} of the exit, from the panel; None = the engine finds it.
        self.known_geo: Optional[Dict[str, Any]] = None
        if args.geo:
            try:
                g = json.loads(args.geo)
                if g and g.get("ip") and g.get("timezone"):
                    self.known_geo = g
            except Exception as e:
                log_err(f"Failed to parse geo: {e}")
        self.cookies_file = Path(args.cookies_file).resolve() if args.cookies_file else None
        self.init_scripts_file = Path(args.init_scripts).resolve() if args.init_scripts else None
        self.cookies_import_file = Path(args.cookies_import).resolve() if args.cookies_import else None
        self.last_page = None
        # Stable ids so an automation run can pin the tab it drives.
        self.pages_by_id: Dict[int, Any] = {}
        self.page_ids: Dict[int, int] = {}
        self.page_seq = 0
        self.start_task = None

        # Parse proxy. It arrives in the environment rather than on the command line,
        # which any local process can read (and which would expose the password).
        self.proxy_dict: Optional[Dict[str, str]] = None
        raw_proxy = os.environ.get("SMP_PROXY") or args.proxy
        if raw_proxy:
            try:
                p = json.loads(raw_proxy) if isinstance(raw_proxy, str) else raw_proxy
                if p and p.get("host") and p.get("port"):
                    scheme = p.get("scheme", "http").lower()
                    if not scheme.startswith(("http", "socks")):
                        scheme = "http"
                    server = f"{scheme}://{p['host']}:{p['port']}"
                    proxy_obj = {"server": server}
                    if p.get("username"):
                        proxy_obj["username"] = str(p["username"])
                    if p.get("password"):
                        proxy_obj["password"] = str(p["password"])
                    self.proxy_dict = proxy_obj
            except Exception as e:
                log_err(f"Failed to parse proxy: {e}")

        # Parse pin
        self.pin_dict: Optional[Dict[str, Any]] = None
        if args.pin:
            try:
                self.pin_dict = json.loads(args.pin) if isinstance(args.pin, str) else args.pin
            except Exception as e:
                log_err(f"Failed to parse pin: {e}")

        # Extra Firefox prefs, applied on top of the engine's fingerprint prefs.
        self.prefs: Optional[Dict[str, Any]] = None
        if args.prefs:
            try:
                self.prefs = json.loads(args.prefs)
                if not isinstance(self.prefs, dict):
                    raise ValueError("expected a JSON object")
            except Exception as e:
                log_err(f"Failed to parse prefs: {e}")
                self.prefs = None

        self.engine = None
        # {exitIp, country} once known after launch; stays empty when the engine could not tell.
        self.geo: Dict[str, str] = {}
        self.winctl: Optional[WinCtl] = None
        self.ctx = None
        self.closing = False
        self.closed_by_user = False
        self.shutting_down = False
        self.stopped = asyncio.Event()  # set once the browser is closed (or gone)
        self.input_queue: asyncio.Queue[str] = asyncio.Queue()
        self.running = True

    def read_stdin_thread(self, loop: asyncio.AbstractEventLoop):
        """Thread reading commands from stdin."""
        while self.running:
            try:
                line = sys.stdin.readline()
                if not line:  # EOF -> parent closed pipe
                    loop.call_soon_threadsafe(self.input_queue.put_nowait, "__EOF__")
                    break
                line = line.strip()
                if line:
                    loop.call_soon_threadsafe(self.input_queue.put_nowait, line)
            except (ValueError, OSError):
                break
            except Exception:
                break

    async def dump_cookies(self, force: bool = False):
        """Extract and persist cookies. `force` is for the final save during shutdown."""
        if not self.ctx or (self.closing and not force):
            return 0
        try:
            cookies = await self.ctx.cookies()
            if self.cookies_file:
                self.cookies_file.parent.mkdir(parents=True, exist_ok=True)
                with open(self.cookies_file, "w", encoding="utf-8") as f:
                    json.dump(cookies, f, indent=2)
            emit("cookies", count=len(cookies))
            return len(cookies)
        except Exception:
            return 0

    def collect_tabs(self) -> list[str]:
        """Collect current URLs of open pages."""
        if not self.ctx or self.closing:
            return []
        try:
            return [p.url for p in self.ctx.pages if p.url and p.url != "about:blank"]
        except Exception:
            return []

    async def attach_page(self, page):
        """Track page lifecycle and navigation. Safe to call twice for the same page."""
        self.last_page = page
        if id(page) in self.page_ids:
            return
        self.page_seq += 1
        self.page_ids[id(page)] = self.page_seq
        self.pages_by_id[self.page_seq] = page

        def on_navigated(frame):
            if frame == page.main_frame and not self.closing:
                self.last_page = page
                tabs = self.collect_tabs()
                emit("tabs", tabs=tabs, currentUrl=page.url)

        page.on("framenavigated", on_navigated)

        def on_page_close():
            self.pages_by_id.pop(self.page_ids.pop(id(page), None), None)
            if not self.closing:
                # Closing the last window must not overwrite the saved tabs with an empty
                # list, or "reopen last tabs" would only work after a Stop from the panel.
                if self.ctx and len(self.ctx.pages) > 0:
                    emit("tabs", tabs=self.collect_tabs())
                if self.ctx and len(self.ctx.pages) == 0:
                    self.closed_by_user = True
                    asyncio.create_task(self.shutdown())

        page.on("close", on_page_close)

    async def handle_command(self, cmd_raw: str):
        """Handle incoming command from Node.js parent."""
        if cmd_raw == "__EOF__":
            log_err("Parent pipe closed. Shutting down worker.")
            await self.shutdown()
            return

        try:
            cmd = json.loads(cmd_raw)
            action = cmd.get("cmd")
            if cmd.get("reqId") is not None:
                asyncio.create_task(self.handle_rpc(cmd["reqId"], action, cmd))
                return
            if action == "close":
                self.closing = True
                await self.shutdown()
            elif action == "new_page":
                url = cmd.get("url")
                if self.ctx and not self.closing:
                    p = await self.ctx.new_page()
                    await self.attach_page(p)
                    if url:
                        await p.goto(url, wait_until="domcontentloaded")
            elif action == "get_state":
                tabs = self.collect_tabs()
                cookie_count = await self.dump_cookies()
                emit("state", tabs=tabs, cookieCount=cookie_count)
        except Exception as e:
            log_err(f"Error executing command: {e}")

    def page_for(self, cmd: Dict[str, Any]):
        """The tab an RPC targets: the pinned one if given, else the active one."""
        pid = cmd.get("pageId")
        if pid is not None:
            page = self.pages_by_id.get(int(pid))
            if page is None or page.is_closed():
                raise RuntimeError("the tab this script was driving has been closed")
            return page
        return self.active_page()

    def active_page(self):
        pages = [p for p in (self.ctx.pages if self.ctx else []) if not p.is_closed()]
        if not pages:
            raise RuntimeError("no open tab")
        if self.last_page is not None and not self.last_page.is_closed():
            return self.last_page
        return pages[-1]

    async def handle_rpc(self, req_id, op: str, cmd: Dict[str, Any]):
        try:
            result = await self.run_op(op, cmd)
            try:
                # NaN/Infinity would serialise to tokens JSON.parse rejects; the line would be
                # dropped and the caller would wait for its timeout. Fail fast instead.
                json.dumps(result, default=str, allow_nan=False)
            except ValueError:
                raise ValueError("result is not JSON-serialisable (NaN, Infinity or a circular value)")
            emit("reply", reqId=req_id, ok=True, result=result)
        except Exception as e:
            first_line = (str(e) or type(e).__name__).strip().splitlines()[0]
            emit("reply", reqId=req_id, ok=False, error=first_line[:500])

    async def run_op(self, op: str, cmd: Dict[str, Any]):
        """One Playwright action against the active tab. Keep this list small and boring."""
        if self.closing or not self.ctx:
            raise RuntimeError("browser is closing")

        # Scripts see the profile as the operator would: with its start pages open.
        # Capped, so one slow page never blocks a script for long.
        if self.start_task is not None and not self.start_task.done():
            try:
                await asyncio.wait_for(asyncio.shield(self.start_task), timeout=30)
            except Exception:
                pass

        def num(key, default):
            # An explicit 0 is a real value, not "use the default".
            value = cmd.get(key)
            return float(default if value is None else value)

        timeout = num("timeout", 30000)

        if op == "new_tab":
            page = await self.ctx.new_page()
            await self.attach_page(page)
            if cmd.get("url"):
                await page.goto(cmd["url"], wait_until="domcontentloaded", timeout=timeout)
            return {"url": page.url, "pageId": self.page_ids.get(id(page))}
        if op == "close_tab":
            if cmd.get("pageId") is None:
                raise ValueError("close_tab needs the pageId of the tab to close")
            page = self.page_for(cmd)
            if len([p for p in self.ctx.pages if not p.is_closed()]) <= 1:
                raise RuntimeError("close_tab refuses to close the last open tab (the profile would close with it)")
            await page.close()
            return True

        page = self.page_for(cmd)
        if op == "eval":
            try:
                return await page.evaluate(cmd["code"], cmd.get("arg"))
            except Exception as e:
                # A navigation replaced the document mid-call. Once the new page has a DOM,
                # run again rather than surfacing an engine-internal error.
                if "execution context" not in str(e).lower():
                    raise
                await page.wait_for_load_state("domcontentloaded", timeout=timeout)
                return await page.evaluate(cmd["code"], cmd.get("arg"))
        if op == "goto":
            await page.goto(cmd["url"], wait_until=cmd.get("waitUntil") or "domcontentloaded", timeout=timeout)
            return page.url
        if op == "click":
            await page.click(cmd["selector"], timeout=timeout)
            return None
        if op == "fill":
            await page.fill(cmd["selector"], str(cmd.get("value", "")), timeout=timeout)
            return None
        if op == "type":
            await page.locator(cmd["selector"]).press_sequentially(
                str(cmd.get("text", "")), delay=num("delay", 70), timeout=timeout
            )
            return None
        if op == "press":
            if cmd.get("selector"):
                await page.press(cmd["selector"], cmd["key"], timeout=timeout)
            else:
                await page.keyboard.press(cmd["key"])
            return None
        if op == "keyboard_type":
            # Into whatever has focus: no selector, so it also reaches shadow DOM and canvas apps.
            await page.keyboard.type(str(cmd.get("text", "")), delay=num("delay", 80))
            return True
        if op == "reload":
            await page.reload(wait_until=cmd.get("waitUntil") or "domcontentloaded", timeout=timeout)
            return page.url
        if op == "tabs":
            active = self.active_page()
            return [
                {"pageId": self.page_ids.get(id(p)), "url": p.url, "title": await p.title(), "active": p is active}
                for p in self.ctx.pages if not p.is_closed()
            ]
        if op == "close_other_tabs":
            others = [p for p in self.ctx.pages if p is not page and not p.is_closed()]
            for p in others:
                await p.close()
            self.last_page = page
            return len(others)
        if op == "window":
            if self.headless or sys.platform != "win32":
                raise RuntimeError("no browser window found (headless)")
            if self.winctl is None:
                self.winctl = WinCtl()
            return self.winctl.run(str(cmd.get("action") or "bounds"), cmd.get("rect"))
        if op == "wait_for":
            await page.wait_for_selector(cmd["selector"], state=cmd.get("state") or "visible", timeout=timeout)
            return None
        if op == "scroll":
            await page.mouse.wheel(0, num("dy", 600))
            return None
        if op == "screenshot":
            path = Path(cmd["path"])
            path.parent.mkdir(parents=True, exist_ok=True)
            await page.screenshot(path=str(path), full_page=bool(cmd.get("fullPage")))
            return str(path)
        if op == "info":
            return {"url": page.url, "title": await page.title(), "pageId": self.page_ids.get(id(page)),
                    "headless": self.headless, **self.geo}
        if op == "cookies":
            return await self.ctx.cookies()
        if op == "add_cookies":
            await self.ctx.add_cookies(cmd.get("cookies") or [])
            return await self.dump_cookies()
        if op.startswith("human_"):
            import human_input  # human_move/click/type/scroll/wander/scroll_burst: one model for both engines
            return await human_input.run(page, lambda: human_input.PlaywrightInput(page), op, cmd, self.seed, timeout)
        raise ValueError(f"unknown op: {op}")

    async def apply_launch_extras(self, ctx):
        """Auto-run scripts and a pending cookie import, applied before the first navigation."""
        if self.init_scripts_file and self.init_scripts_file.exists():
            try:
                scripts = json.loads(self.init_scripts_file.read_text(encoding="utf-8"))
                for source in scripts:
                    await ctx.add_init_script(script=source)
                emit("init_scripts", count=len(scripts))
            except Exception as e:
                log_err(f"Failed to apply init scripts: {e}")

        if self.cookies_import_file and self.cookies_import_file.exists():
            try:
                cookies = json.loads(self.cookies_import_file.read_text(encoding="utf-8"))
                await ctx.add_cookies(cookies)
                # The engine can reject cookies without raising; count what it kept.
                key = lambda c: (c.get("name"), str(c.get("domain", "")).lstrip("."), c.get("path") or "/")
                have = {key(c) for c in await ctx.cookies()}
                landed = sum(1 for c in cookies if key(c) in have)
                emit("cookies_imported", count=landed, total=len(cookies))
                # One-shot: the cookies now live in the profile; never re-apply stale ones.
                self.cookies_import_file.unlink(missing_ok=True)
            except Exception as e:
                # Keep the batch rather than losing it to one malformed cookie.
                failed = self.cookies_import_file.with_suffix(".failed.json")
                try:
                    self.cookies_import_file.replace(failed)
                except Exception:
                    pass
                emit("cookies_import_failed", error=f"{str(e)[:250]} (kept as {failed.name})")

    async def open_start_urls(self, ctx):
        """One tab per start URL, reusing the tab Firefox opened for the first."""
        for i, url in enumerate(self.initial_urls):
            if self.closing:
                return
            try:
                if i == 0 and ctx.pages:
                    page = ctx.pages[0]
                else:
                    page = await ctx.new_page()
                    await self.attach_page(page)
                await page.goto(url, wait_until="domcontentloaded")
            except Exception as e:
                log_err(f"Start URL failed ({url}): {e}")

    async def periodic_tasks(self):
        """Periodically sync cookies and tabs."""
        while not self.closing and self.running:
            await asyncio.sleep(6)
            if self.closing or not self.running:
                break
            await self.dump_cookies()
            tabs = self.collect_tabs()
            emit("tabs", tabs=tabs)

    async def command_listener(self):
        """Listen for and process stdin commands."""
        while not self.closing and self.running:
            try:
                cmd_raw = await self.input_queue.get()
                await self.handle_command(cmd_raw)
            except asyncio.CancelledError:
                break
            except Exception as e:
                log_err(f"Command listener error: {e}")

    async def shutdown(self):
        """Save the cookies, report the profile closed, then let run() close the browser. Runs once; a
        second caller waits for the first. Nothing cancels it half-way: the main loop waits for
        `stopped` instead of cancelling the task that runs this, which used to drop the final
        cookie save on Stop."""
        if self.shutting_down:
            await self.stopped.wait()
            return
        self.shutting_down = self.closing = True
        try:
            if self.ctx:
                await asyncio.wait_for(self.dump_cookies(force=True), 10)
        except Exception as e:
            log_err(f"Final cookie save failed: {e}")
        finally:
            # The panel may show the profile stopped now: its cookies are saved. Firefox needs
            # ~2 s more to quit; the parent waits for this process to exit before a relaunch.
            emit("closed", reason="closed by user" if self.closed_by_user else "normal termination")
        # The engine's teardown (leaving `async with` in run) closes the browser and reaps what is
        # left of its process tree: ~2 s. Closing the context from here instead took ~14 s with a
        # window open (measured 2026-09-27).
        self.running = False
        self.stopped.set()

    def on_context_closed(self):
        """The browser went away without us closing it (it crashed or was killed)."""
        if self.shutting_down:
            return
        self.shutting_down = self.closing = True
        self.running = False
        emit("closed", reason="browser closed")
        self.stopped.set()

    async def watch_windows(self):
        """Juggler keeps Firefox running after its last window closes and does not report the tab
        as closed (measured 2026-09-27: no event 20 s after WM_CLOSE), so a user closing the
        browser shows only as this profile having no window left. Two misses in a row, so a
        window being re-created never reads as closed."""
        if self.headless or sys.platform != "win32":
            return
        ctl, seen, misses = WinCtl(), False, 0
        while not self.shutting_down:
            await asyncio.sleep(1.0)
            try:
                has = await asyncio.to_thread(ctl.find) is not None
            except Exception:
                continue
            misses = 0 if has else misses + 1
            seen = seen or has
            if seen and misses >= 2 and not self.shutting_down:
                self.closed_by_user = True
                await self.shutdown()
                return

    async def run(self):
        loop = asyncio.get_running_loop()
        def exception_handler(l, context):
            exc = context.get("exception")
            if exc and "TargetClosedError" in str(type(exc)):
                return
            l.default_exception_handler(context)
        loop.set_exception_handler(exception_handler)

        threading.Thread(target=self.read_stdin_thread, args=(loop,), daemon=True).start()

        self.profile_dir.mkdir(parents=True, exist_ok=True)

        py_ver = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
        emit("starting", id=self.session_id, profileDir=str(self.profile_dir), python=py_ver)

        launch_kwargs: Dict[str, Any] = {
            "profile_dir": self.profile_dir,
            "headless": self.headless,
            "humanize": True,
        }

        if self.seed is not None:
            launch_kwargs["seed"] = self.seed
        if self.proxy_dict:
            launch_kwargs["proxy"] = self.proxy_dict
        if self.pin_dict:
            launch_kwargs["pin"] = self.pin_dict
        if self.timezone:
            launch_kwargs["timezone"] = self.timezone
        if self.locale and self.locale != "auto":
            launch_kwargs["locale"] = self.locale
        if self.known_geo:
            launch_kwargs["timezone"] = self.known_geo["timezone"]
            locale = use_known_geo(self.known_geo)
            if locale and "locale" not in launch_kwargs:
                launch_kwargs["locale"] = locale
        bind_in_background()
        if self.prefs:
            launch_kwargs["extra_prefs"] = self.prefs

        try:
            if not self.headless:
                # Its own taskbar button, not one shared by every profile of this browser (worker_common).
                taskbar_identity(self.session_id, lambda: self.running, icon=self.icon)
            self.engine = InvisiblePlaywright(**launch_kwargs)
            async with self.engine as ctx:
                self.ctx = ctx

                # The engine discovered the egress IP during launch (one request it makes
                # anyway, proxy or not); the country is a local geoip read of that IP.
                exit_ip = getattr(self.engine, "_webrtc_egress_ip", None)
                if exit_ip:
                    self.geo["exitIp"] = str(exit_ip)
                    known = (self.known_geo or {}).get("country") if (self.known_geo or {}).get("ip") == exit_ip else None
                    country = known or await asyncio.to_thread(lookup_country, exit_ip)
                    if country:
                        self.geo["country"] = country

                ctx.on("close", lambda: self.on_context_closed())

                await self.apply_launch_extras(ctx)

                # Track existing and new pages
                for page in ctx.pages:
                    await self.attach_page(page)

                ctx.on("page", lambda p: asyncio.create_task(self.attach_page(p)))

                if not ctx.pages:
                    first_page = await ctx.new_page()
                    await self.attach_page(first_page)

                # Collect initial state
                initial_tabs = self.collect_tabs()
                cookie_count = await self.dump_cookies()

                emit(
                    "ready",
                    id=self.session_id,
                    seed=ctx.seed if hasattr(ctx, "seed") else self.seed,
                    tabs=initial_tabs,
                    cookieCount=cookie_count,
                    headless=self.headless,
                    **self.geo,
                )

                # Start pages load after "ready": the parent kills a worker that is not
                # ready within 30 s, and several slow pages through a proxy can exceed that.
                if self.initial_urls:
                    self.start_task = asyncio.create_task(self.open_start_urls(ctx))

                # Start background runners
                periodic_task = asyncio.create_task(self.periodic_tasks())
                cmd_task = asyncio.create_task(self.command_listener())
                watch_task = asyncio.create_task(self.watch_windows())

                # Until the panel closes it, the user closes its windows, the browser goes
                # away, or the parent does (stdin EOF): each of those ends in `stopped`.
                await self.stopped.wait()

                for task in (periodic_task, cmd_task, watch_task):
                    task.cancel()

        except Exception as e:
            log_err(f"Session launch error: {e}")
            emit("error", error=str(e))
            raise


def main():
    parser = argparse.ArgumentParser(description="InvisiblePlaywright Browser Worker")
    parser.add_argument("--id", required=True, help="Session ID")
    parser.add_argument("--profile-dir", required=True, help="Path to profile user data dir")
    parser.add_argument("--seed", type=int, default=None, help="Fingerprint random seed (int)")
    parser.add_argument("--proxy", default=None, help="Proxy JSON object string")
    parser.add_argument("--pin", default=None, help="Fingerprint pin attributes JSON string")
    parser.add_argument("--url", action="append", default=None, help="Start URL (repeatable)")
    parser.add_argument("--headless", action="store_true", help="Launch in headless mode")
    parser.add_argument("--prefs", default=None, help="JSON object of extra Firefox prefs")
    parser.add_argument("--timezone", default="", help="IANA timezone or auto")
    parser.add_argument("--locale", default="auto", help="Locale tag or auto")
    parser.add_argument("--geo", default=None, help="JSON {ip, country, timezone, lat, lon} of the proxy exit")
    parser.add_argument("--icon", default=None, help="Taskbar icon (.ico) for this thread's windows")
    parser.add_argument("--cookies-file", default=None, help="Path to write cookies JSON file")
    parser.add_argument("--init-scripts", default=None, help="JSON list of scripts injected on every page")
    parser.add_argument("--cookies-import", default=None, help="JSON cookies added once at launch")

    args = parser.parse_args()
    worker = BrowserWorker(args)

    try:
        asyncio.run(worker.run())
        os._exit(0)
    except KeyboardInterrupt:
        os._exit(0)
    except Exception as e:
        os._exit(1)


if __name__ == "__main__":
    main()
