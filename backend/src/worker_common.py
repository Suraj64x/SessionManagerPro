"""
Helpers shared by the browser workers (browser_worker.py, chromium_worker.py,
firefox_manual.py): the JSON-lines stdout protocol, stderr logging, the stdin reader, the
proxy from SMP_PROXY, the Win32 window control and the per-profile taskbar button. See ENGINE.md.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import threading
import time
import uuid
from typing import Any, Dict, Optional

# Force UTF-8 and unbuffered standard streams
if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", line_buffering=True)
    sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8")

# The protocol stream, kept even if a worker later points sys.stdout elsewhere to keep
# third-party prints off it.
PROTO = sys.stdout


def emit(event_type: str, **kwargs):
    """Emit JSON event to stdout for Node.js parent process."""
    payload = {"event": event_type, **kwargs}
    try:
        PROTO.write(json.dumps(payload, default=str) + "\n")
        PROTO.flush()
    except Exception:
        pass


def log_err(msg: str):
    """Log error message to stderr."""
    try:
        sys.stderr.write(f"[worker] {msg}\n")
        sys.stderr.flush()
    except Exception:
        pass


def read_stdin(loop, queue, keep_running=lambda: True):
    """Daemon thread feeding stdin lines into an asyncio queue; "__EOF__" when the parent goes."""
    def run():
        while keep_running():
            try:
                line = sys.stdin.readline()
            except Exception:
                break
            if not line:  # EOF -> parent closed pipe
                loop.call_soon_threadsafe(queue.put_nowait, "__EOF__")
                break
            line = line.strip()
            if line:
                loop.call_soon_threadsafe(queue.put_nowait, line)

    threading.Thread(target=run, daemon=True).start()


def read_proxy() -> Optional[Dict[str, Any]]:
    """{scheme, host, port, username, password} from SMP_PROXY (never the command line), or None."""
    raw = os.environ.get("SMP_PROXY")
    if not raw:
        return None
    try:
        p = json.loads(raw)
        if not (p and p.get("host") and p.get("port")):
            return None
        scheme = str(p.get("scheme") or "http").lower()
        if not scheme.startswith(("http", "socks")):
            scheme = "http"
        return {"scheme": scheme, "host": str(p["host"]), "port": int(p["port"]),
                "username": str(p.get("username") or ""), "password": str(p.get("password") or "")}
    except Exception as e:
        log_err(f"Failed to parse proxy: {e}")
        return None


class WinCtl:
    """Windows-only control of the browser's top-level window that belongs to THIS worker.
    The browser pid is not always known (the Firefox engine hides it), so the window is found
    through the worker's own process tree (python -> [driver ->] browser)."""

    SW_MINIMIZE, SW_RESTORE = 6, 9
    SWP_NOZORDER, SWP_NOACTIVATE = 0x0004, 0x0010
    MONITOR_DEFAULTTONEAREST = 2

    def __init__(self):
        import ctypes
        from ctypes import wintypes

        self.ctypes, self.wt = ctypes, wintypes
        u = self.user32 = ctypes.windll.user32
        self.kernel32 = ctypes.windll.kernel32
        HWND, DWORD, INT = wintypes.HWND, wintypes.DWORD, ctypes.c_int

        class MONITORINFO(ctypes.Structure):
            _fields_ = [("cbSize", DWORD), ("rcMonitor", wintypes.RECT), ("rcWork", wintypes.RECT), ("dwFlags", DWORD)]

        self.MONITORINFO = MONITORINFO
        # Explicit argtypes: without them ctypes narrows 64-bit handles to c_int.
        for name, argtypes in {
            "GetWindowThreadProcessId": [HWND, ctypes.POINTER(DWORD)],
            "IsWindowVisible": [HWND], "GetWindowTextLengthW": [HWND], "IsIconic": [HWND],
            "GetWindowRect": [HWND, ctypes.POINTER(wintypes.RECT)],
            "ShowWindow": [HWND, INT], "SetForegroundWindow": [HWND], "BringWindowToTop": [HWND],
            "SetWindowPos": [HWND, HWND, INT, INT, INT, INT, wintypes.UINT],
            "MonitorFromWindow": [HWND, DWORD], "GetMonitorInfoW": [wintypes.HMONITOR, ctypes.POINTER(MONITORINFO)],
            "AttachThreadInput": [DWORD, DWORD, wintypes.BOOL],
        }.items():
            getattr(u, name).argtypes = argtypes
        u.GetForegroundWindow.restype = HWND
        u.MonitorFromWindow.restype = wintypes.HMONITOR
        # Physical pixels: a DPI-unaware process gets virtualised coordinates on scaled screens.
        try:
            u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))  # PER_MONITOR_AWARE_V2
        except Exception:
            pass

    def find(self) -> Optional[int]:
        """The main window: visible, titled, top-level, owned by a child process; largest wins."""
        import psutil

        pids = {c.pid for c in psutil.Process().children(recursive=True)}
        u, ctypes, wt = self.user32, self.ctypes, self.wt
        found = []

        @ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
        def cb(hwnd, _):
            pid = wt.DWORD()
            u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value in pids and u.IsWindowVisible(hwnd) and u.GetWindowTextLengthW(hwnd) > 0:
                r = self.rect(hwnd)
                found.append((r["width"] * r["height"], hwnd))
            return True

        u.EnumWindows(cb, 0)
        return max(found)[1] if found else None

    def rect(self, hwnd) -> Dict[str, int]:
        r = self.wt.RECT()
        self.user32.GetWindowRect(hwnd, self.ctypes.byref(r))
        return {"x": r.left, "y": r.top, "width": r.right - r.left, "height": r.bottom - r.top}

    def bounds(self, hwnd) -> Dict[str, Any]:
        mi = self.MONITORINFO()
        mi.cbSize = self.ctypes.sizeof(mi)
        self.user32.GetMonitorInfoW(self.user32.MonitorFromWindow(hwnd, self.MONITOR_DEFAULTTONEAREST), self.ctypes.byref(mi))
        w = mi.rcWork
        return {**self.rect(hwnd), "monitor": {"x": w.left, "y": w.top, "width": w.right - w.left, "height": w.bottom - w.top}}

    def focus(self, hwnd) -> bool:
        u = self.user32
        if u.IsIconic(hwnd):
            u.ShowWindow(hwnd, self.SW_RESTORE)
        # Windows refuses SetForegroundWindow from a background process. Attaching to the
        # foreground thread's input queue lifts that; a null key event is the fallback.
        # (Not the ALT-press trick: a lone ALT toggles Firefox's menu bar.)
        cur, fg = self.kernel32.GetCurrentThreadId(), u.GetForegroundWindow()
        fg_thread = u.GetWindowThreadProcessId(fg, None) if fg else 0
        attached = bool(fg_thread and fg_thread != cur and u.AttachThreadInput(cur, fg_thread, True))
        try:
            u.BringWindowToTop(hwnd)
            u.SetForegroundWindow(hwnd)
        finally:
            if attached:
                u.AttachThreadInput(cur, fg_thread, False)
        if u.GetForegroundWindow() != hwnd:
            u.keybd_event(0, 0, 0, 0)
            u.SetForegroundWindow(hwnd)
        return u.GetForegroundWindow() == hwnd

    def run(self, action: str, rect: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        hwnd = self.find()
        if hwnd is None:
            raise RuntimeError("no browser window found")
        u = self.user32
        out: Dict[str, Any] = {"ok": True, "hwnd": hwnd}
        if action == "focus":
            out["focused"] = self.focus(hwnd)
        elif action == "minimize":
            u.ShowWindow(hwnd, self.SW_MINIMIZE)
        elif action == "restore":
            u.ShowWindow(hwnd, self.SW_RESTORE)
        elif action == "move":
            if not rect:
                raise ValueError("move needs rect {x, y, width, height}")
            if u.IsIconic(hwnd):
                u.ShowWindow(hwnd, self.SW_RESTORE)
            r = {k: int(rect[k]) for k in ("x", "y", "width", "height")}
            u.SetWindowPos(hwnd, None, r["x"], r["y"], r["width"], r["height"], self.SWP_NOZORDER | self.SWP_NOACTIVATE)
        elif action != "bounds":
            raise ValueError(f"unknown window action: {action}")
        out["minimized"] = bool(u.IsIconic(hwnd))
        out["bounds"] = self.bounds(hwnd)
        return out


def kill_with_worker(pid: int):
    """Put `pid` in a job that closes with this process, so a force-killed worker never
    leaves the browser running on (and locking) the profile. Windows only; best effort."""
    if sys.platform != "win32":
        return
    import ctypes
    from ctypes import wintypes

    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.CreateJobObjectW.restype = wintypes.HANDLE
    k.OpenProcess.restype = wintypes.HANDLE
    k.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    k.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    k.CloseHandle.argtypes = [wintypes.HANDLE]

    class BASIC(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

    class EXTENDED(ctypes.Structure):
        _fields_ = [("Basic", BASIC), ("Io", ctypes.c_uint64 * 6), ("ProcessMemoryLimit", ctypes.c_size_t),
                    ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t),
                    ("PeakJobMemoryUsed", ctypes.c_size_t)]

    job = k.CreateJobObjectW(None, None)
    info = EXTENDED()
    # KILL_ON_JOB_CLOSE | BREAKAWAY_OK (the browser puts its own sandboxed children in jobs).
    info.Basic.LimitFlags = 0x2000 | 0x0800
    ok = k.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info))
    proc = k.OpenProcess(0x0100 | 0x0001, False, pid)  # SET_QUOTA | TERMINATE
    if not (ok and proc and k.AssignProcessToJobObject(job, proc)):
        log_err(f"could not tie the browser to the worker (error {ctypes.get_last_error()})")
    if proc:
        k.CloseHandle(proc)
    # The job handle stays open for the life of this process on purpose: closing it kills the browser.
    kill_with_worker.jobs = [*getattr(kill_with_worker, "jobs", []), job]


