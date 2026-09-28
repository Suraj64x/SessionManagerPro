"""Per-profile taskbar buttons (worker_common.taskbar_identity) on real browser windows: two Chrome
profiles whose ids sanitise alike, Playwright's Firefox and the Stealth Firefox engine (each when
installed), in temp profiles. Each browser runs under a stand-in worker that calls the function
the way the real ones do (a python process whose child is the browser). Every window that gets
a taskbar button must read back its profile's AppUserModelID (VT_LPWSTR) and PreventPinning
(VT_BOOL true), read from this process as the taskbar reads them, keys looked up by name. Also:
a second window gets the ID too, an ID a browser puts back is replaced on the next pass, and a
thread whose keep_running() went false leaves windows alone.

It opens real windows, so it refuses to run on the visible desktop: start it on a hidden one
(CreateDesktop; child processes inherit it), e.g. with a hidden-desktop runner:
    python hidden_desktop_run.py 240 cmd /c "python backend\\test\\taskbar_check.py > out.txt 2>&1"
"""
import ctypes
import glob
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from ctypes import wintypes as wt
from pathlib import Path

import psutil

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))
from worker_common import _app_id  # noqa: E402

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
WORKER = ("import os, subprocess, sys; sys.path.insert(0, sys.argv[1]); from worker_common import taskbar_identity; "
          "taskbar_identity(sys.argv[2], lambda: not os.path.exists(sys.argv[3])); subprocess.run(sys.argv[4:])")
FOREIGN = "QA.Foreign.AppId"

user32, kernel32, shell32, ole32, propsys = (ctypes.WinDLL(n) for n in ("user32", "kernel32", "shell32", "ole32", "propsys"))
ENUMPROC = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)


class KEY(ctypes.Structure):
    _fields_ = [("fmtid", ctypes.c_ubyte * 16), ("pid", wt.DWORD)]


class PV(ctypes.Structure):  # PROPVARIANT: vt, three reserved words, a two-pointer union
    _fields_ = [("vt", ctypes.c_ushort), ("reserved", ctypes.c_ushort * 3), ("p", ctypes.c_void_p), ("p2", ctypes.c_void_p)]


for fn, res, args in [
    (user32.GetThreadDesktop, wt.HANDLE, [wt.DWORD]),
    (user32.GetUserObjectInformationW, wt.BOOL, [wt.HANDLE, ctypes.c_int, ctypes.c_void_p, wt.DWORD, ctypes.POINTER(wt.DWORD)]),
    (user32.EnumWindows, wt.BOOL, [ENUMPROC, wt.LPARAM]),
    (user32.GetWindowThreadProcessId, wt.DWORD, [wt.HWND, ctypes.POINTER(wt.DWORD)]),
    (user32.IsWindowVisible, wt.BOOL, [wt.HWND]),
    (user32.GetWindowTextLengthW, ctypes.c_int, [wt.HWND]),
    (user32.GetWindowLongW, wt.LONG, [wt.HWND, ctypes.c_int]),
    (user32.GetWindow, wt.HWND, [wt.HWND, wt.UINT]),
    (user32.GetClassNameW, ctypes.c_int, [wt.HWND, wt.LPWSTR, ctypes.c_int]),
    (kernel32.GetCurrentThreadId, wt.DWORD, []),
    (shell32.SHGetPropertyStoreForWindow, ctypes.HRESULT, [wt.HWND, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]),
    (ole32.CoInitializeEx, ctypes.HRESULT, [ctypes.c_void_p, wt.DWORD]),
    (ole32.PropVariantClear, ctypes.HRESULT, [ctypes.POINTER(PV)]),
    (propsys.PSGetPropertyKeyFromName, ctypes.HRESULT, [wt.LPCWSTR, ctypes.POINTER(KEY)]),
]:
    fn.restype, fn.argtypes = res, args
Release = ctypes.WINFUNCTYPE(wt.ULONG)(2, "Release")
GetValue = ctypes.WINFUNCTYPE(ctypes.HRESULT, ctypes.POINTER(KEY), ctypes.POINTER(PV))(5, "GetValue")
SetValue = ctypes.WINFUNCTYPE(ctypes.HRESULT, ctypes.POINTER(KEY), ctypes.POINTER(PV))(6, "SetValue")
Commit = ctypes.WINFUNCTYPE(ctypes.HRESULT)(7, "Commit")
IID_STORE = (ctypes.c_ubyte * 16)(*uuid.UUID("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99").bytes_le)
KEYS = {}

results = []


def check(name, ok, detail=""):
    results.append((bool(ok), name, detail))


def store(hwnd):
    s = ctypes.c_void_p()
    shell32.SHGetPropertyStoreForWindow(hwnd, ctypes.byref(IID_STORE), ctypes.byref(s))
    return s


