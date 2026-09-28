# Frontend features

Every feature lives in its own folder here and is wired in exactly two places, both of which
already exist: `App.tsx` renders the view components it imports from `features/<name>`, and
`contributions.tsx` merges each feature's `contributions` export into the shared views. So a
feature team edits only its own folder (plus its backend module) and never a shared file.

## Shape of a feature

```
features/<name>/
  index.tsx        exports the view (if it has a section) and `contributions`
  <name>.css       its own styles, imported from index.tsx (`import './<name>.css'`)
  api.ts           its endpoints, built on fetch with the X-SMP header (copy the helper from ../../api.ts)
  types.ts         its types
```

Views are `React.FC<{ active: boolean }>` with no other props: read state with `useApp()`.
A view renders its header with `<Toolbar title="…" count={n}>actions</Toolbar>` (from
`../../ui`) and its body inside `<div className="view">`. Mark its search box with `data-search`
so `/` and `Ctrl+K` focus it. Prefer the shared pieces in `ui.tsx` (Modal, Menu, Empty, Pager,
TagInput, CheckBox, Stepper, CopyButton, StatusBadge, usePaged, useStored, useDialog) and the
existing classes in `index.css` (`.btn`, `.btn.primary/.danger/.ghost/.xs`, `.icon-btn`,
`.input`, `.field`, `.seg`, `.chip`, `.badge`, `.card`, `.table-wrap`/`table`, `.hint`,
`.section`/`.setting`, `.menu`, `.empty`). Faces: `Avatar`, `FaceHuddle` from `../../faces`.

## `useApp()` (app-context.tsx)

Everything already loaded and kept fresh by the WebSocket: `sessions`, `trash`, `pool`,
`proxies`, `fingerprints`, `scripts`, `runs`, `logs`, `app` (settings), `connected`,
`selectedIds`/`setSelectedIds`, `openId`/`openProfile(id)`, `openNew()`, `tab`/`setTab`,
`refresh.{all,sessions,trash,scripts,resources,app}`, and the actions `launch(ids)`,
`stop(id)`, `stopAll()`, `bulk(ids, action, value)`, `runScript(target, ids)`,
`changeApp(patch)`. Toasts and confirms come from `useUI()` in `../../ui`.

`useEvent(type, handler)` subscribes to a WebSocket message type. The server's
`deps.broadcast(type, data)` and this hook are the only link needed for live updates; the
built-in types are `pool`, `session`, `log`, `logs`, `run`, `app`, `hello`, `quit`.

## `contributions` (contributions.tsx)

| slot | rendered where |
| --- | --- |
| `rowMenu(ctx)` | a profile row's "…" menu (`ctx.session`, `ctx.close()`); return `<button>` elements, `<hr />` and `<div className="menu-head">` are allowed |
| `bulkBar(ctx)` | the floating bar for selected profiles (`ctx.ids`, `ctx.sessions`, `ctx.live`, `ctx.clear()`); return `.btn.xs` buttons or `Menu`s with `up` |
| `liveActions({ session })` | next to a running profile on Home |
| `profilesPrimary({ onNew })` | replaces the "New" button in the Profiles header (one owner: templates) |
| `createMenu({ close })` | items in the create menu that `profilesPrimary` renders |
| `profilesAbove()` | between the Profiles header and the table |
| `drawerTabs[]` | `{ id, label, render(session) }` tabs after "Profile" in the drawer |
| `settingsSections[]` | `{ id, title, render() }` sections on the Settings page; use `.setting` rows |
| `statusItems()` | `.status-item` spans in the bottom bar |
| `homeSections()` | cards under Home's own |

Keep contributions cheap: they run on every render of the host view.

## Rules

- Do not edit `App.tsx`, `contributions.tsx`, `app-context.tsx`, `ui.tsx`, `index.css`,
  `types.ts`, `api.ts` or another feature. If a change there is unavoidable, list it in your
  report instead of making it.
- Build must stay clean: `npx tsc -b && npm run build` from `frontend/`, and `npm run lint`
  must add no new warnings.
- Follow the existing tone: minimal, few words, no marketing copy, sentence case, real
  empty states (`Empty` with one action), confirms for destructive actions with counts.
