// The browsers a profile can run on. See README.md in this folder for deps, ENGINE.md §7.
//
//   GET    /api/browsers              { default, browsers: [entry] }   (detection cached 60 s)
//   POST   /api/browsers/custom       { path, name? } → the new entry (400 bad path/not a browser, 409 duplicate)
//   DELETE /api/browsers/custom/:id   → { ok } (404 unknown, 409 "used by N profiles")
const browsers = require("../browsers");

module.exports = function register(app, deps) {
  const { orchestrator, manager, appSettings, readApp } = deps;

  // The last detected list, for the synchronous settings validator below.
  let known = null;
  const listing = () => browsers.list().then((l) => (known = l));
  listing().catch(() => {});

  // The engine new profiles start on (Settings → Browsers). manager.createSessionRecord reads it,
  // so every way of creating a profile — single, batch, CSV, templates, imports — follows it.
  appSettings.register("defaultBrowser", browsers.DEFAULT_BROWSER, (v) => {
    const id = String(v || "").trim();
    if (!id || id.length > 80) throw new Error("defaultBrowser must be a browser id from GET /api/browsers");
    if (known) {
      const b = known.find((x) => x.id === id);
      if (!b) throw new Error(`unknown browser "${id}"`);
      if (!b.installed) throw new Error(`${b.name} is not installed`);
    }
    return id;
  });

  app.get("/api/browsers", async (req, res) => {
    const list = await listing();
    const wanted = readApp().defaultBrowser;
    // A default that was uninstalled falls back to the built-in engine rather than failing creates.
    const def = list.some((b) => b.id === wanted && b.installed) ? wanted : browsers.DEFAULT_BROWSER;
    res.json({ default: def, browsers: list });
  });

  // Bulk "Browser…": same rules as PATCH — a known, installed engine, and never while running.
  deps.bulk.browser = async (rec, value) => {
    const id = await browsers.validId(value);
    if (orchestrator.live.has(rec.id) || orchestrator.queue.includes(rec.id) || orchestrator.starting.has(rec.id)) {
      throw new Error("running — stop it before changing its browser");
    }
    if ((rec.browser || browsers.DEFAULT_BROWSER) === id) return rec;
    return manager.saveSessionPatch(rec.id, { browser: id });
  };

  app.post("/api/browsers/custom", async (req, res) => {
    try {
      const added = await browsers.addCustom({ path: req.body?.path, name: req.body?.name });
      deps.log("info", "BROWSER", `Added custom browser: ${added.name} (${added.path})`);
      res.json(added);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.delete("/api/browsers/custom/:id", async (req, res) => {
    const id = req.params.id;
    const usedBy = [...deps.manager.listSessions(), ...deps.manager.listTrash()].filter((s) => s.browser === id).length;
    try {
      await browsers.removeCustom(id, usedBy);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }
    deps.log("info", "BROWSER", `Removed custom browser ${id}`);
    res.json({ ok: true });
  });
};
