<div align="center">

# ⚡ SessionManagerPro
**Multi-Threaded Anti-Detect Orchestrator & GUI Panel with InvisiblePlaywright**

<p align="center">
  <img src="https://img.shields.io/badge/SessionManagerPro-v1.2.0-8B5CF6?style=for-the-badge&logo=codeigniter&logoColor=white&labelColor=111111" alt="SessionManagerPro" />
  <img src="https://img.shields.io/badge/React-19-61dafb?style=for-the-badge&logo=react&logoColor=black&labelColor=111111" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-Ready-3178c6?style=for-the-badge&logo=typescript&logoColor=white&labelColor=111111" alt="TypeScript" />
  <img src="https://img.shields.io/badge/InvisiblePlaywright-Stealth-FF7139?style=for-the-badge&logo=firefox&logoColor=white&labelColor=111111" alt="InvisiblePlaywright" />
</p>

One Profile • One Sticky Proxy • One Hardware Fingerprint • Dual Cookie Persistence

</div>

---

## ✨ Highlights

- **🔒 InvisiblePlaywright Stealth Engine** — Undetected Firefox patched at C++ source level with Bayesian fingerprinting and Cloudflare Turnstile / reCAPTCHA bypass.
- **🖱️ Humanized Bezier Cursor Motion** — Byte-identical real mouse input with Bezier-curved arcs and human timing (no teleporting).
- **🚀 Native Desktop App** — Edge WebView2 integration for a seamless, frameless, and native Windows experience.
- **⚡ Multi-Threaded Orchestrator** — High-performance thread pool and queue management for scaling sessions.
- **🛡️ Sticky Proxies** — Absolute isolation with dedicated SOCKS5/HTTP IPs routed without local DNS leaks.
- **🍪 Dual Persistence** — Bulletproof session persistence handling native Firefox profiles and JSON cookie layers.
- **📜 Scripts** — A script library you run on live profiles from the panel: in-page snippets, Playwright-style automation, and auto-run-on-launch userscripts.
- **🗂️ Profile management** — Tags, labels and colours with filters; bulk tag / label / stop / run / trash; clone; per-profile start pages; cookie import & export; a 48-hour trash with restore.
- **🌍 Exit-IP aware** — The proxy checker geolocates the proxy's *exit* IP, and the browser's timezone and locale follow that same exit IP at launch.
- **📊 Professional GUI Panel** — Compact React 19 + TypeScript dashboard with a live event log.

---

## 🚀 Quick Start

Launch SessionManagerPro exactly how you prefer. The system intelligently manages the backend server lifecycle.

### Install (Windows 10/11 x64)
Run `SessionManagerPro-Setup-1.2.0.exe`. It installs for your user only (no admin prompt) into `%LOCALAPPDATA%\Programs\SessionManagerPro`, with its own Node.js and Python runtimes — nothing else to install.

