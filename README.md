<p align="center">
  <img src="https://img.shields.io/badge/SessionManagerPro-v1.1.0-06b6d4?style=for-the-badge&labelColor=111111" alt="SessionManagerPro" />
  <img src="https://img.shields.io/badge/React-19-61dafb?style=for-the-badge&logo=react&logoColor=black&labelColor=111111" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-Ready-3178c6?style=for-the-badge&logo=typescript&logoColor=white&labelColor=111111" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Chromium-Anti--Detect-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white&labelColor=111111" alt="Chromium" />
</p>

<h1 align="center">SessionManagerPro</h1>

<p align="center">
  <b>Multi-Threaded Anti-Detect Chromium Orchestrator & Professional GUI Panel</b><br />
  One Profile ↔ One Sticky Proxy ↔ One Hardware Fingerprint ↔ Dual Cookie Persistence
</p>

<p align="center">
  <code>npm start</code>
</p>

---

## ⚡ Launching the Software

### Option A: Native Desktop App (Edge WebView)
Double-click:
👉 **`SessionManagerPro.exe`**
*(Or run `npm.cmd run app` from the terminal)*

This opens SessionManagerPro in a native, frameless Edge WebView2 desktop window without any browser tabs or URL bars, functioning like a standalone software suite. It silently manages the local backend server and cleanly shuts it down when you close the window.

### Option B: Web Browser Mode
```powershell
npm.cmd start
```
Starts the backend and opens the dashboard in your default browser at `http://localhost:3001`.

### Option C: Terminal CLI
```powershell
npm.cmd run cli
```
Runs the legacy interactive terminal menu.

---

## 📁 Enterprise Architecture

```text
Session manager/
├── SessionManagerPro.exe      # Native Windows Desktop Executable (Edge WebView)
├── backend/                   # Backend Server & Session Engine
│   ├── src/
│   │   ├── server.js          # Express REST API & WebSocket server
│   │   ├── orchestrator.js    # Thread pool, queue, and live event broadcaster
│   │   ├── manager.js         # Session persistence & Puppeteer lifecycle
│   │   ├── fingerprint.js     # WebGL1/WebGL2 & CDP fingerprint spoofing (.json & .json.gz)
│   │   ├── cli.js             # Terminal CLI interface
│   │   ├── sheet.js           # CSV/HTML reporting & two-way sync
│   │   ├── splash.js          # ASCII branding banner
│   │   └── index.js           # CLI router & selfcheck script
│   └── package.json           # Backend package configuration
├── frontend/                  # React 19 + TypeScript + Vite GUI Panel
│   ├── src/
│   │   ├── components/        # Rail, RunBar, SessionTable, Proxy/Fpt panels, ConsoleDock, Modals
│   │   ├── ui.tsx             # Modal, toasts, confirm, pager, shared hooks
│   │   ├── api.ts             # REST & WebSocket client
│   │   ├── types.ts           # TypeScript models
│   │   ├── index.css          # Design tokens & component primitives
│   │   ├── App.tsx            # Main dashboard component
│   │   └── main.tsx           # React bootstrap
│   ├── dist/                  # Production static assets served by backend
│   ├── vite.config.ts         # Vite bundler configuration
│   └── tsconfig.json          # TypeScript compiler options
├── launcher/
│   └── SessionManagerPro.cs   # C# native launcher source
├── scripts/
│   └── build-exe.ps1          # Automated compilation script using csc.exe
├── data/                      # Local session storage (profiles, cookies, sessions.json)
├── resources/                 # Input resources (proxies, fingerprints, AccountFile.csv)
├── updates/                   # Output sheets (sessions.csv, sessions.html, session_status.log)
└── package.json               # Master orchestration scripts
```

---

## 🛠️ Master Scripts

| Command | Action |
|---|---|
| `SessionManagerPro.exe` | Launches the native Windows desktop app window |
| `npm.cmd start` | Starts backend and opens dashboard in default browser (`http://localhost:3001`) |
| `npm.cmd run app` | Launches `SessionManagerPro.exe` |
| `npm.cmd run cli` | Runs the interactive terminal CLI |
| `npm.cmd run build` | Compiles both the React frontend and `SessionManagerPro.exe` |
| `npm.cmd run build:ui` | Rebuilds only the React frontend |
| `npm.cmd run build:exe` | Recompiles `SessionManagerPro.exe` using `csc.exe` |
| `npm.cmd run selfcheck` | Runs automated verification check |
