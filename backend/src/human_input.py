"""
Human pointer, wheel and keyboard input behind the human_* ops (ENGINE.md §1, "Human input"),
shared by browser_worker.py (Stealth Firefox) and chromium_worker.py (Chrome / Edge / ...).

A port of OutlookManagerPro's Puppeteer modules humanCursor.js + ghostScroll.js (and the WPM
personality of typingProfile.js) with the parameters they ran with: humanCursorConfig.json over
the built-ins. The planners are pure and take a random.Random, so a seed replays them exactly;
HumanCursor plays them through one tab's real input (Playwright page.mouse / keyboard, or CDP
Input.*), never through DOM-synthesised events.

  python backend/src/human_input.py      self-check of the math
"""
from __future__ import annotations

import asyncio
import contextlib
import math
import random
import re
import sys
import time
import weakref
from typing import Any, Callable, Dict, List, Optional, Tuple

Point = Tuple[float, float]

# The reference's parameters under its own names (a human_scroll payload overrides SCROLLING
# keys exactly as the reference's cfg argument did). Only what this port uses.
MOVEMENT = {"pxPerSecMin": 1400, "pxPerSecMax": 2600, "stepPxMin": 14, "stepPxMax": 32, "stepsMin": 6,
            "stepsMax": 26, "jitterPx": 1.4, "driftAmpMax": 8, "kinkChance": 0.08, "midPauseChance": 0.05,
            "midPauseMinMs": 20, "midPauseMaxMs": 55, "overshootChance": 0.28, "overshootMinPx": 4,
            "overshootMaxPx": 14, "controlPointSpreadMin": 0.2, "controlPointSpreadMax": 0.45}
CLICKS = {"delayMinMs": 40, "delayMaxMs": 150, "preClickMinMs": 20, "preClickMaxMs": 80, "clickInsetMin": 0.08,
          "clickInsetMax": 0.16, "offTargetChance": 0.1, "offTargetPx": 3, "downUpDelayMinMs": 22,
          "downUpDelayMaxMs": 65}
HOVER = {"dwellMinMs": 15, "dwellMaxMs": 80, "directClickChance": 0.42, "readHeadingChance": 0.22,
         "readHeadingDwellMinMs": 100, "readHeadingDwellMaxMs": 300, "falseHoverChance": 0.06,
         "overshootBeforeClick": True}
SCROLLING = {"notchMin": -3, "notchMax": 3, "pixelsPerNotch": 100, "pxPerSecMin": 1400, "pxPerSecMax": 2200,
             "frameMs": 8}
KEYBOARD = {"wpmMin": 22, "wpmMax": 78, "wpmSessionVariance": 12, "credentialMistakeChance": 0.45}
ADVANCED = {"mouseLiftChance": 0.04, "mouseLiftPauseMinMs": 70, "mouseLiftPauseMaxMs": 180, "fidgetChance": 0.1,
            "wanderChance": 0.2, "wanderPxPerSecMin": 1600, "wanderPxPerSecMax": 2600, "wanderHopsMin": 1,
            "wanderHopsMax": 2, "scrollBurstChance": 0.14, "scrollBurstMinMs": 80, "scrollBurstMaxMs": 360,
            "scrollBurstNotchMin": 1, "scrollBurstNotchMax": 3}


# ------------------------------------------------------------------ the reference's helpers

def jsround(v: float) -> int:
    """Math.round: halves go up (Python's round() goes to the even neighbour)."""
    return math.floor(v + 0.5)


def clamp(v, lo, hi):
    return min(hi, max(lo, v))


def rand_int(rng: random.Random, lo, hi) -> int:
    lo, hi = math.ceil(lo), math.floor(hi)
    return rng.randint(lo, max(lo, hi))


def rand_float(rng: random.Random, lo: float, hi: float) -> float:
    return lo + rng.random() * (hi - lo)


def chance(rng: random.Random, p: float) -> bool:
    return rng.random() < p


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * clamp(t, 0, 1)


def ease_in_out_cubic(t: float) -> float:
    return 4 * t ** 3 if t < 0.5 else 1 - (-2 * t + 2) ** 3 / 2


def ease_out_cubic(t: float) -> float:
    return 1 - (1 - t) ** 3


def ease_in_out_quart(t: float) -> float:
    return 8 * t ** 4 if t < 0.5 else 1 - (-2 * t + 2) ** 4 / 2


def pick_ease(rng: random.Random) -> Callable[[float], float]:
    r = rng.random()
    return ease_in_out_cubic if r < 0.45 else ease_out_cubic if r < 0.8 else ease_in_out_quart


# ------------------------------------------------------------------ planners (pure)