def props(hwnd):
    """(ID if VT_LPWSTR, PreventPinning if VT_BOOL: VARIANT_TRUE or not); None for another type."""
    s, out = store(hwnd), []
    try:
        for name, vt in (("System.AppUserModel.ID", 31), ("System.AppUserModel.PreventPinning", 11)):
            pv = PV()
            GetValue(s, KEYS[name], pv)
            out.append(None if pv.vt != vt else ctypes.wstring_at(pv.p) if vt == 31 else (pv.p or 0) & 0xFFFF == 0xFFFF)
            ole32.PropVariantClear(pv)
    finally:
        Release(s)
    return tuple(out)


def put_foreign(hwnd):
    """What a browser resetting its window would do: its own ID back, pinning allowed."""
    s, buf = store(hwnd), ctypes.create_unicode_buffer(FOREIGN)
    try:
        SetValue(s, KEYS["System.AppUserModel.PreventPinning"], PV(vt=11))
        SetValue(s, KEYS["System.AppUserModel.ID"], PV(vt=31, p=ctypes.addressof(buf)))
        Commit(s)
    finally:
        Release(s)


def windows_of(w):
    """The worker's windows that get a taskbar button: visible, unowned or APPWINDOW, not TOOLWINDOW."""
    try:
        tree = {c.pid for c in psutil.Process(w["proc"].pid).children(recursive=True)}
    except psutil.Error:
        return []
    found = []

    @ENUMPROC
    def cb(hwnd, _):
        pid = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        ex = user32.GetWindowLongW(hwnd, -20)
        if pid.value in tree and user32.IsWindowVisible(hwnd) and not ex & 0x80 and (ex & 0x40000 or not user32.GetWindow(hwnd, 4)):
            found.append(hwnd)
        return True

    user32.EnumWindows(cb, 0)
    return found


def class_name(hwnd):
    buf = ctypes.create_unicode_buffer(64)
    user32.GetClassNameW(hwnd, buf, 64)
    return buf.value


def tagged(w, n=1):
    hs = windows_of(w)
    return len(hs) >= n and all(props(h) == (w["aumid"], True) for h in hs)


def wait(cond, seconds):
    end = time.time() + seconds
    while time.time() < end:
        try:
            if cond():
                return True
        except OSError:  # a window that went away mid-read
            pass
        time.sleep(0.2)
    return False


def stealth_firefox():
    """Where invisible_playwright keeps the engine; never downloads it."""
    try:
        from invisible_core.download import cache_dir_for_seal
        from invisible_core.seal import active_seal

        seal = active_seal()
        exe = cache_dir_for_seal(seal) / seal.asset_for(sys.platform, platform.machine()).entry_rel
        return str(exe) if exe.exists() else None
    except Exception:
        return None


