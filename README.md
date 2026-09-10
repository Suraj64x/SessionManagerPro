<div align="center">

# ⚡ SessionManagerPro
**Multi-Threaded Anti-Detect Chromium Orchestrator & GUI Panel**

<p align="center">
  <img src="https://img.shields.io/badge/SessionManagerPro-v1.1.0-000000?style=for-the-badge&logo=codeigniter&logoColor=white" alt="SessionManagerPro" />
  <img src="https://img.shields.io/badge/React-19-000000?style=for-the-badge&logo=react&logoColor=61dafb" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-Ready-000000?style=for-the-badge&logo=typescript&logoColor=3178c6" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Chromium-Anti--Detect-000000?style=for-the-badge&logo=googlechrome&logoColor=4285F4" alt="Chromium" />
</p>

One Profile • One Sticky Proxy • One Hardware Fingerprint • Dual Cookie Persistence

</div>

---

## ✨ Highlights

- **🔒 Advanced Anti-Detect Engine** — Complete WebGL1/WebGL2 & CDP fingerprint spoofing.
- **🚀 Native Desktop App** — Edge WebView2 integration for a seamless, frameless, and native Windows experience.
- **⚡ Multi-Threaded Orchestrator** — High-performance thread pool and queue management for scaling sessions.
- **🛡️ Sticky Proxies** — Absolute isolation with dedicated IPs bound to unique hardware fingerprints.
- **🍪 Dual Persistence** — Bulletproof session persistence handling local profiles and dual cookie layers.
- **📊 Professional GUI Panel** — Beautiful React 19 + TypeScript dashboard with live event broadcasting.

---

## 🚀 Quick Start

Launch SessionManagerPro exactly how you prefer. The system intelligently manages the backend server lifecycle.

### Desktop App (Recommended)
Launch the native, frameless Edge WebView2 desktop app. It handles the local server silently in the background.
```powershell
npm run app
# Or simply double-click SessionManagerPro.exe
```

### Web Browser Mode
Start the backend and open the sleek React dashboard in your default browser at `http://localhost:3001`.
```powershell
npm start
```

### Legacy CLI
Prefer the terminal? Run the classic interactive CLI menu.
```powershell
npm run cli
```

---

## 🏗️ Architecture

A clean, modular enterprise structure.

```text
SessionManagerPro/
├── SessionManagerPro.exe      # Native Windows Desktop Executable (Edge WebView)
├── backend/                   # Node.js Server & Session Engine
│   └── src/                   # Express REST API, WebSockets, Orchestrator, Puppeteer
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

<br/>

<div align="center">
  <sub>Built with 🖤 by the SessionManagerPro Team</sub>
</div>
