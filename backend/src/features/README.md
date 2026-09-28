# Backend features

Each file here is one feature: `module.exports = function register(app, deps) { ... }`.
`server.js` loads them in a fixed order before the frontend catch-all, so any route a
feature registers is reachable. A feature that throws while loading is logged and skipped;
the rest of the panel keeps working.

## `deps`

| key | what it is |
| --- | --- |
| `app` | the Express app. Routes are wrapped: a rejected async handler becomes a 500 JSON error, never a crash. Every non-GET request already passed the loopback + `X-SMP` guard and `express.json()`. |
| `orchestrator` | the live-browser pool. See `../ENGINE.md` for `launch`, `launchAndWait`, `stop`, `stopAll`, `getStatus()`, `live` (Map id → `{ id, handle, startedAt, url }`), the events (`session:launched`, `session:closed`, `session:update`, `pool:update`, `log`) and `handle.rpc(op, payload, timeoutMs)`. |
| `manager` | the whole `../manager.js` module: `getSession`, `listSessions`, `saveSessionPatch(id, patch)`, `createSessionRecord(id, extras)`, `listAllProxies`, `listAllFingerprints`, `parseProxy`, `normalizeCookies`, `stageCookieImport`, `readCookies`, `listTrash`, … |
| `scripts` | `../scripts.js`: `list/get/create/update/remove`, `startRun(script, ids, scriptDeps, options?)` (options: `launch`, `stopAfter`, `headless`, `prefs`, `limitMs`, `input`, `scheduleId`), `rerunFailed`, `stopRun`, `recentRuns`, `events` (emits `run`). |
| `broadcast(type, data)` | sends `{ type, data }` to every connected panel. Use a type prefixed with your feature name (`proxy`, `schedule`, `engine`, …); the frontend subscribes with `useEvent(type, handler)`. |
| `appSettings.register(key, defaultValue, validate, { readOnly }?)` | adds a key to `data/app.json`. `validate(value)` returns the cleaned value or throws a message for a 400. `GET /api/app` returns every registered key; `PATCH /api/app` accepts any registered key and broadcasts `app`. A `readOnly` key always reads as its default and is never stored. `appSettings.write(next)` keeps keys it does not know, so load order never loses a setting. |
| `readApp()` | the current settings object. |
| `bulk` | the `POST /api/sessions/bulk` action table. Add `deps.bulk.myAction = async (rec, value) => …`; it runs per selected profile and failures are collected, not fatal. |
| `testProxy(p)` | the exit-IP probe used by `/api/proxies/test`: `{ ok, latency, ip, country, countryCode, city, timezone, isp, error }`. |
| `isWebUrl(u)`, `cleanTags(tags)` | the validators the session routes use. |
| `ROOT`, `DATA_DIR`, `PORT` | install root, `data/`, and the port. |
| `log(level, category, message, sessionId?)` | writes to the event log (`info` \| `success` \| `warn` \| `error`). |

## Rules

- Own your data file under `data/` (e.g. `data/proxies.json`). Write it with `writeFileAtomic` from `../fsutil` (a unique temp name, then a rename), read shared ones with `readJsonSafe`, and wrap read-modify-write in `withFileLock`: a second server or a test run may touch the same file.
- Never trust request bodies: validate lengths, enums and URLs; use `manager.safeId`-style lookups; return 400/404/409 with a readable `error`.
- Never send proxy passwords to the panel.
- Do not edit `server.js`, `manager.js`, `scripts.js`, `orchestrator.js`, the worker or another feature. If you need a change there, say so in your report.
- Session record fields already accepted by `PATCH /api/sessions/:id`: `notes`, `tags`, `label` (the status name), `color`, `startUrls`, `proxy` (or `proxyKey`, a library proxy's host:port), `fingerprintFile`, `folder`, `pinned`, `browser` (an id from GET /api/browsers; refused while running), `geolocation` (`block` | `spoof`), `webrtc` (`masked` | `off`).
