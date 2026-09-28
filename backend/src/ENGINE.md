# Engine contract

How a profile's browser is driven. Three layers, one process per live profile:

```
orchestrator.js   pool: queue, thread cap, events, record counters
   └─ manager.openSession(id, opts)        writes the auto-run bundle, passes opts through
        └─ worker_runner.launchWorker(record, opts)   picks the worker by record.browser (§7),
             │                                         spawns python, JSON lines over stdio
             ├─ browser_worker.py          Stealth Firefox (invisible_playwright), the default
             ├─ chromium_worker.py         an installed Chrome / Edge / Brave / Chromium build (raw CDP via nodriver)
             └─ firefox_manual.py          an installed Firefox-family build, manual only (no ops)
```

All three speak the same protocol (§1, §5). Shared helpers (the stdout protocol, the stdin
reader, `SMP_PROXY`, `WinCtl`, the browser-dies-with-worker job object) live in `worker_common.py`.

Everything a feature needs is on the orchestrator (`require("./orchestrator")`) and on the
per-session `handle` it holds in `orchestrator.live.get(id).handle`. Verified end to end by
`backend/test/rpc_check.js` (`node backend/test/rpc_check.js`, ~90 s, opens one real window
for a few seconds).

## 1. `handle.rpc(op, payload = {}, timeoutMs = 35000)`