- **Browser engine.** The patched Firefox (~240 MB download, ~550 MB on disk) is fetched at the end of Setup into `%LOCALAPPDATA%\invisible-playwright`. If that fails (offline), use **Settings → Browser engine → Download** in the panel, or run Setup again.
- **Visual C++ runtime.** The engine needs the Microsoft Visual C++ 2015–2022 x64 runtime. Setup warns when it is missing and links to [the download](https://aka.ms/vs/17/release/vc_redist.x64.exe).
- **Uninstall** keeps your profiles, cookies, proxies and logs unless you choose to delete them. The engine cache is left in place.

### Desktop App (Recommended)
Launch the native, frameless Edge WebView2 desktop app. It handles the local server silently in the background and lives in the system tray.

- **One copy at a time.** Opening it again while it's running shows an *already running* notice and offers to bring up the dashboard.
- **Closing the window** keeps browsers running in the tray by default. Switch to *Quit app* in **Settings → App** to have closing the window exit everything.
- **Quit** (Settings or the tray menu) closes every browser, saving its cookies first, then exits.
```powershell
npm run app
# Or simply double-click SessionManagerPro.exe
```

### Web Browser Mode
Start the backend and open the sleek React dashboard in your default browser at `http://127.0.0.1:47301`.
```powershell
npm start
```

### Legacy CLI
Prefer the terminal? Run the classic interactive CLI menu.
```powershell
npm run cli
```

---

## 📜 Scripts

Open **Scripts** in the panel, write or pick a script, choose **Selected** or **All running** profiles, and press **Run** (`Ctrl+Enter`). Results stream in per profile; **Stop** cancels a run. Unsaved edits run as-is.

**Page** scripts run inside the current tab, like the DevTools console. `return` a value to see it.

```js
return { title: document.title, links: document.links.length };
```

Turn on **Auto-run on every page at launch** to inject a page script into every page of matching profiles, like a userscript. Scope it by URL glob (`*://*.example.com/*`) and by profile tags.

**Automation** scripts drive the tab across page loads:

```js
await page.goto('https://example.com/login');
await page.fill('#email', profile.email);
await page.type('#password', 'secret', { delay: 80 });
await page.click('button[type=submit]');
await page.waitFor('.dashboard');
log('signed in as', profile.id);
return await page.screenshot();   // shown as a thumbnail in the results
```

| In scope | |
| :--- | :--- |
| `page` | `goto` `click` `fill` `type` `press` `waitFor` `scroll` `evaluate` `newTab` `screenshot` `url` `title` `cookies` — each accepts `{ timeout }` |
| `profile` | `id` `email` `notes` `tags` `proxy` |
| helpers | `log(...)` `sleep(ms)` `random(min, max)` — also available in page scripts |

Automation scripts stop after 10 minutes.

> **Security.** Automation scripts run with the same access as the app, so the server only accepts requests from this computer. It binds to `127.0.0.1` and refuses foreign `Origin`/`Host` headers (which also blocks DNS rebinding). It also refuses state-changing requests that lack the panel's `X-SMP` header. Don't expose it on a network.

---

## 🏗️ Architecture

A clean, modular enterprise structure.

```text
SessionManagerPro/
├── SessionManagerPro.exe      # Native Windows Desktop Executable (Edge WebView)
├── backend/                   # Node.js Server & Session Engine
│   └── src/                   # Express REST API, WebSockets, Orchestrator, InvisiblePlaywright Runner
├── frontend/                  # React 19 + Vite GUI Panel
│   └── src/                   # UI Components, API Clients, Design Tokens
├── launcher/                  # C# Native Launcher Source
├── data/                      # Local Storage (Profiles, Cookies)
├── resources/                 # Input Data (Proxies, Fingerprints, Accounts)
└── updates/                   # Output Reports (CSV, HTML, Logs)
```

---

## 🛠️ Command Reference

Master orchestration scripts at your fingertips.

| Command | Description |
| :--- | :--- |
| `npm run app` | Launches the native Windows desktop app |
| `npm start` | Starts backend & opens dashboard in default web browser |
| `npm run cli` | Runs the interactive terminal CLI |
| `npm run build` | Compiles both the React frontend and `SessionManagerPro.exe` |
| `npm run build:ui`| Rebuilds only the React frontend |
| `npm run build:exe`| Recompiles `SessionManagerPro.exe` using `csc.exe` |
| `npm run selfcheck`| Runs automated environment and dependency verification |
| `npm run stage` | Assembles the installable app with its runtimes in `build/stage` |
| `npm run build:setup` | Builds the UI, the exe and the stage, then `release/SessionManagerPro-Setup-<version>.exe` |

### Building the installer

Needs [Inno Setup 6](https://jrsoftware.org/isinfo.php) (`ISCC.exe`), the developer `.venv` (`pip install -r requirements.txt`) and Node on `PATH`. Nothing is downloaded at build time: `scripts/stage.ps1` copies the local CPython 3.11 install behind `.venv` plus the venv's packages into `runtime\python`, the running `node.exe` into `runtime\node`, and a production-only `backend\node_modules`. The version comes from `package.json`. Wizard images are regenerated with `installer\make-assets.ps1`.

```powershell
npm run build:setup
```

<br/>

<div align="center">
  <sub>Built with 🖤 by the SessionManagerPro Team</sub>
</div>