def _app_id(profile_id: str) -> str:
    """The profile's AppUserModelID: at most 128 chars, no spaces. The hash of the raw id keeps
    ids that sanitise alike ("a@b.com", "a_b.com") apart."""
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", profile_id)[:90]
    return f"SessionManagerPro.Profile.{safe}.{hashlib.sha1(profile_id.encode()).hexdigest()[:8]}"


def taskbar_identity(profile_id: str, keep_running=lambda: True, icon: Optional[str] = None) -> None:
    """A taskbar button of its own for this profile. Windows groups windows by AppUserModelID,
    so all profiles of one browser share a button; a daemon thread gives this worker's browser
    windows (its process tree, as WinCtl finds them) a per-profile ID instead, and blocks pinning:
    a pinned button would start the bare browser, outside the app. It looks again about once a
    second, as windows come and go and a browser may put its own ID back. With `icon` (an .ico
    that may not exist yet: it is drawn in the background) the windows also wear that icon, which
    the taskbar button shows. Windows only; best effort: a failure is logged once, never raised."""
    if sys.platform != "win32":
        return

    def run():
        warned = False
        try:
            import ctypes
            from ctypes import wintypes as wt

            import psutil

            GUID = ctypes.c_ubyte * 16

            class KEY(ctypes.Structure):
                _fields_ = [("fmtid", GUID), ("pid", wt.DWORD)]

            class VALUE(ctypes.Union):  # as wide as the real union, so GetValue never writes past it
                _fields_ = [("pwszVal", wt.LPWSTR), ("boolVal", ctypes.c_short), ("blob", ctypes.c_void_p * 2)]

            class PROPVARIANT(ctypes.Structure):
                _anonymous_ = ("v",)
                _fields_ = [("vt", ctypes.c_ushort), ("reserved", ctypes.c_ushort * 3), ("v", VALUE)]

            VT_BOOL, VT_LPWSTR = 11, 31
            GWL_EXSTYLE, GW_OWNER, WS_EX_TOOLWINDOW, WS_EX_APPWINDOW = -20, 4, 0x80, 0x40000
            fmtid = GUID(*uuid.UUID("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3").bytes_le)  # System.AppUserModel.*
            iid_store = GUID(*uuid.UUID("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99").bytes_le)  # IPropertyStore
            # PreventPinning first: once a window's ID is set, the taskbar ignores changes to it.
            wanted = [(KEY(fmtid, 9), VT_BOOL, True), (KEY(fmtid, 5), VT_LPWSTR, _app_id(profile_id))]

            ENUMPROC = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
            # Private DLL objects: these prototypes and WinCtl's (on windll.user32) never meet.
            user32, shell32, ole32 = ctypes.WinDLL("user32"), ctypes.WinDLL("shell32"), ctypes.WinDLL("ole32")
            for fn, restype, argtypes in [
                (user32.EnumWindows, wt.BOOL, [ENUMPROC, wt.LPARAM]),
                (user32.GetWindowThreadProcessId, wt.DWORD, [wt.HWND, ctypes.POINTER(wt.DWORD)]),
                (user32.IsWindowVisible, wt.BOOL, [wt.HWND]),
                (user32.IsWindow, wt.BOOL, [wt.HWND]),
                (user32.GetWindowLongW, wt.LONG, [wt.HWND, ctypes.c_int]),
                (user32.GetWindow, wt.HWND, [wt.HWND, wt.UINT]),
                (shell32.SHGetPropertyStoreForWindow, ctypes.HRESULT,
                 [wt.HWND, ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p)]),
                (ole32.CoInitializeEx, ctypes.HRESULT, [ctypes.c_void_p, wt.DWORD]),
                (ole32.CoUninitialize, None, []),
                (ole32.PropVariantClear, ctypes.HRESULT, [ctypes.POINTER(PROPVARIANT)]),
                (user32.LoadImageW, wt.HANDLE, [wt.HINSTANCE, wt.LPCWSTR, wt.UINT, ctypes.c_int, ctypes.c_int, wt.UINT]),
                (user32.SendMessageTimeoutW, wt.LPARAM,
                 [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM, wt.UINT, wt.UINT, ctypes.POINTER(ctypes.c_size_t)]),
            ]:
                fn.restype, fn.argtypes = restype, argtypes
            # IPropertyStore methods by vtable slot; an HRESULT restype raises OSError on failure.
            Release = ctypes.WINFUNCTYPE(wt.ULONG)(2, "Release")
            GetValue = ctypes.WINFUNCTYPE(ctypes.HRESULT, ctypes.POINTER(KEY), ctypes.POINTER(PROPVARIANT))(5, "GetValue")
            SetValue = ctypes.WINFUNCTYPE(ctypes.HRESULT, ctypes.POINTER(KEY), ctypes.POINTER(PROPVARIANT))(6, "SetValue")
            Commit = ctypes.WINFUNCTYPE(ctypes.HRESULT)(7, "Commit")

            def windows():
                """The ones with a taskbar button: visible, unowned or WS_EX_APPWINDOW, no WS_EX_TOOLWINDOW."""
                pids = {c.pid for c in psutil.Process().children(recursive=True)}
                found = []

                @ENUMPROC
                def cb(hwnd, _):
                    pid = wt.DWORD()
                    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                    if pid.value in pids and user32.IsWindowVisible(hwnd):
                        ex = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
                        if not ex & WS_EX_TOOLWINDOW and (ex & WS_EX_APPWINDOW or not user32.GetWindow(hwnd, GW_OWNER)):
                            found.append(hwnd)
                    return True

                user32.EnumWindows(cb, 0)
                return found

            def tag(hwnd):
                store = ctypes.c_void_p()
                shell32.SHGetPropertyStoreForWindow(hwnd, iid_store, ctypes.byref(store))
                try:
                    changed = False
                    for key, vt, want in wanted:
                        pv = PROPVARIANT()
                        GetValue(store, key, pv)
                        have = pv.pwszVal if pv.vt == VT_LPWSTR else pv.boolVal != 0 if pv.vt == VT_BOOL else None
                        ole32.PropVariantClear(pv)
                        # Only on a difference: every write makes the taskbar re-read the window.
                        if have != want:
                            pv = PROPVARIANT(vt=vt)
                            if vt == VT_BOOL:
                                pv.boolVal = -1  # VARIANT_TRUE
                            else:
                                pv.pwszVal = want  # ours, not CoTaskMem: SetValue copies it, never PropVariantClear it
                            SetValue(store, key, pv)
                            changed = True
                    if changed:
                        Commit(store)
                finally:
                    Release(store)

            def load_icons(path):
                """(big, small) HICONs at this system's sizes (SM_CXICON, SM_CXSMICON)."""
                try:
                    dpi = user32.GetDpiForSystem()
                    sizes = [user32.GetSystemMetricsForDpi(11, dpi), user32.GetSystemMetricsForDpi(49, dpi)]
                except Exception:
                    sizes = [32, 16]
                return [user32.LoadImageW(None, path, 1, s, s, 0x10) for s in sizes]  # IMAGE_ICON, LR_LOADFROMFILE

            def wear(hwnd, icons):
                """WM_SETICON (big, then small), only when the window has another one."""
                for which, h in zip((1, 0), icons):  # ICON_BIG, ICON_SMALL
                    if not h:
                        continue
                    cur = ctypes.c_size_t()
                    user32.SendMessageTimeoutW(hwnd, 0x7F, which, 0, 0x2, 500, ctypes.byref(cur))  # WM_GETICON, SMTO_ABORTIFHUNG
                    if cur.value != h:
                        user32.SendMessageTimeoutW(hwnd, 0x80, which, h, 0x2, 500, ctypes.byref(cur))  # WM_SETICON

            icons = None
            ole32.CoInitializeEx(None, 2)  # COINIT_APARTMENTTHREADED
            while keep_running():
                if icon and icons is None and os.path.exists(icon):
                    icons = load_icons(icon)
                for hwnd in windows():
                    try:
                        tag(hwnd)
                        if icons:
                            wear(hwnd, icons)
                    except Exception as e:
                        # The next pass retries. A window that closed mid-pass fails with a bare E_FAIL: no news.
                        if not warned and user32.IsWindow(hwnd):
                            warned = True
                            log_err(f"taskbar identity: {e!r}")
                time.sleep(1)
            ole32.CoUninitialize()
        except Exception as e:
            log_err(f"taskbar identity off: {e!r}")

    threading.Thread(target=run, name="taskbar-identity", daemon=True).start()