One Playwright action in the worker, returned as a Promise of a JSON value. Rejects with a
readable `Error` (the first line of the worker's message, ≤ 500 chars) when the op fails,
with `"<op> timed out after Ns"` when the worker does not answer in `timeoutMs`, and at once
with `"browser is not running"` once the worker is gone. Ops run concurrently in the worker:
a slow `eval` does not block an `info`.

Common payload fields:

| field | meaning |
| --- | --- |
| `pageId` | pin the op to one tab (ids come from `info`, `new_tab`, `tabs`). Omitted: the *active* tab, i.e. the last one that navigated or was created. Rejects with `"the tab this script was driving has been closed"` if that tab is gone. |
| `timeout` | ms for the Playwright call (default 30000). `0` = wait forever, bounded only by `timeoutMs`. |

A profile that has just launched may still be opening its start pages; every op waits for
that to finish, capped at 30 s. Give your `timeoutMs` that allowance (scripts.js uses
`START_ALLOWANCE_MS = 35_000`).

| op | payload | returns |
| --- | --- | --- |
| `info` | – | `{ url, title, pageId, headless, exitIp?, country? }` — `exitIp`/`country` only when the engine resolved them (see §3). |
| `tabs` | – | `[{ pageId, url, title, active }]` for every open page; exactly one is `active`. |
| `new_tab` | `{ url? }` | `{ url, pageId }`. Not affected by `pageId`. The new tab becomes active. |
| `close_other_tabs` | – | number of tabs closed; every page except the target is closed and the target becomes active. |
| `goto` | `{ url, waitUntil? }` | the page URL after navigation. `waitUntil` defaults to `domcontentloaded`. |
| `reload` | `{ waitUntil? }` | the page URL. |
| `eval` | `{ code, arg?, userGesture? }` | whatever the expression returns. Chromium runs it as a user gesture only with `userGesture: true` (page user activation with no input behind it is detectable). `code` is a JS expression **or a function source** (`"async () => {...}"`, `fn.toString()`) — Playwright calls a function with `arg`. Page exceptions reject. A navigation mid-call is retried once after `domcontentloaded`. |
| `click` | `{ selector }` | `null` |
| `fill` | `{ selector, value }` | `null` |
| `type` | `{ selector, text, delay? }` | `null` — per-key typing into `selector` (`delay` ms between keys, default 70). |
| `keyboard_type` | `{ text, delay? }` | `true` — types into whatever has focus, no selector (default `delay` 80). |
| `press` | `{ key, selector? }` | `null` — `key` like `"Enter"`, `"Control+a"`. |
| `wait_for` | `{ selector, state? }` | `null` — `state` ∈ `visible` (default) \| `attached` \| `hidden` \| `detached`. |
| `scroll` | `{ dy? }` | `null` — mouse wheel by `dy` px (default 600). |
| `screenshot` | `{ path, fullPage? }` | the path written (parent dirs are created). |
| `cookies` | – | the context's cookie jar (Playwright cookie objects). |
| `add_cookies` | `{ cookies }` | the jar size after the add; also persists `data/cookies/<id>.json`. |
| `close_tab` | `{ pageId }` (required) | `true`. Closes that tab. Refuses without a `pageId` (it never guesses) and when it is the last open tab (a profile never ends up with zero tabs; closing the last one closes the profile). |
| `window` | `{ action, rect? }` | see below. |
| `human_move` | `{ x, y }` \| `{ selector }` \| `{}` | `{ x, y }`, the pointer's position. A human path to the viewport point, or to a random pixel of the element after wheeling it into view; `{}` only places the pointer (below) and says where it is. |
| `human_click` | `{ selector }` \| `{ x, y }`, `button?`, `clickCount?` | `{ x, y }` where it clicked. Selector: wheeled into view, then approached and pressed like a person; `x, y`: viewport px. `button` ∈ `left` (default) \| `right` \| `middle`, `clickCount` 1–3. |
| `human_type` | `{ text, selector?, credentialField?, emailField?, noTypos?, forceCorrect? }` | `true`. At the profile's typing speed, with its pauses and slips. With `selector`, clicks the field first. **Only `credentialField`, `noTypos` or `forceCorrect` guarantee the exact text**: elsewhere a slip may stay, as a fast typist's would. `emailField` is accepted and, as in the reference, changes nothing. |
| `human_scroll` | `{ notches? }` \| `{ px }` \| `{ selector, block? }`, plus `pixelsPerNotch?`, `pxPerSecMin?`, `pxPerSecMax?`, `frameMs?`, `speedFactor?` | `null`. One eased wheel flick: `notches` × 100 px (+ down; none given: a random −3…3), exactly `px`, or until the element sits at `block` ∈ `start` (default, 16 % down) \| `center` \| `end`. |
| `human_wander` | `{ force? }` | `true` when it moved: a fast dart to 1–2 spots of the page. `force: false` does it only 20 % of the time. |
| `human_scroll_burst` | `{ force? }` | `true` when it scrolled: 80–360 ms of short flicks up and down. `force: false`: 14 % of the time. |

Results must be JSON-serialisable: `NaN`/`Infinity`/circular values reject immediately.

Every op above works the same on Stealth Firefox and on Chromium browsers (§7). On Chromium,
selectors are CSS (`document.querySelector`, main frame): Playwright's `text=`/`xpath=`
engines exist only on Stealth Firefox; `click`/`type`/`press`/`scroll` are trusted CDP input
events. A manual-only Firefox build rejects every op with
`"this browser is manual-only: scripts, warm-up and broadcast need Stealth Firefox or a Chromium browser"`.

### `window` — the Firefox window of this profile (Windows only)

`action` ∈ `focus` \| `minimize` \| `restore` \| `move` \| `bounds`. Every action returns

```
{ ok: true, hwnd, minimized, bounds: { x, y, width, height, monitor: { x, y, width, height } } }
```

`bounds` is the window rectangle in **physical pixels** (`GetWindowRect`, so it includes the
invisible DWM resize border — about 7 px each side on Windows 10/11; `move` uses the same
frame, so a `move` followed by `bounds` round-trips). `monitor` is the work area (taskbar
excluded) of the monitor the window is on. When minimized, `bounds.x/y` are the OS's
off-screen values (−32000).

- `focus`: restores if minimized, then brings the window to the foreground (via
  `AttachThreadInput`, with a null-key fallback; never the ALT trick, which toggles
  Firefox's menu bar). Adds `focused: boolean` — Windows can still refuse when another
  app holds the foreground lock.
- `minimize` / `restore`: `ShowWindow(SW_MINIMIZE / SW_RESTORE)`.
- `move`: `rect = { x, y, width, height }` (physical px), restores first if minimized.
  Firefox enforces a minimum size; read `bounds` back rather than assuming.

The window is found through the worker's own process tree (psutil children of the python
process → the Firefox pids → `EnumWindows` filtered by pid, visible, titled; the largest
wins). Rejects with `"no browser window found"` when there is none, and always for a
**headless** worker (its window exists but is cloaked; see §2).

### Human input — the `human_*` ops (human_input.py)

One module for both engines, a port of OutlookManagerPro's Puppeteer `humanCursor.js` +
`ghostScroll.js` (+ `typingProfile.js`) with the values they ran with (`humanCursorConfig.json`
over the built-ins). Every event is real input: Playwright's `page.mouse` / `keyboard` on
Stealth Firefox, CDP `Input.dispatchMouseEvent` / `dispatchKeyEvent` on Chromium; nothing is
synthesised in the DOM. Verified by `python backend/src/human_input.py` (the math) and
`backend/test/human_check.js` (both engines, headless, ~2 min).

- **Paths**: a cubic Bezier from where the pointer is, bowed off the straight line (median
  ~2 % of a diagonal move, almost none when level), faint mid-path jitter, a rare kink, and on
  28 % of moves over 70 px an overshoot of 4–14 px that comes back. 14–32 px steps (6–26 of
  them) at 1400–2600 px/s (hops under 80 px ×1.4, over 500 px ×1.08–1.3), the speed wobbling,
  5 % with a 20–55 ms pause mid-way.
- **Wheel**: one continuous ease-in/out flick per gesture, trackpad-like: pixel deltas every
  8 ms, 1400–2200 px/s, 70–320 ms, carrying exactly the distance. The pointer is first moved
  into the page content (or into the element's own scrolling panel), never over a scrollbar.
  Scrolling to an element uses flicks of at most 420 px.
- **Clicks**: a random pixel of the element's largest box (8–16 % inset, 10 % of the time up
  to 3 px off but never outside it), approached directly (42 %), after a glance at the nearest
  heading (22 %) or with a short hover; 40–150 ms since the last click; down 22–65 ms. Now and
  then a wander, a scroll burst or a lift of the mouse to the page's edge comes first.
- **Typing**: the profile's base WPM (22–78, from its seed) ± 12 per worker session sets key
  delays, bursts, word / letter / think pauses and slips (slow typists slip and fix more; fast
  ones leave more). `credentialField`: 45 % slip, always fixed.
- **One pointer per tab.** The first `human_*` op on a tab brings the pointer in from a side
  or the bottom edge (never the top-left corner) and eases it inwards; every path starts
  where the pointer is. On Chromium every mouse event the worker sends, plain `click`/`scroll`
  included, records the position. On Stealth Firefox the position is the engine's Juggler
  client's own record of its last mouse event, whoever sent it (Playwright's click on an
  off-screen element moves the pointer without the humanizer knowing); the engine's own
  humanizer (`humanize=True`, which already paths `click`, `mouse.move` and `wheel`) is held
  for the length of a `human_*` op, so it does not redraw each waypoint as a path of its own,
  and is handed the final position, so its own `click`/`scroll` ops carry on from there. Both
  read private engine attributes, guarded: if the engine changes, paths start from the last
  position this module knows. `human_*` ops on one tab run one at a time.