def paint_path(rng: random.Random, frm: Point, to: Point, m=MOVEMENT, overshoot: Optional[bool] = None,
               steps: Optional[int] = None) -> List[Point]:
    """buildPaintPath: a cubic Bezier bowed a few px off the straight line, faint jitter mid-path,
    a rare kink, and (28 % of moves over 70 px) an overshoot past the target that comes back."""
    dx, dy = to[0] - frm[0], to[1] - frm[1]
    dist = math.hypot(dx, dy) or 1
    ux, uy = dx / dist, dy / dist
    px, py = -uy, ux
    n = clamp(math.ceil(dist / rand_float(rng, m["stepPxMin"], m["stepPxMax"])), m["stepsMin"], m["stepsMax"])
    if steps:
        n = clamp(steps, 3, 40)
    spread = rand_float(rng, m["controlPointSpreadMin"], m["controlPointSpreadMax"])
    bend = rand_float(rng, -m["driftAmpMax"], m["driftAmpMax"]) * (0.35 + spread)
    c1 = (frm[0] + dx * rand_float(rng, 0.2, 0.4) + px * bend * rand_float(rng, 0.4, 1),
          frm[1] + dy * rand_float(rng, 0.2, 0.4) + py * bend * rand_float(rng, 0.4, 1))
    c2 = (frm[0] + dx * rand_float(rng, 0.55, 0.8) + px * bend * rand_float(rng, -0.6, 0.35),
          frm[1] + dy * rand_float(rng, 0.55, 0.8) + py * bend * rand_float(rng, -0.6, 0.35))
    jitter = min(m["jitterPx"], 2.5)
    pts: List[Point] = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        x = u ** 3 * frm[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t ** 3 * to[0]
        y = u ** 3 * frm[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t ** 3 * to[1]
        if 0 < i < n and jitter > 0:
            fade = math.sin(math.pi * t)  # 0 at both ends: they stay exact
            x += rand_float(rng, -jitter, jitter) * fade * 0.45
            y += rand_float(rng, -jitter, jitter) * fade * 0.45
        if 2 < i < n - 2 and chance(rng, m["kinkChance"]):
            x += px * rand_float(rng, -3, 3)
            y += py * rand_float(rng, -3, 3)
        pts.append((x, y))
    if (chance(rng, m["overshootChance"]) if overshoot is None else overshoot) and dist > 70:
        o = rand_float(rng, m["overshootMinPx"], m["overshootMaxPx"])
        pts.append((to[0] + ux * o + px * rand_float(rng, -2, 2), to[1] + uy * o + py * rand_float(rng, -2, 2)))
        pts.append(to)
    else:
        pts[-1] = to
    return pts


def move_plan(rng: random.Random, frm: Point, to: Point, m=MOVEMENT, px_per_sec: Optional[float] = None,
              duration_ms: Optional[float] = None, no_mid_pause: bool = False, overshoot: Optional[bool] = None,
              steps: Optional[int] = None) -> List[Tuple[float, float, float]]:
    """paintMove: the path's points, each with the pause after it in ms. 1400-2600 px/s (short
    hops x1.4, long moves bursting), the speed wobbling, now and then a 20-55 ms pause mid-way."""
    dist = math.hypot(to[0] - frm[0], to[1] - frm[1])
    if dist < 2:
        return [(to[0], to[1], 0.0)]
    pts = paint_path(rng, frm, to, m, overshoot, steps)
    pps = px_per_sec if px_per_sec is not None else rand_float(rng, m["pxPerSecMin"], m["pxPerSecMax"])
    if duration_ms:
        pps = dist / max(30, duration_ms) * 1000
    if dist < 80:
        pps *= 1.4
    if dist > 500:
        pps *= rand_float(rng, 1.08, 1.3)
    pps = max(pps, m["pxPerSecMin"])
    mid_at = rand_float(rng, 0.35, 0.65) if not no_mid_pause and chance(rng, m["midPauseChance"]) else None
    mul = rand_float(rng, 0.92, 1.12)
    out, last, travelled = [], frm, 0.0
    for p in pts:
        seg = math.hypot(p[0] - last[0], p[1] - last[1])
        travelled += seg
        last = p
        if chance(rng, 0.08):
            mul = rand_float(rng, 0.9, 1.15)
        wait = seg / (pps * mul) * 1000
        wait = min(20.0, wait) if wait >= 2 else 0.0
        if mid_at is not None and travelled / dist >= mid_at:
            wait += rand_int(rng, m["midPauseMinMs"], m["midPauseMaxMs"])
            mid_at = None
            mul = rand_float(rng, 1.0, 1.18)
        out.append((p[0], p[1], wait))
    return out


def flick_plan(rng: random.Random, total_px: float, s=SCROLLING, speed_factor: Optional[float] = None,
               ease: Optional[Callable[[float], float]] = None) -> Tuple[List[Tuple[float, int]], float]:
    """smoothScrollPx: ONE ease-in/out wheel gesture of `total_px` (signed) - per-frame pixel deltas
    every frameMs, trackpad-like, 1400-2200 px/s, 70-320 ms. Returns ([(at_ms, delta)], length_ms)."""
    distance = abs(total_px)
    if distance < 2:
        return [], 0.0
    sign = -1 if total_px < 0 else 1
    lo, hi = s["pxPerSecMin"], s["pxPerSecMax"]
    pps = rand_float(rng, lo, hi)
    if speed_factor and speed_factor > 1:
        pps *= min(speed_factor, 1.4)
    pps = clamp(pps, lo, 2800)
    frame = s["frameMs"]
    frames = clamp(jsround(clamp(distance / pps * 1000, 70, 320) / frame), 10, 90)
    ease = ease or pick_ease(rng)
    out, prev = [], 0
    for i in range(1, frames + 1):
        y = jsround(ease(i / frames) * distance)
        if y != prev:
            out.append(((i - 1) * frame, sign * (y - prev)))
        prev = y
    if jsround(distance) != prev:
        out.append((frames * frame, sign * (jsround(distance) - prev)))
    return out, frames * frame


def edge_start(rng: random.Random, w: float, h: float) -> Point:
    """pickEdgeStart: where a pointer nobody placed comes in - a side or the bottom, never top-left."""
    edge = rand_int(rng, 0, 2)
    if edge == 0:
        return rand_int(rng, 24, 56), rand_int(rng, math.floor(h * 0.25), math.floor(h * 0.75))
    if edge == 1:
        return rand_int(rng, max(40, w - 56), max(60, w - 20)), rand_int(rng, math.floor(h * 0.25), math.floor(h * 0.75))
    return rand_int(rng, math.floor(w * 0.25), math.floor(w * 0.75)), rand_int(rng, max(40, h - 56), max(60, h - 20))


def content_park(rng: random.Random, w: float, h: float) -> Point:
    return rand_int(rng, math.floor(w * 0.28), math.floor(w * 0.72)), rand_int(rng, math.floor(h * 0.28), math.floor(h * 0.68))


def wander_point(rng: random.Random, w: float, h: float) -> Point:
    """randomWanderPoint: a side, a corner (never top-left), the top, the bottom or mid-page; never
    the scrollbar gutter."""
    max_x = max(80, w - 36)
    kind = rand_int(rng, 0, 5)
    if kind == 0:
        return rand_int(rng, 12, 70), rand_int(rng, math.floor(h * 0.35), h - 40)
    if kind == 1:
        return rand_int(rng, max(80, max_x - 90), max_x), rand_int(rng, 40, h - 40)
    if kind == 2:
        return rand_int(rng, math.floor(w * 0.35), max_x), rand_int(rng, 12, 70)
    if kind == 3:
        return rand_int(rng, 40, max_x), rand_int(rng, h - 90, h - 16)
    if kind == 4:
        x = rand_int(rng, max(80, max_x - 90), max_x) if chance(rng, 0.55) else rand_int(rng, 16, 90)
        return x, rand_int(rng, h - 100, h - 16)
    return rand_int(rng, math.floor(w * 0.2), min(max_x, math.floor(w * 0.75))), rand_int(rng, math.floor(h * 0.25), math.floor(h * 0.85))


def neighbor_key(rng: random.Random, ch: str) -> str:
    for row in ("qwertyuiop", "asdfghjkl", "zxcvbnm"):
        i = row.find(ch.lower())
        if i < 0:
            continue
        opts = [row[j] for j in (i - 1, i + 1) if 0 <= j < len(row)]
        pick = opts[rand_int(rng, 0, len(opts) - 1)]
        return pick.upper() if ch == ch.upper() else pick
    return ch


def typing_profile(base_wpm: float, rng: random.Random, kb=KEYBOARD) -> Dict[str, Any]:
    """typingProfile.js buildSessionTyping: this session's WPM (the profile's base +- 12) and the key
    timing and mistake rates that go with it - slow typists pause more, slip more, fix more."""
    lo_w, hi_w, var = kb["wpmMin"], kb["wpmMax"], kb["wpmSessionVariance"]
    base = clamp(base_wpm or 50, lo_w, hi_w)
    wpm = rand_int(rng, clamp(base - var, lo_w, hi_w), clamp(base + var, lo_w, hi_w))
    t = (wpm - lo_w) / max(1, hi_w - lo_w)
    mean = 60000 / (wpm * 5)  # 5 characters a word
    spread = lerp(0.45, 0.22, t)
    kmin, kmax = jsround(mean * (1 - spread)), jsround(mean * (1 + spread))
    bmin = max(8, jsround(kmin * 0.35))
    bmax = max(bmin + 5, jsround(kmin * 0.7))
    return {
        "wpm": wpm,
        "typoChance": lerp(0.2, 0.028, t), "typoCorrectChance": lerp(0.72, 0.22, t),
        "typoCorrectImmediateChance": lerp(0.55, 0.88, t),
        "typoExtraWrongMin": 1 if t < 0.35 else 0, "typoExtraWrongMax": 3 if t < 0.35 else 2 if t < 0.65 else 1,
        "keyDelayMinMs": clamp(kmin, 25, 1200), "keyDelayMaxMs": max(kmin + 5, min(1500, kmax)),
        "burstChance": lerp(0.12, 0.48, t),
        "burstDelayMinMs": clamp(bmin, 8, 200), "burstDelayMaxMs": clamp(bmax, 12, 280),
        "thinkPauseChance": lerp(0.14, 0.03, t), "thinkPauseMinMs": jsround(lerp(220, 80, t)),
        "thinkPauseMaxMs": jsround(lerp(700, 220, t)),
        "wordPauseChance": lerp(0.38, 0.1, t), "wordPauseMinMs": jsround(lerp(280, 90, t)),
        "wordPauseMaxMs": jsround(lerp(700, 260, t)), "wordPauseCountMin": 1, "wordPauseCountMax": 3 if t < 0.4 else 2,
        "letterPauseChance": lerp(0.12, 0.02, t), "letterPauseMinMs": jsround(lerp(120, 40, t)),
        "letterPauseMaxMs": jsround(lerp(380, 120, t)),
    }


_KEYBOARDS: Dict[Any, Dict[str, Any]] = {}


def keyboard_for(seed: Any) -> Dict[str, Any]:
    """One typing personality per profile: its base WPM comes from its seed (the reference kept one
    per account on disk), the session's roll is made once per worker process (its session cache)."""
    if seed not in _KEYBOARDS:
        base = random.Random(f"smp-wpm:{seed}").randint(KEYBOARD["wpmMin"], KEYBOARD["wpmMax"])
        _KEYBOARDS[seed] = typing_profile(base, random.Random())
    return _KEYBOARDS[seed]


LETTER = re.compile(r"[a-z]", re.I)
DIGIT = re.compile(r"[0-9]")
CREDENTIAL_CHAR = re.compile(r"[a-z0-9@._+-]", re.I)
SLOW_AFTER = re.compile(r"[\s.,!?;:@]")


def typing_plan(rng: random.Random, text: str, k: Dict[str, Any], credential: bool = False,
                force_correct: bool = False, no_typos: bool = False) -> List[Tuple[str, Any]]:
    """type(): the keystrokes and pauses as ("char", c) | ("key", "Backspace") | ("wait", ms).
    Credential fields: 45 % of people slip, and then always fix it; elsewhere a slip is fixed at
    the WPM's correction rate, or stays as a wrong letter in place of the right one."""
    k, r = dict(k), rng
    force = force_correct or credential
    allow = not no_typos
    if credential:
        allow = chance(r, KEYBOARD["credentialMistakeChance"])
        if allow:
            k["typoChance"] = max(k["typoChance"], 0.12)
            k["typoCorrectChance"] = 1
            k["typoCorrectImmediateChance"] = min(0.92, k["typoCorrectImmediateChance"] + 0.1)
    word_pauses = rand_int(r, k["wordPauseCountMin"], k["wordPauseCountMax"]) if chance(r, k["wordPauseChance"]) else 0
    slip_ok = CREDENTIAL_CHAR if credential else LETTER
    out: List[Tuple[str, Any]] = []

    def wait(ms):
        out.append(("wait", ms))

    def key_gap():
        if chance(r, k["burstChance"]):
            return rand_int(r, k["burstDelayMinMs"], k["burstDelayMaxMs"])
        return rand_int(r, k["keyDelayMinMs"], k["keyDelayMaxMs"])

    for i, ch in enumerate(text):
        if ch == " " and word_pauses > 0 and chance(r, 0.55):
            word_pauses -= 1
            wait(rand_int(r, k["wordPauseMinMs"], k["wordPauseMaxMs"]))
        if LETTER.match(ch) and chance(r, k["letterPauseChance"]):
            wait(rand_int(r, k["letterPauseMinMs"], k["letterPauseMaxMs"]))
        if chance(r, k["thinkPauseChance"]):
            wait(rand_int(r, k["thinkPauseMinMs"], k["thinkPauseMaxMs"]))
        if allow and chance(r, k["typoChance"]) and slip_ok.match(ch):
            if LETTER.match(ch):
                wrong = neighbor_key(r, ch)
            elif DIGIT.match(ch):
                wrong = str((int(ch) + (1 if chance(r, 0.5) else 9)) % 10)
            else:
                wrong = neighbor_key(r, "a")
            out.append(("char", wrong))
            wait(rand_int(r, k["keyDelayMinMs"], k["keyDelayMaxMs"]))
            if not (force or chance(r, k["typoCorrectChance"])):
                wait(key_gap())
                continue  # the slip stays
            if chance(r, k["typoCorrectImmediateChance"]):
                out.append(("key", "Backspace"))
                wait(rand_int(r, k["keyDelayMinMs"], k["keyDelayMaxMs"]))
            else:  # typed on a little, noticed, deleted back
                lo = k["typoExtraWrongMin"]
                extra = rand_int(r, lo, max(lo, k["typoExtraWrongMax"]))
                for _ in range(extra):
                    out.append(("char", neighbor_key(r, ch if LETTER.match(ch) else "e")))
                    wait(rand_int(r, k["burstDelayMinMs"], k["burstDelayMaxMs"]))
                wait(rand_int(r, 180, 420))
                over = i > 0 and text[i - 1].isprintable() and chance(r, 0.4)
                for _ in range(1 + extra + over):
                    out.append(("key", "Backspace"))
                    wait(rand_int(r, 25, 70))
                wait(rand_int(r, 60, 160))
                if over:  # one backspace too many took the letter before: it goes back in
                    out.append(("char", text[i - 1]))
                    wait(key_gap())
        out.append(("char", ch))
        wait(key_gap() + (rand_int(r, 30, 120) if SLOW_AFTER.match(ch) else 0))
    return out


# ------------------------------------------------------------------ Windows timer

_WINMM: Any = None


@contextlib.contextmanager
def fine_timer():
    """1 ms Windows timer resolution while an op runs. Without it asyncio.sleep(0.008) comes back
    after ~27 ms (measured p50), and every 8 ms wheel frame and 2-20 ms path step 2-3x late."""
    global _WINMM
    if _WINMM is None:
        try:
            import ctypes
            _WINMM = ctypes.WinDLL("winmm") if sys.platform == "win32" else False
        except OSError:
            _WINMM = False
    if _WINMM:
        _WINMM.timeBeginPeriod(1)  # reference-counted by the OS: concurrent ops nest
    try:
        yield
    finally:
        if _WINMM:
            _WINMM.timeEndPeriod(1)


# ------------------------------------------------------------------ the page side

VIEWPORT_JS = "() => ({ w: innerWidth, h: innerHeight })"

# Geometry only: every random draw stays in Python. `hit` is the element's biggest box (an inline
# link that wraps has one per line); `scroller` its nearest scrolling ancestor (findScrollableAncestorRect);
# `heading` the card title a reader glances at before clicking (findHeadingNearElement).
GEOM_JS = r"""(el, want) => {
  const box = (r) => ({ x: r.left, y: r.top, w: r.width, h: r.height });
  const hit = [...el.getClientRects()].sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const out = { box: box(el.getBoundingClientRect()), hit: hit ? box(hit) : null, vw: innerWidth, vh: innerHeight };
  if (want && want.scroller) {
    out.scroller = null;
    for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight + 1) {
        const r = n.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) { out.scroller = box(r); break; }
      }
    }
  }
  if (want && want.heading) {
    const card = (el.closest && el.closest('[class*="card"], [class*="Card"], [class*="tile"], [class*="Tile"], [class*="item"], article, li, section, [role="listitem"]')) || el.parentElement || el;
    const at = el.getBoundingClientRect();
    let best = null, score = Infinity;
    for (const c of card.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading'],[class*='title'],[class*='Title'],[class*='heading'],[class*='Heading'],p")) {
      if (c === el || el.contains(c)) continue;
      const t = (c.innerText || c.textContent || '').trim();
      const r = c.getBoundingClientRect();
      if (t.length < 3 || t.length > 160 || r.width < 12 || r.height < 6 || r.bottom < 0 || r.top > innerHeight) continue;
      const s = (r.bottom <= at.top + 8 ? 0 : 200) + Math.abs(r.top - at.top);
      if (s < score) { score = s; best = box(r); }
    }
    out.heading = best;
  }
  return out;
}"""


class PlaywrightInput:
    """Stealth Firefox: Playwright's own page.mouse / keyboard, i.e. trusted Juggler input. The
    engine's humanizer (humanize=True) would redraw each of our waypoints as a path of its own, so
    its per-page cursor is held busy during an op (its wrappers then pass straight through) and is
    told where the pointer ended, so its own click/scroll ops start from there."""

    def __init__(self, page: Any):
        self.page, self.engine, self.was_busy = page, None, False

    def begin(self) -> Optional[Point]:
        impl = getattr(self.page, "_impl_obj", None)
        # Where the pointer really is: the engine's Juggler client notes every mouse event it
        # sends, whoever sent it - Playwright's own click on an off-screen element moves the
        # pointer without the humanizer noticing. (0, 0) until the first event.
        try:
            real = tuple(impl._connection._transport._server._objects[impl._guid].actions.position)
        except Exception:  # another engine build: the humanizer's own idea is the next best
            real = None
        try:
            from invisible_playwright import _cursor
            self.engine = _cursor._cursor_for_page(impl)
        except Exception:  # humanize off, or the engine changed shape: nothing to hold
            self.engine = None
        real = None if real == (0.0, 0.0) else real
        e = self.engine
        if e is None:
            return real
        self.was_busy, e.busy = e.busy, True
        return real or ((e.x, e.y) if e.x is not None and e.y is not None else None)

    def end(self, pos: Optional[Point]):
        e = self.engine
        if e is not None:
            e.busy = self.was_busy
            if pos:
                e.x, e.y = pos
            e.last_event_at = time.perf_counter()  # the engine's clock: no idle fidget over our moves

    async def move(self, x, y):
        await self.page.mouse.move(x, y)

    async def button(self, down, x, y, button, count):
        await (self.page.mouse.down if down else self.page.mouse.up)(button=button, click_count=count)

    async def wheel(self, x, y, dy):
        await self.page.mouse.wheel(0, dy)  # at the pointer, which is (x, y)

    async def char(self, ch):
        await self.page.keyboard.type(ch)

    async def key(self, name):
        await self.page.keyboard.press(name)

    async def js(self, fn, arg=None):
        return await self.page.evaluate(fn, arg)

    async def el(self, selector, fn, arg=None):
        h = await self.page.query_selector(selector)
        if h is None:
            return None
        try:
            return await h.evaluate(fn, arg)
        finally:
            await h.dispose()

    async def wait(self, selector, timeout, op):
        await self.page.wait_for_selector(selector, state="visible", timeout=timeout)


class CdpInput:
    """Chromium: raw CDP Input.dispatchMouseEvent / dispatchKeyEvent through chromium_worker's own
    helpers; its mouse() notes where every event left the pointer (Tab.mouse_xy)."""

    BUTTONS = {"left": 1, "right": 2, "middle": 4}

    def __init__(self, worker: Any, tab: Any):
        self.w, self.tab = worker, tab

    def begin(self) -> Optional[Point]:
        return getattr(self.tab, "mouse_xy", None)

    def end(self, pos):
        pass

    async def move(self, x, y):
        await self.w.mouse(self.tab, "mouseMoved", x, y)

    async def button(self, down, x, y, button, count):
        await self.w.mouse(self.tab, "mousePressed" if down else "mouseReleased", x, y, button=button,
                           buttons=self.BUTTONS[button] if down else 0, clickCount=count)

    async def wheel(self, x, y, dy):
        await self.w.mouse(self.tab, "mouseWheel", x, y, deltaX=0, deltaY=dy)

    async def char(self, ch):
        await self.w.type_text(self.tab, ch, 0)

    async def key(self, name):
        await self.w.key(self.tab, name)

    async def js(self, fn, arg=None):
        return await self.w.evaluate(self.tab, fn, arg, 10000)

    async def el(self, selector, fn, arg=None):
        code = "(a) => { const el = document.querySelector(a.s); return el ? (" + fn + ")(el, a.a) : null; }"
        return await self.w.evaluate(self.tab, code, {"s": selector, "a": arg}, 10000)

    async def wait(self, selector, timeout, op):
        await self.w.element(self.tab, selector, "visible", None, timeout, op)


# ------------------------------------------------------------------ one tab's cursor

class HumanCursor:
    """createHumanCursor for one tab: where its pointer is, and the reference's behaviours played
    through `io` (PlaywrightInput / CdpInput)."""

    def __init__(self, io: Any, keyboard: Dict[str, Any], rng: Optional[random.Random] = None):
        self.io, self.kb = io, keyboard
        self.rng = rng or random.Random()
        self.pos: Optional[Tuple[int, int]] = None
        self.vp: Tuple[float, float] = (1280, 720)
        self.intro = False
        self.last_click = 0.0
        self.lock = asyncio.Lock()

    # -- dispatch

    async def sleep(self, ms: float):
        if ms > 0:
            await asyncio.sleep(ms / 1000)

    async def play(self, pts: List[Tuple[float, float, float]]):
        """Walk a planned path against absolute deadlines. A point the next one has already
        overtaken is dropped, but never more than two in a row: Stealth Firefox acknowledges each
        event only once the page has it (p50 ~20 ms, p90 ~55 ms, stalls ~100 ms), and after a
        stall the path catches up in steps of at most three points instead of jumping ahead. The
        last point always goes; one where the pointer already is never does (the reference
        re-sent each move's start point)."""
        w, h = self.vp
        t0, at, last, skipped = time.perf_counter(), 0.0, len(pts) - 1, 0
        for i, (x, y, wait) in enumerate(pts):
            lag = (time.perf_counter() - t0) * 1000 - at
            at += wait
            if lag < 0:
                await asyncio.sleep(-lag / 1000)
            elif i < last and lag > wait and skipped < 2:
                skipped += 1
                continue
            skipped = 0
            p = (clamp(jsround(x), 0, w - 1), clamp(jsround(y), 0, h - 1))
            if p != self.pos:
                await self.io.move(*p)
                self.pos = p
        rest = at - (time.perf_counter() - t0) * 1000
        if rest > 0:
            await asyncio.sleep(rest / 1000)

    async def move_to(self, x: float, y: float, **opts):
        """moveTo / paintMove, from where the pointer is."""
        await self.play(move_plan(self.rng, self.pos, (x, y), **opts))

    async def flick(self, total_px: float, s=SCROLLING, speed_factor: Optional[float] = None):
        """smoothScrollPx at the pointer, carrying exactly its total. Frames a slow transport fell
        behind on go out together, as a browser coalesces them, but at most three to an event: a
        stall stretches the gesture a little rather than turning it into one big jump."""
        events, length = flick_plan(self.rng, total_px, s, speed_factor)
        t0, i = time.perf_counter(), 0
        while i < len(events):
            lag = (time.perf_counter() - t0) * 1000 - events[i][0]
            if lag < 0:
                await asyncio.sleep(-lag / 1000)
            now = (time.perf_counter() - t0) * 1000
            dy, i, n = events[i][1], i + 1, 1
            while i < len(events) and events[i][0] <= now and n < 3:
                dy, i, n = dy + events[i][1], i + 1, n + 1
            await self.io.wheel(self.pos[0], self.pos[1], dy)
        rest = length - (time.perf_counter() - t0) * 1000
        if rest > 0:
            await asyncio.sleep(rest / 1000)

    async def geom(self, selector: str, **want) -> Dict[str, Any]:
        g = await self.io.el(selector, GEOM_JS, want)
        if not g:
            raise RuntimeError(f'no element matches "{selector}"')
        return g

    # -- the reference's behaviours

    async def ensure_intro(self):
        """ensureIntro, once per tab: a pointer nobody placed enters from a side or the bottom
        (never the top-left corner) and eases 50-140 px inwards, fast."""
        if self.intro:
            return
        self.intro = True
        (w, h), r = self.vp, self.rng
        if self.pos is None:  # nobody has placed it: it comes in at an edge (a known one is never teleported)
            x, y = edge_start(r, w, h)
            if x < 60 and y < 60:
                x, y = content_park(r, w, h)
            await self.play([(x, y, 0.0)])
        x, y = self.pos
        await self.move_to(clamp(x + (rand_int(r, 50, 140) if x < w / 2 else -rand_int(r, 50, 140)), 40, w - 40),
                           clamp(y + (rand_int(r, 40, 110) if y < h / 2 else -rand_int(r, 40, 110)), 40, h - 40),
                           no_mid_pause=True, overshoot=False, px_per_sec=rand_float(r, 2200, 3400))

    async def in_content(self, rect: Optional[Dict[str, float]] = None):
        """ensureCursorInScrollContent: a wheel scrolls what is under the pointer, and a wheel over
        the scrollbar strip looks like dragging its thumb - so first into the page content, or
        into the element's own scrolling panel, off its scrollbar too."""
        (w, h), r = self.vp, self.rng
        gutter = 28
        x, y = self.pos
        if rect and rect["w"] > 40 and rect["h"] > 40:
            lo = rect["x"] + 12
            tx = clamp(x, lo, max(lo + 8, rect["x"] + rect["w"] - gutter))
            ty = clamp(y, rect["y"] + 12, rect["y"] + rect["h"] - 12)
            if tx > rect["x"] + rect["w"] * 0.82:
                tx = rect["x"] + rect["w"] * rand_float(r, 0.35, 0.65)
        else:
            max_x = max(60, w - gutter - 8)
            tx, ty = clamp(x, 40, max_x), clamp(y, 48, max(68, h - 48))
            if x > w - gutter - 4 or tx > max_x - 4:
                tx, ty = rand_float(r, w * 0.28, w * 0.62), rand_float(r, h * 0.28, h * 0.68)
        if math.hypot(tx - x, ty - y) > 10:
            await self.move_to(tx, ty, no_mid_pause=True, overshoot=False, px_per_sec=rand_float(r, 2000, 3200))

    async def scroll(self, notches: Optional[float] = None, s=SCROLLING, speed_factor: Optional[float] = None):
        """scroll(): N wheel notches (+ down) as one flick from inside the content; none: -3..3."""
        r = self.rng
        if notches is None:
            notches = rand_int(r, s["notchMin"], s["notchMax"]) or (1 if chance(r, 0.5) else -1)
        await self.in_content()
        if not notches or not math.isfinite(notches):  # ghostHumanScroll
            notches = 1 if r.random() < 0.5 else -1
        await self.flick(notches * (s["pixelsPerNotch"] or 100), s, speed_factor)

    async def scroll_to(self, selector: str, block: str = "start", s=SCROLLING, speed_factor=None):
        """scrollToSelector: one flick that brings the element to its slot (16 % / 42 % / 78 % down)."""
        await self.in_content()
        g = await self.geom(selector)
        b, vh = g["box"], g["vh"]
        anchor = b["y"] + b["h"] / 2 if block == "center" else b["y"] + b["h"] if block == "end" else b["y"]
        delta = anchor - vh * (0.42 if block == "center" else 0.78 if block == "end" else 0.16)
        if abs(delta) > 8:
            await self.in_content()
            await self.flick(delta, s, speed_factor)

    async def into_view(self, selector: str, block: str = "center", tolerance: float = 48):
        """scrollElementIntoView: flicks of at most 420 px until the element sits in its slot. Stops
        as soon as a flick no longer moves it (the reference kept trying 8 times at a page's end)."""
        g = await self.geom(selector, scroller=True)
        rect = g.get("scroller")
        await self.in_content(rect)
        prev = None
        for _ in range(8):
            b, vh = g["box"], g["vh"]
            anchor = b["y"] + b["h"] / 2 if block == "center" else b["y"] + b["h"] if block == "end" else b["y"]
            delta = anchor - vh * (0.45 if block == "center" else 0.75 if block == "end" else 0.2)
            if abs(delta) <= tolerance or (prev is not None and abs(anchor - prev) < 1):
                return
            prev = anchor
            await self.in_content(rect)
            await self.flick(clamp(delta, -420, 420))
            await self.sleep(rand_int(self.rng, 30, 80))
            g = await self.geom(selector)

    def aim(self, g: Dict[str, Any]) -> Point:
        """elementClickPoint: a random pixel across the element's biggest box, a thin inset from its
        edges, now and then a few px off - but kept inside it and inside the viewport."""
        c, r = CLICKS, self.rng
        b = g.get("hit") or g["box"]
        x0, y0 = max(b["x"], 0), max(b["y"], 0)
        x1, y1 = min(b["x"] + b["w"], g["vw"]), min(b["y"] + b["h"], g["vh"])
        if x1 - x0 < 1 or y1 - y0 < 1:
            raise RuntimeError("the element is not in view (nothing visible to point at)")
        ix, iy = rand_float(r, c["clickInsetMin"], c["clickInsetMax"]), rand_float(r, c["clickInsetMin"], c["clickInsetMax"])
        tx = x0 + (x1 - x0) * (ix + r.random() * (1 - ix * 2))
        ty = y0 + (y1 - y0) * (iy + r.random() * (1 - iy * 2))
        if chance(r, c["offTargetChance"]):
            tx += rand_float(r, -c["offTargetPx"], c["offTargetPx"])
            ty += rand_float(r, -c["offTargetPx"], c["offTargetPx"])
        return clamp(tx, x0 + 2, x1 - 2), clamp(ty, y0 + 2, y1 - 2)

    def approach(self) -> str:
        r = self.rng.random()
        return "direct" if r < HOVER["directClickChance"] else "readHeading" if r < HOVER["directClickChance"] + HOVER["readHeadingChance"] else "hover"

    async def maybe_mouse_lift(self):
        """maybeMouseLift (4 %): off to an edge of the page, a short pause, and back."""
        a, r = ADVANCED, self.rng
        if not chance(r, a["mouseLiftChance"]):
            return False
        w, h = self.vp
        if chance(r, 0.5):
            edge = (2 if chance(r, 0.5) else w - 2, rand_int(r, 10, h - 10))
        else:
            edge = (rand_int(r, 10, w - 10), 2 if chance(r, 0.5) else h - 2)
        saved = self.pos
        await self.move_to(*edge, no_mid_pause=True, overshoot=False, px_per_sec=rand_float(r, 2200, 3200))
        await self.sleep(rand_int(r, a["mouseLiftPauseMinMs"], a["mouseLiftPauseMaxMs"]))
        await self.move_to(*saved, no_mid_pause=True, overshoot=chance(r, 0.25), px_per_sec=rand_float(r, 1800, 2800))
        return True

    async def maybe_fidget(self, scroll: bool = True):
        """maybeFidget (10 %): a wander and/or a scroll burst between actions. `scroll=False` when
        the caller holds viewport coordinates a scroll would invalidate: it wanders instead."""
        r = self.rng
        if not chance(r, ADVANCED["fidgetChance"]):
            return False
        roll = r.random()
        if roll < 0.4 or (roll < 0.75 and not scroll):
            await self.wander()
        elif roll < 0.75:
            await self.scroll_burst()
        else:
            await self.wander()
            if chance(r, 0.7) and scroll:
                await self.scroll_burst()
            if chance(r, 0.35):
                await self.wander()
        return True

    async def wander(self, force: bool = True) -> bool:
        """wanderMouse: a fast dart to 1-2 spots of the page (looking around); unforced, 20 %."""
        a, r = ADVANCED, self.rng
        if not force and not chance(r, a["wanderChance"]):
            return False
        w, h = self.vp
        speed = rand_float(r, a["wanderPxPerSecMin"], a["wanderPxPerSecMax"])
        for _ in range(rand_int(r, a["wanderHopsMin"], a["wanderHopsMax"])):
            x, y = wander_point(r, w, h)
            await self.move_to(x, y, no_mid_pause=True, overshoot=chance(r, 0.3), px_per_sec=speed * rand_float(r, 0.9, 1.15))
            if chance(r, 0.4):
                await self.sleep(rand_int(r, 40, 160))
        return True

    async def scroll_burst(self, force: bool = True) -> bool:
        """scrollBurst: 80-360 ms of short flicks up and down, reversing now and then, the pointer
        drifting a little; unforced, 14 %."""
        a, r = ADVANCED, self.rng
        if not force and not chance(r, a["scrollBurstChance"]):
            return False
        budget = rand_int(r, a["scrollBurstMinMs"], a["scrollBurstMaxMs"]) / 1000
        t0, sign = time.perf_counter(), 1 if chance(r, 0.5) else -1
        await self.in_content()
        while time.perf_counter() - t0 < budget:
            await self.scroll((-sign if chance(r, 0.25) else sign) * rand_int(r, a["scrollBurstNotchMin"], a["scrollBurstNotchMax"]))
            await self.sleep(rand_int(r, 50, 180))
            if chance(r, 0.35):
                sign = -sign
            if chance(r, 0.2):
                w, h = self.vp
                await self.move_to(clamp(self.pos[0] + rand_int(r, -50, 50), 40, max(80, w - 36)),
                                   clamp(self.pos[1] + rand_int(r, -40, 40), 40, h - 40),
                                   no_mid_pause=True, overshoot=False, px_per_sec=rand_float(r, 2000, 3000))
        return True

    async def inter_click(self):
        want = rand_int(self.rng, CLICKS["delayMinMs"], CLICKS["delayMaxMs"])
        elapsed = (time.perf_counter() - self.last_click) * 1000
        if elapsed < want:
            await self.sleep(want - elapsed)

    async def click_here(self, button: str = "left", count: int = 1):
        """mouseClickHere: down, 22-65 ms, up, where the pointer is (a double click is two)."""
        x, y = self.pos
        for n in range(1, count + 1):
            if n > 1:
                await self.sleep(rand_int(self.rng, CLICKS["downUpDelayMinMs"], CLICKS["downUpDelayMaxMs"]))
            await self.io.button(True, x, y, button, n)
            await self.sleep(rand_int(self.rng, CLICKS["downUpDelayMinMs"], CLICKS["downUpDelayMaxMs"]))
            await self.io.button(False, x, y, button, n)
        self.last_click = time.perf_counter()

    async def hover(self, x: float, y: float, direct: bool = False, overshoot: bool = True, dwell: float = 0,
                    false_hover: bool = False, fidget: bool = False) -> bool:
        """hoverAt: maybe a mouse lift (and a fidget), then the approach. A direct approach barely
        stops; a false hover (6 %, coordinate clicks only) comes close, dwells, drifts away."""
        r = self.rng
        await self.maybe_mouse_lift()
        if fidget:
            await self.maybe_fidget(scroll=False)
        if false_hover and chance(r, HOVER["falseHoverChance"]):
            await self.move_to(x + rand_int(r, -40, 40), y + rand_int(r, -30, 30), overshoot=True)
            await self.sleep(rand_int(r, HOVER["dwellMinMs"], max(HOVER["dwellMaxMs"], 40)))
            await self.move_to(self.pos[0] + rand_int(r, -80, 80), self.pos[1] + rand_int(r, -60, 60))
            return False
        await self.move_to(x, y, overshoot=overshoot, no_mid_pause=direct,
                           px_per_sec=rand_float(r, 2000, 3000) if direct else None)
        if direct:
            if chance(r, 0.35):
                await self.sleep(rand_int(r, 0, 35))
        else:
            await self.sleep(dwell)
        return True

    async def click_element(self, selector: str, button: str = "left", count: int = 1):
        """clickElement: into view with the wheel, then a random pixel of it, approached directly
        (42 %), after a glance at the nearest heading (22 %) or with a short hover."""
        r = self.rng
        # hoverAt's fidget, ahead of the aim: the reference measured the target first, so its scroll
        # burst (about 1 click in 20) could slide the element from under the pointer.
        await self.maybe_fidget()
        await self.into_view(selector)
        await self.sleep(rand_int(r, CLICKS["preClickMinMs"], CLICKS["preClickMaxMs"]))
        await self.inter_click()
        style = self.approach()
        g = await self.geom(selector, heading=style == "readHeading")
        tx, ty = self.aim(g)
        if style == "readHeading":
            hd = g.get("heading")
            if hd:
                await self.move_to(hd["x"] + hd["w"] * rand_float(r, 0.25, 0.7), hd["y"] + hd["h"] * rand_float(r, 0.35, 0.65),
                                   overshoot=chance(r, 0.2))
                await self.sleep(rand_int(r, HOVER["readHeadingDwellMinMs"], HOVER["readHeadingDwellMaxMs"]))
            else:
                await self.move_to(tx + rand_int(r, -30, 30), ty - rand_int(r, 28, 70), overshoot=False)
                await self.sleep(rand_int(r, 140, 400))
        direct = style == "direct"
        await self.hover(tx, ty, direct=direct, overshoot=chance(r, 0.38) if direct else HOVER["overshootBeforeClick"],
                         dwell=rand_int(r, 40, 120) if style == "readHeading" else rand_int(r, HOVER["dwellMinMs"], HOVER["dwellMaxMs"]))
        await self.click_here(button, count)

    async def click_at(self, x: float, y: float, button: str = "left", count: int = 1):
        """clickAt: the same approaches at viewport coordinates, plus the false hover."""
        r, c = self.rng, CLICKS
        await self.inter_click()
        tx, ty = x, y
        if chance(r, c["offTargetChance"]):
            tx += rand_float(r, -c["offTargetPx"], c["offTargetPx"])
            ty += rand_float(r, -c["offTargetPx"], c["offTargetPx"])
        style = self.approach()
        if style == "readHeading":
            await self.move_to(tx + rand_int(r, -50, 50), ty + rand_int(r, -40, 20), overshoot=False)
            await self.sleep(rand_int(r, 120, 380))
        direct = style == "direct"
        if not await self.hover(tx, ty, direct=direct, overshoot=chance(r, 0.15) if direct else HOVER["overshootBeforeClick"],
                                dwell=rand_int(r, HOVER["dwellMinMs"], HOVER["dwellMaxMs"]), false_hover=True, fidget=True):
            await self.sleep(rand_int(r, 80, 220))
            await self.hover(x, y, direct=True, fidget=True)
        await self.click_here(button, count)

    async def type_text(self, text: str, credential=False, force_correct=False, no_typos=False):
        for kind, v in typing_plan(self.rng, text, self.kb, credential, force_correct, no_typos):
            if kind == "wait":
                await self.sleep(v)
            elif kind == "char":
                await self.io.char(v)
            else:
                await self.io.key(v)

    # -- the ops

    def position(self) -> Dict[str, int]:
        return {"x": self.pos[0], "y": self.pos[1]}

    async def op(self, op: str, cmd: Dict[str, Any], timeout: float):
        known = self.io.begin()
        if known:
            self.pos = (jsround(known[0]), jsround(known[1]))
        try:
            v = await self.io.js(VIEWPORT_JS) or {}
            self.vp = (v["w"], v["h"]) if v.get("w", 0) > 0 and v.get("h", 0) > 0 else (1280, 720)
            await self.ensure_intro()
            sel = cmd.get("selector")
            if op == "human_move":
                if sel:
                    await self.io.wait(sel, timeout, op)
                    await self.into_view(sel)
                    await self.move_to(*self.aim(await self.geom(sel)))
                elif cmd.get("x") is not None or cmd.get("y") is not None:
                    await self.move_to(*_xy(cmd))
                return self.position()
            if op == "human_click":
                button, count = cmd.get("button") or "left", int(cmd.get("clickCount") or 1)
                if button not in CdpInput.BUTTONS or not 1 <= count <= 3:
                    raise ValueError("button must be left, right or middle and clickCount 1-3")
                if sel:
                    await self.io.wait(sel, timeout, op)
                    await self.click_element(sel, button, count)
                elif cmd.get("x") is not None or cmd.get("y") is not None:
                    await self.click_at(*_xy(cmd), button, count)
                else:
                    raise ValueError("human_click needs a selector, or x and y")
                return self.position()
            if op == "human_type":
                if sel:  # into a field: click it first, as a person would
                    await self.io.wait(sel, timeout, op)
                    await self.click_element(sel)
                # emailField is accepted and, as in the reference, changes nothing.
                await self.type_text(str(cmd.get("text", "")), bool(cmd.get("credentialField")),
                                     bool(cmd.get("forceCorrect")), bool(cmd.get("noTypos")))
                return True
            if op == "human_scroll":
                s = {**SCROLLING, **{k: float(cmd[k]) for k in ("pixelsPerNotch", "pxPerSecMin", "pxPerSecMax", "frameMs")
                                     if cmd.get(k) is not None}}
                if s["frameMs"] < 1 or s["pxPerSecMin"] <= 0:
                    raise ValueError("frameMs must be at least 1 and pxPerSecMin above 0")
                f = cmd.get("speedFactor")
                if sel:
                    block = cmd.get("block") or "start"
                    if block not in ("start", "center", "end"):
                        raise ValueError("block must be start, center or end")
                    await self.io.wait(sel, timeout, op)
                    await self.scroll_to(sel, block, s, f)
                elif cmd.get("px") is not None:
                    await self.flick(float(cmd["px"]), s, f)
                else:
                    n = cmd.get("notches")
                    await self.scroll(None if n is None else float(n), s, f)
                return None
            if op == "human_wander":
                return await self.wander(cmd.get("force") is not False)
            if op == "human_scroll_burst":
                return await self.scroll_burst(cmd.get("force") is not False)
            raise ValueError(f"unknown op: {op}")
        finally:
            self.io.end(self.pos)


def _xy(cmd: Dict[str, Any]) -> Point:
    try:
        return float(cmd["x"]), float(cmd["y"])
    except (KeyError, TypeError, ValueError):
        raise ValueError("x and y must both be numbers (viewport px)") from None


_CURSORS: "weakref.WeakKeyDictionary[Any, HumanCursor]" = weakref.WeakKeyDictionary()


async def run(tab: Any, make_io: Callable[[], Any], op: str, cmd: Dict[str, Any], seed: Any, timeout: float):
    """One human_* op on `tab` (a Playwright page, or a chromium_worker Tab). Ops on one tab take
    turns, so two paths never interleave."""
    c = _CURSORS.get(tab)
    if c is None:
        c = _CURSORS[tab] = HumanCursor(make_io(), keyboard_for(seed))
    async with c.lock:
        with fine_timer():
            return await c.op(op, cmd, timeout)


# ------------------------------------------------------------------ self-check

def _selfcheck():
    frm, to = (100.0, 500.0), (700.0, 180.0)
    dist = math.hypot(to[0] - frm[0], to[1] - frm[1])

    def off_line(p):
        return abs((to[0] - frm[0]) * (frm[1] - p[1]) - (frm[0] - p[0]) * (to[1] - frm[1])) / dist

    bowed = overshot = 0
    for seed in range(400):
        pts = paint_path(random.Random(seed), frm, to)
        assert pts[0] == frm and pts[-1] == to, "a path starts at the pointer and ends on the target"
        assert MOVEMENT["stepsMin"] + 1 <= len(pts) <= MOVEMENT["stepsMax"] + 3, len(pts)
        # The bow comes mostly from x and y drawing their own spot along the line for each control
        # point (as the reference does): a median 13 px on this 680 px diagonal, nearly none when level.
        assert max(off_line(p) for p in pts) < 0.08 * dist, "a bow, not a scribble"
        bowed += max(off_line(p) for p in pts[:-2]) > 2
        overshot += math.hypot(pts[-2][0] - frm[0], pts[-2][1] - frm[1]) > dist + 2
    assert bowed > 360, f"diagonal paths are curved ({bowed}/400)"
    assert 0.2 < overshot / 400 < 0.36, f"overshoot at the configured 28 % ({overshot}/400)"

    for seed in range(200):
        plan = move_plan(random.Random(seed), frm, to, no_mid_pause=True)
        assert all(0 <= w <= 20 for *_, w in plan)
        speed = dist / sum(w for *_, w in plan) * 1000
        assert 1200 < speed < 5500, f"pace in the reference's human-to-fast band ({speed:.0f} px/s)"
    assert move_plan(random.Random(1), frm, (101.0, 500.5)) == [(101.0, 500.5, 0.0)], "under 2 px: one step"

    for seed in range(300):
        ev, length = flick_plan(random.Random(seed), 300)
        assert sum(d for _, d in ev) == 300 and all(d > 0 for _, d in ev), "a flick carries exactly its distance"
        assert 80 <= length <= 320 and len(ev) >= 8 and all(t % 8 == 0 for t, _ in ev), (length, len(ev))
        assert max(d for _, d in ev) < 300 * 0.3, "several wheel events, not one jump"
    ev, _ = flick_plan(random.Random(2), -200)
    assert sum(d for _, d in ev) == -200 and all(d < 0 for _, d in ev)
    for ease in (ease_in_out_cubic, ease_in_out_quart):
        d = [x for _, x in flick_plan(random.Random(3), 300, ease=ease)[0]]
        top = d.index(max(d))
        assert 0 < top < len(d) - 1, "ease-in-out: the biggest step is mid-gesture"
        assert all(a <= b + 1 for a, b in zip(d[:top], d[1:top + 1])), "speeding up..."
        assert all(a + 1 >= b for a, b in zip(d[top:], d[top + 1:])), "...then slowing down"
    d = [x for _, x in flick_plan(random.Random(3), 300, ease=ease_out_cubic)[0]]
    assert d[0] == max(d) and d[-1] <= 2, "ease-out: fastest first, trailing off"

    def typed(plan):
        buf: List[str] = []
        for kind, v in plan:
            if kind == "char":
                buf.append(v)
            elif kind == "key" and buf:
                buf.pop()
        return "".join(buf)

    slips = 0
    for seed in range(400):
        r = random.Random(seed)
        kb = typing_profile(r.randint(22, 78), r)
        plan = typing_plan(r, "hello@outlook.com", kb, credential=True)
        assert typed(plan) == "hello@outlook.com", "credential fields always end up exact"
        slips += any(kind == "key" for kind, _ in plan)
        assert typed(typing_plan(r, "Plain words, here.", kb, no_typos=True)) == "Plain words, here."
        assert len(typed(typing_plan(r, "the quick brown fox", kb))) == 19, "a kept slip replaces a letter, never drops one"
    assert 0.25 < slips / 400 < 0.6, f"45 % of credential typists slip ({slips}/400)"
    for wpm in (22, 50, 78):
        kb = typing_profile(wpm, random.Random(4))
        assert kb["keyDelayMinMs"] < 60000 / (kb["wpm"] * 5) < kb["keyDelayMaxMs"], kb
    assert 22 <= keyboard_for(4242)["wpm"] <= 78 and keyboard_for(4242) is keyboard_for(4242)

    for seed in range(300):
        r = random.Random(seed)
        x, y = wander_point(r, 1280, 720)
        assert 0 <= x <= 1280 - 36 and 0 <= y <= 720, (x, y)
        x, y = edge_start(r, 1280, 720)
        assert not (x < 60 and y < 60) and 0 <= x <= 1280 and 0 <= y <= 720
    assert move_plan(random.Random(9), frm, to) == move_plan(random.Random(9), frm, to), "a seed replays"
    assert jsround(2.5) == 3 and jsround(-2.5) == -2 and rand_int(random.Random(1), 5, 3) == 5

    class SlowIO:  # Stealth Firefox's transport: each event acked a frame later, and one long stall
        def __init__(self):
            self.moves, self.wheels, self.n = [], [], 0

        async def lag(self):
            self.n += 1
            await asyncio.sleep(0.12 if self.n == 4 else 0.016)

        async def move(self, x, y):
            self.moves.append((x, y))
            await self.lag()

        async def wheel(self, x, y, dy):
            self.wheels.append(dy)
            await self.lag()

    async def slow_transport():
        c = HumanCursor(SlowIO(), {}, random.Random(5))
        c.pos, c.vp = (100, 500), (1280, 720)
        plan = move_plan(random.Random(5), frm, to, no_mid_pause=True, overshoot=False)
        with fine_timer():
            await c.play(plan)
            seg = max(math.hypot(a[0] - b[0], a[1] - b[1]) for a, b in zip(plan, plan[1:]))
            got = c.io.moves
            step = max(math.hypot(a[0] - b[0], a[1] - b[1]) for a, b in zip(got, got[1:]))
            assert got[-1] == (700, 180) and step <= 3 * seg + 2, f"no jump after a stall ({step:.0f} px, segments {seg:.0f})"
            c.io.n = 0
            await c.flick(600)
        w = c.io.wheels
        assert sum(w) == 600 and len(w) >= 8 and max(w) < 600 * 0.3, f"a stalled flick stays a flick: {w}"

    asyncio.run(slow_transport())
    print("human_input self-check: PASS")


if __name__ == "__main__":
    _selfcheck()
