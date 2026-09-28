// Window control (focus, cascade, tile, minimize, restore) and broadcast to running
// profiles: one worker op per profile, all at once, results per id. No live mirroring —
// "open this URL everywhere" and "type a different value in each window" cover the need
// without the fragility. Worker ops: see ../ENGINE.md §1. See README.md for deps.

const WINDOW_ACTIONS = new Set(["focus", "cascade", "tile", "minimize", "restore"]);
const CASCADE_STEP = 32;
// A profile that just launched may still be opening its start pages; the worker holds
// every op for up to 30 s until they finish (ENGINE.md §1). Window ops are instant after that.
const WINDOW_TIMEOUT_MS = 35_000;
// The op's own 30 s plus the same start-page allowance.
const BROADCAST_TIMEOUT_MS = 30_000 + 35_000;
const MAX_TEXT = 2000;
const MAX_SCROLL = 20_000;
// Key names Playwright accepts, kept to what a broadcast plausibly needs: no modifiers, so
// a stray Control+W cannot close every window at once.
const KEYS = new Set([
  "Enter", "Tab", "Escape", "Backspace", "Delete", "Space",
  "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", "PageDown", "PageUp", "F5",
]);
const isKey = (k) => typeof k === "string" && (KEYS.has(k) || /^[a-zA-Z0-9]$/.test(k));
const isRect = (r) => r && typeof r === "object" && ["x", "y", "width", "height"].every((k) => Number.isFinite(r[k])) && r.width > 0 && r.height > 0;
const random = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const MAX_IDS = 1000;
const uniqueIds = (ids) => [...new Set(ids.map(String))];
const badIds = (ids) =>
  !Array.isArray(ids) || !ids.length ? "No session IDs provided" : ids.length > MAX_IDS ? `At most ${MAX_IDS} profiles at once` : null;

/* ---------------- rect maths (physical pixels, work area of one monitor) ---------------- */

/** Each window keeps its size; offset CASCADE_STEP per window from the work-area origin, wrapping when it would leave it. */
function cascade(bounds, mon) {
  let k = 0;
  return bounds.map((b) => {
    const width = Math.min(b.width, mon.width);
    const height = Math.min(b.height, mon.height);
    if (k && (mon.x + CASCADE_STEP * k + width > mon.x + mon.width || mon.y + CASCADE_STEP * k + height > mon.y + mon.height)) k = 0;
    const rect = { x: mon.x + CASCADE_STEP * k, y: mon.y + CASCADE_STEP * k, width, height };
    k += 1;
    return rect;
  });
}

/** An n×m grid over the work area: as square as the count allows, rows filled left to right. */
function tile(count, mon) {
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const width = Math.floor(mon.width / cols);
  const height = Math.floor(mon.height / rows);
  return Array.from({ length: count }, (_, i) => ({
    x: mon.x + (i % cols) * width,
    y: mon.y + Math.floor(i / cols) * height,
    width,
    height,
  }));
}

/* ---------------- broadcast ops: validate once, then one (rpcOp, payload) per profile ---------------- */

/** Returns `plan(id) → { op, payload, timeoutMs, value(result) }`, or throws a message fit for a 400. */
function planBroadcast(op, args, perProfile) {
  switch (op) {
    case "open_url": {
      const url = String(args.url || "").trim();
      const where = args.where === undefined ? "new" : args.where;
      if (!url) throw new Error("url is required");
      if (!["new", "current"].includes(where)) throw new Error("where must be new or current");
      return () =>
        where === "new"
          ? { op: "new_tab", payload: { url }, value: (r) => r?.url }
          : { op: "goto", payload: { url }, value: (r) => r };
    }
    case "reload":
      return () => ({ op: "reload", payload: {}, value: (r) => r });
    case "close_other_tabs":
      return () => ({ op: "close_other_tabs", payload: {}, value: (r) => r });
    case "press": {
      if (!isKey(args.key)) throw new Error("key must be one of Enter, Tab, Escape, Backspace, Delete, Space, the arrows, Home, End, PageUp, PageDown, F5 or a single letter or digit");
      return () => ({ op: "press", payload: { key: args.key }, value: () => args.key });
    }
    case "scroll": {
      const dy = args.dy === undefined ? 600 : Number(args.dy);
      if (!Number.isFinite(dy) || Math.abs(dy) > MAX_SCROLL) throw new Error(`dy must be a number within ±${MAX_SCROLL}`);
      return () => ({ op: "scroll", payload: { dy }, value: () => dy });
    }
    case "type": {
      let textFor;
      if (args.random !== undefined) {
        const [min, max] = Array.isArray(args.random) ? args.random.map(Number) : [NaN, NaN];
        if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) throw new Error("random must be [min, max] integers with min ≤ max");
        textFor = () => String(random(min, max));
      } else if (args.text !== undefined) {
        if (typeof args.text !== "string" || !args.text || args.text.length > MAX_TEXT) throw new Error(`text must be 1–${MAX_TEXT} characters`);
        textFor = () => args.text;
      } else {
        if (!Object.keys(perProfile).length) throw new Error("text, random or perProfile is required");
        const bad = Object.values(perProfile).find((p) => typeof p?.text !== "string" || p.text.length > MAX_TEXT);
        if (bad) throw new Error(`perProfile text must be a string of at most ${MAX_TEXT} characters`);
        textFor = (id) => perProfile[id]?.text || "";
      }
      return (id) => {
        const text = textFor(id);
        if (!text) throw new Error("no text for this profile");
        // One delay per call is all the op takes: vary it per profile so windows don't type in lockstep.
        const delay = 60 + random(0, 80);
        return {
          op: "keyboard_type",
          payload: { text, delay },
          // Same allowance scripts.js gives a type op: the keystrokes themselves take len × delay.
          timeoutMs: BROADCAST_TIMEOUT_MS + text.length * (delay + 50),
          value: () => (text.length > 80 ? text.slice(0, 80) + "…" : text),
        };
      };
    }
    default:
      throw new Error(`unknown op: ${op}`);
  }
}