- **Timing**: 1 ms Windows timer resolution while an op runs (otherwise an 8 ms sleep takes
  ~27 ms); points run on absolute deadlines. Stealth Firefox acknowledges each input event only
  once the page has it (measured: moves p50 ~20 ms, p90 ~55 ms, stalls ~100 ms; Chromium keeps
  pace with the plan), so there a path delivers ~40–60 points/s and a flick ~30–40 events/s. Falling
  behind, a path drops the points already overtaken, never more than two in a row, and a
  flick sends overdue frames together, at most three to an event: a stall stretches a gesture
  a little instead of making it jump, and a flick always carries exactly its distance.
- **Versus the reference**: kept its parameters and algorithms. Changed: no zero-length
  mousemove at the start of each path, points clamped into the viewport, the pre-click fidget
  runs before the target is measured (it could scroll the target away), scrolling into view
  stops when the page stops moving, a typo fix whose extra backspace ate the previous letter
  retypes it (the reference lost it), clicks aim at the largest client rect (a wrapped link's
  bounding box can miss it). Left out: app-specific parts (Rewards membership card, alert
  dismissal), the visible virtual mouse, and quirks with side effects in automation (random
  double / right / blank-space clicks, tab switches, text selection with Escape).
- Selectors: CSS on Chromium, Playwright selectors on Stealth Firefox; main frame only. The
  target is not checked for being covered: a human click lands on whatever is on top.

Script API (scripts.js, automation mode), names as in humanCursor.js: `cursor.ensureIntro()`,
`cursor.moveTo(x, y | selector)`, `cursor.click(selector, { button, clickCount })` (alias
`clickElement`), `cursor.clickAt(x, y)`, `cursor.type(text, { selector, credentialField,
emailField, noTypos, forceCorrect })`, `cursor.scroll(notches, cfg?)`, `cursor.scrollPx(px)`,
`cursor.scrollTo(selector, { block })` (alias `scrollToSelector`), `cursor.wander(force)` (alias
`wanderMouse`) and `cursor.scrollBurst(force)` (both: `force` false by default, as in the
reference), plus `createHumanCursor(page, opts)` (returns `cursor`), `ghostHumanScroll(page,
ghost, notches, opts, cfg)` and `smoothScrollPx(page, ghost, px, opts, cfg)`. They are globals,
so a script can declare its own `const cursor = createHumanCursor(page)`. The built-in Warm-up
reads with these: flicks of 1–5 notches (1 in 6 up), the odd scroll burst and wander, and it
follows a link by clicking it (falling back to `goto` when the click does not navigate).

### Fire-and-forget

`handle.close()` resolves as soon as the worker reports the profile closed (`closed`, sent once
its cookies are saved: well under a second), not when the browser has quit. Firefox needs about
2 s more; `handle.exited` resolves then, and a worker still running 15 s after `close` is
killed. `handle.newPage(url)` sends a plain command without a reply. `orchestrator.stop(id)`
is the right way to close a profile; it marks the close as the operator's.

The user closing the browser is reported the same way (`closed`, reason `closed by user`).
Stealth Firefox needs help for that: Juggler keeps Firefox running with no window and reports
no tab close, so the worker watches its own windows (headful only) and shuts down once none
has been left for 2 s. Measured 2026-09-27 on a hidden desktop: stopped about 1.7 s after the
window closed (Chromium: 0.4 s).

### Handle fields and events

