<p align="center">
  <img src="https://img.shields.io/badge/SessionManagerPro-v1.0.0-7dffc3?style=for-the-badge&labelColor=111111" alt="SessionManagerPro" />
  <img src="https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white&labelColor=111111" alt="Node.js" />
  <img src="https://img.shields.io/badge/Chromium-profiles-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white&labelColor=111111" alt="Chromium" />
</p>

<h1 align="center">SessionManagerPro</h1>

<p align="center">
  <b>Persistent Chromium sessions.</b><br />
  One name. One profile. One proxy. One fingerprint.
</p>

<p align="center">
  <code>npm start</code>
</p>

---

## Overview

SessionManagerPro is a Node.js CLI that opens real Chrome windows, one per named session. Close a window and the next name in the queue starts, so a fixed thread count stays live.

| Kept per name | What stays |
|---|---|
| **Profile** | Cookies, logins, last tabs |
| **Proxy** | One unused line from `resources/proxies/*.txt` |
| **Fingerprint** | One unused file from `resources/fpts/` |
| **Sheet** | Status written to `updates/sessions.csv` and `updates/sessions.html` |

---

## Quick start

```bash
npm install
npm start
```

Requires **Node.js 18+** and a local **Chrome / Chromium** install.

On launch you get a splash, then a menu:

```
Get started
> Custom name
  From account names
  Open saved sessions
  View saved sessions
```

---

## Menu

### Launch

| Command | What it does |
|---|---|
| **Custom name** | Enter names line by line. Blank line finishes. |
| **From account names** | Use the Email column in `resources/AccountFile.csv`. |
| **Open saved sessions** | Reopen existing profiles — same proxy, fingerprint, and cookies. |

Then set **thread count** (max windows at once) and an optional **start URL**.

When you close a window it is marked **success** and the next queued name opens. If Chrome exits on its own it is marked **error** with a reason, then the next name opens.

### Sessions

| Command | What it does |
|---|---|
| **View saved sessions** | Table of name, result, proxy, Chrome version |
| **Edit sessions CSV** | Opens `updates/sessions.csv`. Save, then press Enter to sync. |

### Manage

Close running windows, delete a profile, or exit.

---

## Resources

These folders ship empty. Put your own files in — they are not committed.

```
resources/
├── proxies/          one line = one proxy
│                     http://user:pass@host:port
├── fpts/             one file = one fingerprint
│                     .json or .json.gz
└── AccountFile.csv   optional names (Email column)
```

---

## Layout

```
src/                 CLI and session engine
resources/           proxies, fingerprints, account names
data/profiles/       Chrome user-data dirs
data/cookies/        cookie backups
updates/             sessions.csv · sessions.html
```

---

## Library

```js
const { openSession, ensureSessions } = require("./src/manager");

await ensureSessions(["shop1"]);
const { page, cursor, close } = await openSession("shop1", {
  url: "https://example.com",
});

await cursor.click("button");
await close();
```

---

<p align="center">
  <sub>Runtime data stays local. Proxies, fingerprints, profiles, and sheets are gitignored.</sub>
</p>