const BROADCAST_OPS = ["open_url", "reload", "close_other_tabs", "type", "press", "scroll"];

module.exports = function register(app, deps) {
  const { orchestrator, isWebUrl, log } = deps;

  const notRunning = (id) => (orchestrator.live.has(id) ? null : { ok: false, error: "not running" });

  app.post("/api/sessions/window", async (req, res) => {
    const { ids, action, monitor } = req.body || {};
    if (badIds(ids)) return res.status(400).json({ error: badIds(ids) });
    if (!WINDOW_ACTIONS.has(action)) return res.status(400).json({ error: `unknown action: ${action}` });
    if (monitor !== undefined && !isRect(monitor)) return res.status(400).json({ error: "monitor must be { x, y, width, height }" });

    const results = {};
    const targets = [];
    for (const id of uniqueIds(ids)) {
      const live = orchestrator.live.get(id);
      if (!live) results[id] = { ok: false, error: "not running" };
      else if (live.headless || live.handle?.headless) results[id] = { ok: false, error: "headless — it has no window" };
      else targets.push(live);
    }
    const win = (live, payload) => live.handle.rpc("window", payload, WINDOW_TIMEOUT_MS);
    const settle = (live, promise) =>
      promise.then(
        (r) => (results[live.id] = r),
        (err) => (results[live.id] = { ok: false, error: err.message || String(err) })
      );

    if (action === "cascade" || action === "tile") {
      // Restore first (it returns the bounds too): a minimized window reports −32000 and a
      // tiny size, and a maximized one moved and then restored would snap back to its old rect.
      const bounds = await Promise.all(
        targets.map((live) => win(live, { action: "restore" }).then((r) => r.bounds, (err) => ({ error: err.message || String(err) })))
      );
      const placed = [];
      targets.forEach((live, i) => (bounds[i].error ? (results[live.id] = { ok: false, error: bounds[i].error }) : placed.push({ live, bounds: bounds[i] })));
      if (placed.length) {
        const mon = monitor || placed[0].bounds.monitor;
        const rects = action === "cascade" ? cascade(placed.map((p) => p.bounds), mon) : tile(placed.length, mon);
        await Promise.all(
          placed.map(({ live }, i) =>
            settle(live, win(live, { action: "move", rect: rects[i] }).then((r) => ({ ok: true, bounds: r.bounds })))
          )
        );
      }
    } else {
      await Promise.all(
        targets.map((live) =>
          settle(
            live,
            win(live, { action }).then((r) =>
              action === "focus" && r.focused === false ? { ok: false, error: "Windows refused to bring it to the front" } : { ok: true }
            )
          )
        )
      );
    }
    const ok = Object.values(results).filter((r) => r.ok).length;
    log("info", "BROWSER", `Window ${action}: ${ok} of ${Object.keys(results).length} profile(s)`);
    res.json({ results });
  });

  app.post("/api/broadcast", async (req, res) => {
    const { ids, op } = req.body || {};
    const args = req.body?.args && typeof req.body.args === "object" ? req.body.args : {};
    const perProfile = req.body?.perProfile && typeof req.body.perProfile === "object" ? req.body.perProfile : {};
    if (badIds(ids)) return res.status(400).json({ error: badIds(ids) });
    if (!BROADCAST_OPS.includes(op)) return res.status(400).json({ error: `unknown op: ${op}` });
    if (op === "open_url" && !isWebUrl(String(args.url || "").trim())) return res.status(400).json({ error: "url must be http(s)" });
    let plan;
    try {
      plan = planBroadcast(op, args, perProfile);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const results = {};
    await Promise.all(
      uniqueIds(ids).map(async (id) => {
        const missing = notRunning(id);
        if (missing) return (results[id] = missing);
        try {
          const step = plan(id);
          const r = await orchestrator.live.get(id).handle.rpc(step.op, step.payload, step.timeoutMs || BROADCAST_TIMEOUT_MS);
          const value = step.value(r);
          results[id] = value === undefined ? { ok: true } : { ok: true, value };
        } catch (err) {
          results[id] = { ok: false, error: err.message || String(err) };
        }
      })
    );
    const ok = Object.values(results).filter((r) => r.ok).length;
    log(ok === Object.keys(results).length ? "info" : "warn", "BROWSER", `Broadcast ${op}: ${ok} of ${Object.keys(results).length} profile(s)`);
    res.json({ results });
  });
};

// For backend/test/windows_check.js.
module.exports.cascade = cascade;
module.exports.tile = tile;