`handle.id`, `handle.process` (the ChildProcess), `handle.tabs` (last known URLs),
`handle.cookieCount`, `handle.seed`, `handle.headless`, `handle.exitIp`, `handle.country`,
`handle.startedAt` (ISO, set by the orchestrator), `handle.launchNotes` (startup events:
`init_scripts`, `cookies_imported`, `cookies_import_failed`), `handle.cdpPort` (Chromium only:
the browser's DevTools port on 127.0.0.1, §7).
Events: `tabs(urls[])`, `cookies(count)`, `disconnected(reason)`, `error(err)`, `ready(msg)`
(`ready` has already fired by the time `launchWorker` resolves — read the fields instead).

## 2. Launch options

`launchWorker(record, opts)` / `manager.openSession(id, opts)` / `orchestrator.launch(ids, opts)`
all take the same per-launch options:

| option | effect |
| --- | --- |
| `url` | one start URL for this launch. Precedence: `opts.url` → `record.startUrls[]` → `record.tabs[]` (last session's tabs) → whatever Firefox opens. At most 10 start URLs; they load **after** `ready`, so ops wait for them (§1). |
| `headless` | hide the window. On Windows the engine keeps a real, cloaked Firefox window (coherent fingerprint); only `INVPW_TRUE_HEADLESS=1` in the server's environment gives true headless. `window` ops refuse either way. |
| `prefs` | object of extra Firefox prefs, applied on top of the engine's fingerprint prefs (`InvisiblePlaywright(extra_prefs=…)`; worker flag `--prefs=<json>`). Yours win on conflict — do not touch fingerprint/proxy/timezone prefs. Note `permissions.default.image=2` does not block `data:` images; `dom.webnotifications.enabled=false` is the test's proof that prefs land. |
| `initScriptsFile` | path to a JSON array of scripts injected on every page (`manager.openSession` fills this from scripts.js; features do not pass it). |

From the record: `id`, `userDataDir`, `seed` (else derived from the id), `proxy` (through the
local tunnel below, never on the command line), `fingerprint` (pinned
screen/hardware/GPU attributes; on Chromium the coherent subset of §7), `startUrls`, `tabs`,
`browser` (§7; absent = `stealth-firefox`), `geolocation` (`block` default | `spoof`; Chromium
and manual Firefox only, Stealth Firefox keeps its own handling), `webrtc` (`proxy-only` default |
`masked` default | `off`, Stealth Firefox only: see the tunnel section). Timezone and locale are **not** passed:
the engine derives both from the exit IP. Cookies are dumped to `data/cookies/<id>.json`
every 6 s and on shutdown; a staged `data/cookies/<id>.import.json` is added once at launch.

`launchWorker` resolves on the worker's `ready` (Stealth Firefox typically 8–15 s: the engine
discovers the egress IP, resolves geo, then launches Firefox; Chromium 1.5–5 s) and rejects
with the engine's own message on a launch error, `"Worker process exited prematurely with code
N"`, after 30 s `"Timeout waiting for <invisible_playwright worker | Chromium worker | Firefox>
to be ready"`, or, before spawning anything, `"<Name> is not installed any more — pick another
browser for this profile"` when the record's browser is gone.

### Proxy tunnel (tunnel.js)

Every launch with a proxy, on every engine, starts a per-profile tunnel on `127.0.0.1:<port>`
first; the worker gets `SMP_PROXY = {scheme: "http", host: "127.0.0.1", port, username: "",
password: ""}` and the tunnel closes when the worker process exits. The tunnel logs in to the
real proxy (http, https, socks4, socks5), so the password stays in the server process: the
worker and the browser never hold it.

- Why it is not optional: Stealth Firefox 151 (engine firefox-29, invisible_playwright 0.14)
  accepted an authenticated HTTP proxy and sent page traffic out on the machine's own IP, while
  `exitIp` (found by Python through the proxy) showed the proxy's. Measured 2026-09-27: page
  `api.ipify.org` = the host's IP directly, the proxy's IP through the tunnel.
- Kill switch: the tunnel only ever dials the upstream. When the upstream is down or refuses
  the login, the browser gets a 502 (a 407 becomes a 502 too, never a login prompt).
- DNS: names travel to the upstream (CONNECT by name, SOCKS5 ATYP 3, SOCKS4a); nothing is
  resolved on this machine except the proxy's own host name.
- Plain `http://` goes to an http/https upstream in absolute form with `Proxy-Authorization`,
  the way a browser sends it, because many providers refuse CONNECT to port 80 (the user's
  do). Over SOCKS it is tunnelled to host:80.
- UDP is not tunnelled. Chromium runs `disable_non_proxied_udp` and manual Firefox
  `ice.proxy_only`: no WebRTC outside the proxy, no candidates. Stealth Firefox (the engine's own
  prefs win over a caller's `prefs`), per the profile's `webrtc`:
  - `masked` (default): `media.peerconnection.use_document_iceservers=false` and
    `default_iceservers` = a dead local STUN (`127.0.0.1:3479`). The page's STUN/TURN servers are
    never contacted, and the engine's srflx fallback shows the page the exit IP, plus mDNS host
    candidates: a normal browser behind NAT. Measured 2026-09-27 with a UDP listener on the LAN
    address as the page's STUN server: the engine's own setting sent it 6 requests from the
    host (a site's own STUN server sees the real IP, the same for every profile); `masked` 0.
    Not covered: ICE connectivity checks to a remote peer a page describes itself.
  - `off`: `media.peerconnection.ice.proxy_only_if_behind_proxy=true`, nothing outside the proxy
    and no candidates. iphey's test never finishes with no candidates (fingerprint.com is fine).
- Stealth Firefox also always gets `invisible_firefox.usage_ping.enabled=false`: the engine
  otherwise fetches a GitHub release asset at every start (its launch counter).
- `handle.tunnel.stats()` → `{ active, total, bytesUp, bytesDown, lastError }`.
- `testProxy` (server.js) and the fingerprint geo lookup use `tunnel.fetchVia`, so a proxy test
  and the exit geo work for all four schemes, through the proxy itself.

### Python discovery and environment (worker_runner.js)

`findPythonExe()` (exported) returns the first that exists, else `null`:

1. `process.env.SMP_PYTHON`
2. `<ROOT>/runtime/python/python.exe` — the bundled runtime an installer ships
3. `<ROOT>/.venv/Scripts/python.exe` — developer checkout

No system Python, no `py.exe`: their site-packages would not hold the pinned engine. With
`null`, `launchWorker` rejects with
`Python runtime missing — expected <ROOT>\runtime\python\python.exe (reinstall SessionManagerPro)`.

The worker is spawned as `python -E -s browser_worker.py …` (or `chromium_worker.py` / `firefox_manual.py`, §7) (ignore `PYTHON*` variables and
the user site) with `workerEnv()` (exported): a copy of `process.env` minus `PYTHONHOME` and
`PYTHONPATH`, plus `PYTHONNOUSERSITE=1`, `INVISIBLE_CORE_AUTOFIX=off` (the engine must never
pip-install into site-packages at launch), and `INVISIBLE_PLAYWRIGHT_CACHE_DIR=<ROOT>/runtime/engine`
when that folder exists and the variable is unset (the shipped Firefox build; otherwise the
engine's per-user cache).

## 3. Exit IP and country

Behind a proxy the exit's geo is looked up ONCE per launch, by worker_runner.js `exitGeo`,
through the proxy itself: `https://ipinfo.io/json`, falling back to ip-api.com. It goes to the
worker as `--geo={ip, country, timezone, lat, lon}`. ipinfo matched Fingerprint Pro on every
exit tested (2026-09-27); Stealth Firefox's bundled database put Virginia ISP exits in
America/Chicago, which Fingerprint reports as "VPN (timezone mismatch)", and ip-api disagreed
on one of them too. With `--geo`:

- Stealth Firefox skips its own egress discovery and database (`prepare_session_geo` is
  replaced by one that returns the known geo; ~2 s) and gets the timezone and the exit
  country's locale explicitly (~0.4 s). Its process-tree binding (a job object, ~2.7 s of
  scanning) runs in a background thread instead of in front of the launch. Measured on a
  hidden desktop: ready in ~5.3 s instead of ~9 s.
- Chromium uses it instead of its own ip-api request.

Without `--geo` (no proxy, or both lookups failed) each engine resolves the geo itself, as before.

`ready`, `info`, `session:launched`, `getStatus().live[]` and the record counters carry
`exitIp` and `country` **only when known**, and they cost no extra network request:

- `exitIp` is `InvisiblePlaywright._webrtc_egress_ip`, the egress address the engine
  discovers during launch anyway (through the proxy when there is one, the host's public IP
  otherwise, because timezone stays on `auto`). Absent when that discovery failed on a
  proxy-less profile (behind a proxy the engine refuses to launch instead).
- `country` is the ISO 3166 code from the engine's already-cached geoip database for that
  IP (`invisible_core._geoip_db._cached_geoip_mmdb()`, a local file read; the public
  `ensure_geoip_mmdb()` is avoided because it does an HTTP HEAD on every call). Absent when
  the cache is cold or the IP is not in it.

Both read private engine attributes, guarded: if the engine changes, the fields silently
disappear rather than breaking a launch.

## 4. Orchestrator

`const orchestrator = require("./orchestrator")` — a singleton `EventEmitter`.

### State

- `live: Map<id, { id, handle, startedAt, url, headless, exitIp, country }>`
- `queue: string[]`, `starting: Set<id>` (dequeued, not yet live), `threadLimit` (default 5),
  `defaultUrl`
- `log(level, category, message, sessionId?)` → entry; `getLogs(limit)`.

### `launch(ids, { threads?, url?, headless?, prefs? }) → Promise<boolean>`

Queues the ids that are not live or already queued (returns `false` when none were).
`threads` raises/lowers the cap. `url !== undefined` sets `defaultUrl` (trimmed; `""` means
"no launch-wide URL, use the profile's own"). Each queued id captures `{ url: defaultUrl,
headless, prefs }` **at queue time**, so a later `launch()` cannot change how earlier queued
profiles open. The pool fills up to `threadLimit`, 800 ms apart, and refills as sessions
close.

### `launchAndWait(ids, opts = {}, { timeoutMs = 120_000 } = {}) → Promise<Record<id, { ok, error? }>>`

Same queueing as `launch`, resolved when every id is live or has failed:

- already live → `{ ok: true }` at once;
- launched → `{ ok: true }` on `session:launched`;
- failed → `{ ok: false, error }` with the launch error (engine message, missing profile, …);
- dropped from the queue by `stop(id)`/`stopAll()` before it started →
  `{ ok: false, error: "removed from queue" }`;
- still pending at `timeoutMs` → `{ ok: false, error: "timed out" }` — **the launch is not
  cancelled**, it carries on and `session:launched` still fires.

### `stop(id) → Promise<boolean>`

Closes a live profile (marks it closed by the operator) or removes it from the queue.
`false` when it was neither — including a profile that is mid-launch, which cannot be
closed yet; `assertNotStarting(id)` throws a readable error for that case if you want to
refuse the request up front. The profile leaves `live` at once; a relaunch of it waits for
the old browser to quit (`exiting`, at most 20 s), since the profile folder is locked until
then. `stopAll()` closes every profile in parallel.

### `stopAll() → Promise<true>`

Clears the queue and closes every live profile.

### `getStatus()`

```
{
  live: [{ id, startedAt, url, headless, exitIp, country, proxy, fingerprintFile, browser }],
  queued: [id], threadLimit, defaultUrl, activeCount, queuedCount, isFilling
}
```
`url` is the start URL or `"restore tabs"`. `headless` is a boolean; `exitIp`/`country` may
be `undefined` (§3).

### Events

| event | payload | when |
| --- | --- | --- |
| `log` | `{ id, timestamp, level, category, message, sessionId }` | every `log()` call |
| `pool:update` | `getStatus()` | queue or pool changed |
| `session:update` | `{ id, status, reason }` | `status` ∈ `running` (launch started) \| `success` \| `error`; also saved as `record.lastResult = { status, reason, at }`. Emitted even for a record that no longer exists. |
| `session:launched` | `{ id, startedAt, headless, exitIp?, country? }` | right after the profile is in `live` |
| `session:closed` | `{ id, status, reason, startedAt, endedAt, durationMs, closedByUser }` | when the worker disconnects, after `session:update`; `closedByUser` is true when the operator stopped it or closed the last window (`reason === "closed by user"`); `status` is `error` when the worker reported an error or exited non-zero. |

`session:update` for `error` and `session:closed` fire before the pool refills.

### Record counters (manager.saveSessionPatch, on the session record)

| field | set |
| --- | --- |
| `launchCount` | +1 on `session:launched` |
| `lastExitIp`, `lastCountry` | on `session:launched`, only when known |
| `workSeconds` | += `round(durationMs / 1000)` on `session:closed` |
| `lastResult` | `{ status, reason, at }` on every `session:update` |
| `lastOpenedAt`, `tabs`, `cookieCount` | by `manager.openSession` / the handle's events |

## 5. Worker events (JSON lines on stdout, for reference)

`starting {id, profileDir, python}` → `ready {id, seed, tabs, cookieCount, headless, exitIp?, country?}`
(the Chromium worker adds `cdpPort`; the manual Firefox wrapper adds `manual: true`; `proxyAuthPrompt: true` only when run on a proxy with a password directly, which launches through the tunnel never do)
→ `tabs {tabs, currentUrl?}` / `cookies {count}` / `init_scripts {count}` /
`cookies_imported {count, total}` / `cookies_import_failed {error}` / `reply {reqId, ok, result | error}`
/ `disconnected {reason}` / `closed {reason}` / `error {error}`. stderr lines are logged as
`[worker:<id>] …`.

## 6. Limitations

- `window` is Windows-only and refuses on headless workers; `focus` can be refused by the
  OS (`focused: false`). Window bounds include the invisible DWM border.
- `exitIp`/`country` depend on private engine attributes and the cached geoip db (§3).
- `launch()` does not check `starting`: launching an id that is mid-launch queues it again
  and, once the first is live, the duplicate is dropped at dequeue — but if the first is
  still starting when the duplicate is dequeued, a second worker is spawned on a locked
  profile and fails. Wait for `session:launched` (or use `launchAndWait`) before relaunching.
- `launchAndWait` cannot tell a launch that will never report (a worker killed externally
  before `ready` does report, via the process exit) from a slow one; that is what the
  timeout is for.
- The engine refuses to launch a proxied profile whose egress IP cannot be discovered, and
  raises mid-session if the proxy's exit IP drifts (a new tab then fails); both surface as
  the engine's own error text.
- Chromium and manual-Firefox limitations are in §7.

## 7. Browser choice (browsers.js, features/browsers.js)

Verified by `backend/test/chromium_check.js` (headless Chrome, a fingerprint, local fake HTTP
and SOCKS5 proxies, the orchestrator, an engines-folder build, the manual Firefox wrapper;
~2 min) and `backend/test/browsers_api_check.js` (the API, qa- profiles only).

A profile record's `browser` names the browser it runs on; records without it are Stealth
Firefox. `POST /api/sessions/create` and `PATCH /api/sessions/:id` accept `browser` (an
installed id from `GET /api/browsers`, else 400) and `geolocation` (`block` | `spoof`, else
400). Changing `browser` while the profile is live, starting or queued is a 409 (`"stop this
profile before changing its browser"`); setting the value it already has is a no-op.
`publicRecord` always carries `browser` and `geolocation` (defaults filled in) and never the
proxy password. `getStatus().live[].browser` is the running profile's id. A clone keeps both.

### Ids and where they come from

| id | name | kind | found at |
| --- | --- | --- | --- |
| `stealth-firefox` | Stealth Firefox | `stealth` | built in (`installed` = the runtime Python + engine package; version from the engine seal) |
| `chrome`, `chrome-beta`, `chrome-dev`, `chrome-canary`, `chromium`, `edge`, `brave` | Google Chrome, Chrome Beta, … | `chromium` | `Program Files`, `Program Files (x86)` and `%LOCALAPPDATA%` + the usual folder, or any path the registry's `App Paths` / `Clients\StartMenuInternet` keys (HKLM + HKCU) give, matched by its tail (`…\Google\Chrome SxS\Application\chrome.exe` → `chrome-canary`) |
| `firefox`, `firefox-dev`, `firefox-nightly` | Firefox, Firefox Developer Edition, Firefox Nightly | `firefox-manual` | same |
| `pw-chromium-<build>`, `pw-firefox-<build>` | Playwright Chromium / Playwright Firefox `<version>` | `chromium` / `firefox-manual` | `%PLAYWRIGHT_BROWSERS_PATH%` or `%LOCALAPPDATA%\ms-playwright` (`chromium-<n>\chrome-win64\chrome.exe` or `chrome-win\…`, `firefox-<n>\firefox\firefox.exe`; `chromium_headless_shell` is not a full browser and is skipped) |
| `<slug>`, e.g. `grizz` | the folder name, e.g. `GrizzEngine` | by its DLLs | `%LOCALAPPDATA%\SessionManagerPro\engines\<Name>\<version>\`: `chrome.dll` → chromium, `xul.dll` → firefox; the exe is the first of `chrome.exe`, `chromium.exe`, `worker.exe`, `msedge.exe`, `brave.exe`, `firefox.exe`; the highest version wins and all are listed in `versions`; the id is the lower-cased name without a trailing "engine" |
| `custom-<slug>` | as given | by exe name, else DLLs | `data/browsers.json`, added by the user |

**What the panel offers.** `list()` returns only the engines this app drives well: the stealth
engine, builds in the engines folder, Firefox builds (manual only) and the user's own custom
builds. An installed Chrome, Edge or Brave and Playwright's Chromium are detected but left out:
on those, every profile shares the machine's canvas, GPU and fonts, so they are one device to a
detector however the proxy changes. `everyBrowser()` returns the unfiltered list, and `find()`
and `validId()` use it, so a profile that already names one of them keeps launching, and anyone
who wants one back adds it as a custom build (`POST /api/browsers/custom`).

Versions come from the exe's PE version resource (no process spawn). Detection is cached 60 s;
custom builds are read fresh. `worker_runner.js` `ENGINES` maps kind → `{ script, label,
args(record, browser) }`: a new engine kind (e.g. `camoufox`) is one entry there plus its kind in
browsers.js.

### API

`GET /api/browsers` →

```
{ default: "stealth-firefox",
  browsers: [{ id, name, family: "chromium" | "firefox", kind: "stealth" | "chromium" | "firefox-manual",
               path, version, automation, installed, fingerprintBrowsers: ["Chrome", …],
               note?, builtin?, custom?, engineFolder?, versions? }] }
```

`fingerprintBrowsers` says which fingerprint dumps (`fingerprint.js` `browserName`) the engine
applies, for the panel's fingerprint picker: Stealth Firefox `["Chrome", "Firefox"]` (it pins
only screen, cores and GPU, which are browser-neutral), Chromium `["Chrome"]`, manual Firefox
`[]`. `note` is text for the panel. `limited: true` marks an engine that runs but has a known
problem the note explains (a Bablosoft BAS build, see Limitations).

`POST /api/browsers/custom { path, name? }` → the new entry. 400 when the path is not absolute,
not an `.exe`, not a file, not recognisably a browser, or has no version resource. The family
comes from the exe name (`chrome|chromium|msedge|brave|thorium|vivaldi|opera|yandex|…` →
chromium, `firefox|camoufox|librewolf|waterfox|floorp|zen|mullvadbrowser|…` → firefox), else from
`xul.dll` / `chrome.dll` / `msedge.dll` beside it or in a version folder. 409 when that exe is
already listed. Stored as `[{ id: "custom-<slug>", name, family, path }]`, written atomically
under a cross-process lock (`fsutil.js`).

`DELETE /api/browsers/custom/:id` → `{ ok: true }`; 404 unknown; 409 `"used by N profiles — move
them to another browser first"` while any profile, live or trashed, uses it.

### Capabilities per kind

| | Stealth Firefox | Chromium (`chromium_worker.py`) | Firefox family (`firefox_manual.py`) |
| --- | --- | --- | --- |
| RPC ops (§1): scripts, warm-up, broadcast, auto-run | yes | yes (CSS selectors) | no, every op is refused |
| `window` op | yes | yes (same `WinCtl`) | refused |
| CDP endpoint for Playwright / Puppeteer (`POST /api/sessions/:id/cdp`) | no (409: use `/op`) | yes, the browser's own `wsEndpoint` | no (409) |
| profile storage | the engine's profile dir | the browser's own `--user-data-dir`: logins persist natively | `-profile <dir>` |
| cookie dump / import / export | yes | yes (`Storage.getCookies`, Playwright shape) | no |
| fingerprint (.fpt) | pins screen, cores, GPU | the coherent Chrome subset below | none |
| timezone / language | from the exit IP (engine) | from the exit IP (below) | the machine's |
| geolocation | the engine's own | `block` (denied) or `spoof` (exit-IP coordinates) | `geo.enabled=false` unless `spoof` (cannot spoof: the site may ask) |
| proxy with a password | yes, through the tunnel | yes, through the tunnel (SOCKS5 included) | yes, through the tunnel (no prompt) |

### Chromium worker

- nodriver starts the browser (a free debugging port on 127.0.0.1) and holds the websocket; the
  worker replaces its typed event parsing with raw JSON (`process_event`) and sends raw CDP, so
  a protocol newer than nodriver's snapshot never drops an event. nodriver's
  `--remote-allow-origins=*` (any web page could drive the port) and its site-isolation opt-out
  are removed; nothing adds `--enable-automation`; `navigator.webdriver` is false.
- External clients: `ready` carries that port as `cdpPort` (`handle.cdpPort`), and
  `POST /api/sessions/:id/cdp` (features/apidocs.js) returns `{ wsEndpoint }`, the browser's
  `webSocketDebuggerUrl` from `/json/version`, for Playwright's `chromium.connectOverCDP` or
  Puppeteer's `connect`. 404 unknown profile; 409 when it is not running, or runs Stealth Firefox
  (its engine lives in the worker: use `/op`) or a manual Firefox; 502 when the port does not
  answer. Such a client shares the browser with the worker: its tabs get the worker's overrides
  too, and tabs open from either side (checked with puppeteer-core, headless, 2026-09-27).
  Playwright's `browser.close()` on it only disconnects; Puppeteer's quits the browser (use
  `disconnect()`). Covered by `backend/test/apidocs_check.js`.
- Every tab is auto-attached **paused** (`Target.setAutoAttach` with `waitForDebuggerOnStart`),
  gets its overrides, auto-run scripts and proxy auth, then runs: popups included. Cross-site
  iframes (their own processes) are auto-attached from each tab the same way.
- Flags: `--no-first-run --no-default-browser-check --disable-quic
  --force-webrtc-ip-handling-policy=disable_non_proxied_udp
  --webrtc-ip-handling-policy=disable_non_proxied_udp --disable-features=Translate,Prerender2`
  and `about:blank` as the first page (the new-tab page would fetch remote content before the
  worker attaches). Behind a proxy: `--proxy-server=http://127.0.0.1:<tunnel port>` and
  `--host-resolver-rules="MAP * ~NOTFOUND , EXCLUDE 127.0.0.1 , EXCLUDE localhost"`, so no
  name is ever resolved locally, IPv4 or IPv6 (the tunnel hands every name to the upstream).
  `Default/Preferences` gets `webrtc.ip_handling_policy=disable_non_proxied_udp` (with
  `multiple_routes_enabled` and `nonproxied_udp_enabled` false) and `intl.accept_languages`.
- Launched by the panel the proxy is always the tunnel, which has no password, so `Fetch` is
  never enabled. Run directly with a password in `SMP_PROXY`, an HTTP proxy's challenge is
  answered through `Fetch.enable {handleAuthRequests}` / `Fetch.continueWithAuth` (`source:
  "Proxy"` only) and a SOCKS proxy with a password is refused (Chrome cannot log in to one).
- Geo: before launch, one request through the proxy to `http://ip-api.com/json` (as
  `testProxy` does; an absolute-form HTTP GET through an HTTP proxy) gives the exit IP, country,
  timezone and coordinates; the locale comes from the engine's own country table
  (`invisible_core._geo._COUNTRY_LOCALE`). A proxy that does not answer refuses the launch, as
  Stealth Firefox does. Applied per tab and frame: `Emulation.setTimezoneOverride` and
  `setLocaleOverride`, plus `--lang` and `intl.accept_languages`, so `navigator.languages`,
  `Intl` and `Accept-Language` agree (workers included). With `geolocation: "spoof"`,
  `setGeolocationOverride` and the permission granted; otherwise the geolocation permission is
  **denied** for every origin. `ready`/`info` carry `exitIp` and `country`. Without a proxy:
  the machine's own timezone and language, and no lookup.
- Headless is `--headless=new`, with `HeadlessChrome/` in the UA replaced by `Chrome/` (real
  client hints kept) and a 1920×1040 window and 1920×1080 screen (or the fingerprint's) instead
  of 800×600.
- Shutdown: cookie dump, `Browser.close`, kill after 2 s. The browser is in a Windows job object
  that closes with the worker, so a force-killed worker never leaves it running on (and
  locking) the profile. Closing the last tab or quitting the browser reports `disconnected`
  (`closed by user` / `browser closed`).

### Fingerprints on Chromium: coherence rules

Only a Chrome-on-Windows dump is applied (`worker_runner.chromiumFingerprint`); for anything
else the browser's own fingerprint stands.

1. **Never another browser or version.** The UA string, `brands` and `fullVersionList` are the
   real binary's, read from `navigator.userAgentData` on a secure local page at launch (a build
   that never answers high-entropy hints gets its full version from `Browser.getVersion`). A
   Chrome 124 UA on a Chrome 153 binary is the first thing detectors check.
2. **OS and hardware may come from the dump**: `navigator.platform` and the UA-CH OS fields
   (`platform`, `platformVersion`, `architecture`, `bitness`, `model`, `mobile`, `wow64`) through
   `Emulation.setUserAgentOverride` + `userAgentMetadata`; `hardwareConcurrency` through
   `Emulation.setHardwareConcurrencyOverride`; `deviceMemory` (only values Chrome can report) and
   `screen.availWidth/availHeight/colorDepth/pixelDepth` through an early script; WebGL
   `UNMASKED_VENDOR/RENDERER` through a `getParameter` patch. Patched functions keep their
   native name, length, missing `prototype`, `toString()` text and "Illegal invocation" on a
   wrong receiver; they run first in every document and cross-site frame.
3. **Screen size and devicePixelRatio only when headless.** A headless browser has no monitor,
   so it gets the dump's screen (`Emulation.setDeviceMetricsOverride`, viewport untouched) and a
   sane DPR; a headful window stays on the real monitor, which it has to fit.
4. **Never a software GPU.** SwiftShader / llvmpipe / "Basic Render" renderers are not applied:
   they mark a headless bot.
5. **Timezone, locale and geolocation come from the exit IP, never from the dump.** The dump's
   languages are used only without a proxy.

### Manual Firefox wrapper

`firefox.exe -no-remote -wait-for-browser -profile <userDataDir> [-headless] [urls]`, with a
`user.js` written into the profile at each launch: the proxy (`network.proxy.*`; SOCKS with
`socks_remote_dns`), `network.dns.disableIPv6` and `network.proxy.failover_direct=false` when
proxied, `network.trr.mode=5`, `media.peerconnection.ice.proxy_only(_if_behind_proxy)`,
`default_address_only` and `no_host`, `geo.enabled` (false unless `spoof`), and telemetry,
studies and first-run pages off. `ready` once its window is up (headless: once it is still
running after about 2 s); `disconnected` when it exits; `close` asks it to close (WM_CLOSE) and
forces after 2 s.

### Limitations

- Chromium: only the fingerprint surface above changes; canvas, audio, fonts and the WebGL
  parameters other than vendor/renderer are the machine's own. `hardwareConcurrency` and the
  WebGL patch do not reach dedicated, shared or service workers (they report real values).
- SOCKS4 carries no password (the username goes as the userid) and cannot reach IPv6 literals.
- GrizzEngine and other Bablosoft BAS builds (`worker.exe` beside `Proxy.dll`, found in the
  engines folder) are listed with `limited: true`. Outside Bablosoft's own host (FastExecuteScript)
  their `Intl` API hangs: `Intl.DateTimeFormat()` and `Intl.NumberFormat()` never return, headful
  or headless, bare or driven (measured 2026-09-27 on 149.0.7827.54; `--bas-disable-tab-hook` and
  `--bas-disable-tunneling` do not help), so most sites stall. Their IP, DNS and WebRTC are
  clean through the tunnel. Bablosoft's engine is proprietary: check its licence before
  shipping it to others.
- Chromium: `new_tab` tabs and cross-site iframes are verified to start paused and covered
  (headless check). `window.open` popups and tabs a user opens from the browser UI go through
  the same browser-level auto-attach, but those paths were not exercised by the check.
- Firefox family: manual only (no scripts, warm-up, broadcast, cookie export, timezone or
  language alignment).
- The current `.fpt` pool is Chrome-only, and `fingerprint.js` derives a dump's `browserName`
  from its file name, which this pool's names do not encode: every dump reads as "Chrome".
