"""
Manual-only worker for a Firefox-family build installed on the machine (Firefox, Developer
Edition, Nightly, a custom build). No automation: it starts the browser on the profile's own
folder with a user.js (proxy, leak hygiene, no telemetry), reports `ready` once it is up,
`disconnected` when it exits, and refuses every RPC op. Same JSON-lines protocol as
browser_worker.py — see ENGINE.md.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

from worker_common import WinCtl, emit, log_err, read_proxy, read_stdin, taskbar_identity

MANUAL_ONLY = ("this browser is manual-only: scripts, warm-up and broadcast need Stealth Firefox "
               "or a Chromium browser")


def user_js(proxy, geolocation: str) -> str:
    prefs = {
        # No telemetry, studies or first-run pages.
        "toolkit.telemetry.enabled": False, "toolkit.telemetry.unified": False,
        "toolkit.telemetry.archive.enabled": False, "datareporting.healthreport.uploadEnabled": False,
        "datareporting.policy.dataSubmissionEnabled": False, "app.shield.optoutstudies.enabled": False,
        "app.normandy.enabled": False, "browser.shell.checkDefaultBrowser": False,
        "browser.startup.homepage_override.mstone": "ignore", "browser.aboutwelcome.enabled": False,
        "datareporting.policy.firstRunURL": "",
        # WebRTC: only through the proxy, never a local or host address.
        "media.peerconnection.ice.proxy_only_if_behind_proxy": True, "media.peerconnection.ice.proxy_only": True,
        "media.peerconnection.ice.default_address_only": True, "media.peerconnection.ice.no_host": True,
        # DNS only through the proxy: no DNS-over-HTTPS side channel, no local lookups.
        "network.trr.mode": 5,
        # A manual engine can't spoof a position: "spoof" leaves the API on for the site to ask.
        "geo.enabled": geolocation == "spoof",
    }
    if proxy:
        prefs["network.proxy.type"] = 1
        if proxy["scheme"].startswith("socks"):
            prefs.update({"network.proxy.socks": proxy["host"], "network.proxy.socks_port": proxy["port"],
                          "network.proxy.socks_version": 4 if proxy["scheme"] == "socks4" else 5,
                          "network.proxy.socks_remote_dns": True})
        else:
            prefs.update({"network.proxy.http": proxy["host"], "network.proxy.http_port": proxy["port"],
                          "network.proxy.ssl": proxy["host"], "network.proxy.ssl_port": proxy["port"],
                          "network.proxy.share_proxy_settings": True, "network.proxy.socks_remote_dns": True})
        prefs.update({"network.proxy.no_proxies_on": "", "network.proxy.allow_hijacking_localhost": True,
                      "network.dns.disableIPv6": True, "network.proxy.failover_direct": False})
    else:
        prefs["network.proxy.type"] = 5  # the system's settings, Firefox's default
    return "".join(f"user_pref({json.dumps(k)}, {json.dumps(v)});\n" for k, v in prefs.items())


class ManualFirefox:
    def __init__(self, args):
        self.args = args
        self.profile_dir = Path(args.profile_dir).resolve()
        self.proc = None
        self.closing = False
        self.queue: asyncio.Queue[str] = asyncio.Queue()

    async def wait_up(self):
        """Up = its window exists (headful), or it is still running after a moment (headless)."""
        loop = asyncio.get_running_loop()
        end = loop.time() + 25
        win = WinCtl() if sys.platform == "win32" and not self.args.headless else None
        while loop.time() < end:
            if self.proc.poll() is not None:
                raise RuntimeError(f"Firefox exited at start (code {self.proc.returncode}) — is this profile already open?")
            if win is None and loop.time() > end - 23:
                return
            if win is not None and await asyncio.to_thread(win.find):
                return
            await asyncio.sleep(0.25)
        raise RuntimeError("Firefox did not open a window within 25 s")

    async def close(self):
        if self.closing:
            return
        self.closing = True
        if self.proc and self.proc.poll() is None:
            # WM_CLOSE first (taskkill without /F), so Firefox saves its session; then force.
            subprocess.run(["taskkill", "/T", "/PID", str(self.proc.pid)], capture_output=True)
            for _ in range(20):
                if self.proc.poll() is not None:
                    break
                await asyncio.sleep(0.1)
            if self.proc.poll() is None:
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(self.proc.pid)], capture_output=True)
        emit("closed", reason="closed by user")

    async def run(self):
        a = self.args
        loop = asyncio.get_running_loop()
        read_stdin(loop, self.queue, lambda: not self.closing)
        emit("starting", id=a.id, profileDir=str(self.profile_dir), python=sys.version.split()[0])
        try:
            if not a.browser_path or not Path(a.browser_path).exists():
                raise RuntimeError(f"browser not found at {a.browser_path}")
            self.profile_dir.mkdir(parents=True, exist_ok=True)
            proxy = read_proxy()
            (self.profile_dir / "user.js").write_text(user_js(proxy, a.geolocation), encoding="utf-8")
            # -wait-for-browser: the launcher process stays until the browser exits, so the
            # exit is seen and the window stays in this worker's process tree.
            cmd = [a.browser_path, "-no-remote", "-wait-for-browser", "-profile", str(self.profile_dir)]
            if a.headless:
                cmd.append("-headless")
            cmd += [u for u in (a.url or []) if u]
            env = {k: v for k, v in os.environ.items() if k != "SMP_PROXY"}
            if not a.headless:
                # Its own taskbar button, not one shared by every profile of this browser (worker_common).
                taskbar_identity(a.id, lambda: not self.closing)
            self.proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                         stderr=subprocess.DEVNULL, env=env)
            await self.wait_up()
            notes = {"proxyAuthPrompt": True} if proxy and proxy["username"] else {}
            emit("ready", id=a.id, seed=a.seed, tabs=[u for u in (a.url or []) if u], cookieCount=0,
                 headless=a.headless, manual=True, **notes)
        except Exception as e:
            emit("error", error=str(e))
            if self.proc and self.proc.poll() is None:
                self.proc.kill()
            raise
        waiter = asyncio.create_task(asyncio.to_thread(self.proc.wait))
        while True:
            getter = asyncio.create_task(self.queue.get())
            done, _ = await asyncio.wait({waiter, getter}, return_when=asyncio.FIRST_COMPLETED)
            if waiter in done:
                getter.cancel()
                if not self.closing:
                    emit("disconnected", reason="closed by user")
                    self.closing = True
                return
            line = getter.result()
            if line == "__EOF__":
                return await self.close()
            try:
                cmd = json.loads(line)
            except ValueError:
                continue
            if cmd.get("reqId") is not None:
                emit("reply", reqId=cmd["reqId"], ok=False, error=MANUAL_ONLY)
            elif cmd.get("cmd") == "close":
                return await self.close()


def main():
    p = argparse.ArgumentParser(description="Manual-only Firefox-family worker")
    p.add_argument("--id", required=True)
    p.add_argument("--profile-dir", required=True)
    p.add_argument("--browser-path", required=True)
    p.add_argument("--seed", type=int, default=None)
    p.add_argument("--url", action="append", default=None)
    p.add_argument("--headless", action="store_true")
    p.add_argument("--geolocation", default="block")
    args, _ = p.parse_known_args()  # cookies, scripts, prefs: nothing to do without automation
    try:
        asyncio.run(ManualFirefox(args).run())
        os._exit(0)
    except BaseException as e:
        log_err(f"{e}")
        os._exit(1)


if __name__ == "__main__":
    main()