def main():
    desk = ctypes.create_unicode_buffer(256)
    user32.GetUserObjectInformationW(user32.GetThreadDesktop(kernel32.GetCurrentThreadId()), 2, desk, ctypes.sizeof(desk), None)
    if desk.value.lower() in ("", "default"):
        sys.exit("taskbar_check opens real browser windows: run it on a hidden desktop, never the visible one")
    if not os.path.exists(CHROME):
        sys.exit(f"Chrome not found at {CHROME}")
    ole32.CoInitializeEx(None, 2)
    for name in ("System.AppUserModel.ID", "System.AppUserModel.PreventPinning"):
        KEYS[name] = KEY()
        propsys.PSGetPropertyKeyFromName(name, KEYS[name])

    a, b, long_id = _app_id("qa-taskbar-a@b.com"), _app_id("qa-taskbar-a_b.com"), _app_id("qa " + "x" * 300)
    check("ids that sanitise alike get different AUMIDs", a != b, f"{a} / {b}")
    shape = re.compile(r"SessionManagerPro\.Profile\.[A-Za-z0-9._-]+\.[0-9a-f]{8}")
    check("AUMIDs are [A-Za-z0-9._-] only and at most 128 chars (a 300-char id too)",
          all(shape.fullmatch(x) and len(x) <= 128 for x in (a, b, long_id)), f"{len(long_id)} chars")

    tmp = Path(tempfile.mkdtemp(prefix="smp-qa-taskbar-"))
    workers, procs = [], []
    chrome = lambda d, *more: [CHROME, f"--user-data-dir={d}", "--no-first-run", "--no-default-browser-check", *more, "about:blank"]
    try:
        plan = [("Chrome A", "qa-taskbar-a@b.com", chrome(tmp / "chrome-a")),
                ("Chrome B", "qa-taskbar-a_b.com", chrome(tmp / "chrome-b"))]
        playwright_ff = sorted(glob.glob(os.path.expandvars(r"%LOCALAPPDATA%\ms-playwright\firefox-*\firefox\firefox.exe")))
        for label, exe in (("Firefox", playwright_ff[-1] if playwright_ff else None), ("Stealth Firefox", stealth_firefox())):
            if exe:
                plan.append((label, f"qa taskbar {label.lower()}", [exe, "-no-remote", "-wait-for-browser", "-profile", str(tmp / label), "about:blank"]))
            else:
                print(f"SKIP  {label}: not installed")
        for i, (label, profile, cmd) in enumerate(plan):
            log, stop = tmp / f"worker-{i}.log", tmp / f"stop-{i}"
            with open(log, "w") as err:
                proc = subprocess.Popen([sys.executable, "-c", WORKER, str(SRC), profile, str(stop), *cmd],
                                        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=err)
            procs.append(proc)
            workers.append({"label": label, "aumid": _app_id(profile), "proc": proc, "log": log, "stop": stop})

        # One snapshot of every window, taken again until it settles: a browser may open a window
        # at any time (Firefox shows an untitled startup dialog first), and the thread only gets to
        # it on its next pass. Settled = every main (titled) window up, every window tagged.
        snap = []

        def settled():
            snap[:] = [(w, h, props(h)) for w in workers for h in windows_of(w)]
            main = {id(w) for w, h, _ in snap if user32.GetWindowTextLengthW(h)}
            return len(main) == len(workers) and all(p == (w["aumid"], True) for w, _, p in snap)

        t0 = time.time()
        wait(settled, 60)
        took = time.time() - t0
        for w in workers:
            check(f"{w['label']}: its main (titled) window has a taskbar button",
                  any(sw is w and user32.GetWindowTextLengthW(h) for sw, h, _ in snap))
        for w, h, p in snap:
            check(f"{w['label']} {h:#x} {class_name(h)}: its profile's AUMID (VT_LPWSTR) and PreventPinning (VT_BOOL true)",
                  p == (w["aumid"], True), repr(p))
        check(f"{len(workers)} profiles, {len(workers)} different AUMIDs on their windows",
              len({p[0] for _, _, p in snap}) == len(workers), f"all tagged {took:.1f} s after launch")

        A, B = workers[0], workers[1]
        second = subprocess.Popen(chrome(tmp / "chrome-a", "--new-window"), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        procs.append(second)
        t0 = time.time()
        check("Chrome A: a second window of the running profile gets the same AUMID", wait(lambda: tagged(A, 2), 15),
              f"{len(windows_of(A))} windows, {time.time() - t0:.1f} s")

        h = windows_of(A)[0]
        put_foreign(h)
        t0 = time.time()
        check("an ID a browser puts back (pinning allowed again) is replaced on the next pass",
              wait(lambda: props(h) == (A["aumid"], True), 3), f"{time.time() - t0:.1f} s")

        # Also what makes the check above mean something: the foreign write does reach the window.
        B["stop"].touch()
        time.sleep(1.5)
        hb = windows_of(B)[0]
        put_foreign(hb)
        time.sleep(2.5)
        check("keep_running() false: the thread stops, the foreign ID written from here stays",
              props(hb) == (FOREIGN, False), repr(props(hb)))

        for w in workers:
            text = w["log"].read_text(encoding="utf-8", errors="replace")
            check(f"{w['label']}: the identity thread logged nothing", "taskbar identity" not in text, text[-300:])
    except Exception as e:
        check("UNCAUGHT", False, repr(e))
    finally:
        for p in procs:
            if p.poll() is None:  # only our own live ones: never a pid that may since belong to another process
                subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True)
                try:
                    p.wait(10)
                except subprocess.TimeoutExpired:
                    pass
        # A Chrome child created (suspended) just as its parent was killed escapes taskkill /T,
        # orphaned; its command line still names the temp profile.
        strays = lambda: [p for p in psutil.process_iter(["cmdline"]) if str(tmp) in " ".join(p.info["cmdline"] or [])]
        for p in strays():
            try:
                p.kill()
            except psutil.Error:
                pass
        for _ in range(20):  # the killed browsers let go of their profile files
            shutil.rmtree(tmp, ignore_errors=True)
            if not tmp.exists():
                break
            time.sleep(0.5)
        check("browsers killed (no process left on the temp profiles), temp profiles removed",
              not tmp.exists() and not strays() and all(p.poll() is not None for p in procs), str(tmp))
        for ok, name, detail in results:
            print(f"{'PASS' if ok else 'FAIL'}  {name}{f'  ({detail})' if detail else ''}")
        print(f"\n{sum(ok for ok, _, _ in results)}/{len(results)} passed")
        sys.exit(0 if all(ok for ok, _, _ in results) else 1)


if __name__ == "__main__":
    main()
