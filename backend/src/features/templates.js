// Profile templates and quick-create. See README.md in this folder for deps.
//
// data/templates.json: [{ id, name, pattern, folder, tags, status, startUrls, notes,
//   proxyStrategy: 'unused' | 'unused-ok' | 'specific', proxy (URL, 'specific' only),
//   fptStrategy: 'unused' | 'specific', fingerprintFile, isDefault, createdAt, updatedAt }]
// Exactly one template is the default; the "Quick profile" button creates from it.
const fs = require("fs");
const { writeFileAtomic } = require("../fsutil");
const path = require("path");
const crypto = require("crypto");

const PROXY_STRATEGIES = ["unused", "unused-ok", "specific"];
const FPT_STRATEGIES = ["unused", "specific"];
const MAX_COUNT = 100;

module.exports = function register(app, deps) {
  const { manager } = deps;
  const FILE = path.join(deps.DATA_DIR, "templates.json");
  // The proxy library's file (features/proxies). The env override exists for templates_check.js only.
  const PROXIES_FILE = process.env.SMP_TEMPLATES_PROXIES_FILE || path.join(deps.DATA_DIR, "proxies.json");

  const now = () => new Date().toISOString();
  const seed = () => [
    {
      id: "default",
      name: "Default",
      pattern: "profile-{n}",
      folder: "",
      tags: [],
      status: "",
      startUrls: [],
      notes: "",
      proxyStrategy: "unused",
      proxy: "",
      fptStrategy: "unused",
      fingerprintFile: "",
      isDefault: true,
      createdAt: now(),
      updatedAt: now(),
    },
  ];

  function readAll() {
    if (!fs.existsSync(FILE)) {
      const list = seed();
      writeAll(list);
      return list;
    }
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  }

  function writeAll(list) {
    writeFileAtomic(FILE, JSON.stringify(list, null, 2));
  }

  /** The panel never sees proxy passwords: `***` stands in, and PATCH accepts it back unchanged. */
  const redact = (url) => (url ? url.replace(/^([a-z0-9+.-]+:\/\/[^:@/]*:)[^@/]*@/i, "$1***@") : "");
  const pub = (t) => ({ ...t, proxy: redact(t.proxy) });

  const str = (v, max, what) => {
    if (typeof v !== "string") throw new Error(`${what} must be text`);
    return v.trim().slice(0, max);
  };

  /** Returns a clean template or throws a message fit for a 400. `base` is the stored one on PATCH. */
  function validate(input, base = {}) {
    const t = { ...base };
    if (input.name !== undefined) t.name = str(input.name, 40, "name");
    if (input.pattern !== undefined) t.pattern = str(input.pattern, 80, "pattern");
    if (input.folder !== undefined) t.folder = str(input.folder, 40, "folder");
    if (input.status !== undefined) t.status = str(input.status, 24, "status");
    if (input.notes !== undefined) t.notes = str(input.notes, 2000, "notes");
    if (input.tags !== undefined) t.tags = deps.cleanTags(input.tags);
    if (input.startUrls !== undefined) {
      const urls = [].concat(input.startUrls || []).map((u) => String(u).trim()).filter(Boolean);
      if (urls.length > 10 || !urls.every(deps.isWebUrl)) throw new Error("start pages must be up to 10 http(s) URLs");
      t.startUrls = urls;
    }
    if (input.proxyStrategy !== undefined) {
      if (!PROXY_STRATEGIES.includes(input.proxyStrategy)) throw new Error("proxyStrategy must be unused, unused-ok or specific");
      t.proxyStrategy = input.proxyStrategy;
    }
    if (input.proxy !== undefined) {
      let url = str(input.proxy, 300, "proxy");
      // The panel echoes the redacted URL back; keep the stored password behind it.
      if (base.proxy && url === redact(base.proxy)) url = base.proxy;
      t.proxy = url;
    }
    if (input.fptStrategy !== undefined) {
      if (!FPT_STRATEGIES.includes(input.fptStrategy)) throw new Error("fptStrategy must be unused or specific");
      t.fptStrategy = input.fptStrategy;
    }
    if (input.fingerprintFile !== undefined) t.fingerprintFile = str(input.fingerprintFile, 200, "fingerprintFile");
    if (input.isDefault !== undefined) t.isDefault = Boolean(input.isDefault);
    // Browser engine id; empty = the app's default (Settings → Browsers). Checked at create time.
    if (input.browser !== undefined) t.browser = str(input.browser, 80, "browser");

    if (!t.name) throw new Error("name is required");
    if (!t.pattern) throw new Error("pattern is required");
    const literal = t.pattern.replace(/\{n(?::\d+)?\}|\{date\}/g, "");
    if (/[{}]/.test(literal)) throw new Error("pattern may use {n}, {n:03} and {date}");
    if (/[<>:"/\\|?*]/.test(literal)) throw new Error('pattern cannot contain < > : " / \\ | ? *');
    t.proxyStrategy = t.proxyStrategy || "unused";
    t.fptStrategy = t.fptStrategy || "unused";
    if (t.proxyStrategy === "specific") {
      if (!t.proxy) throw new Error("a specific proxy needs a proxy URL");
      // Stored in URL form whatever layout was typed (host:port:user:pass …), so `redact`
      // always finds the password to mask.
      const p = manager.parseProxy(t.proxy); // throws its own readable message
      const enc = encodeURIComponent;
      const auth = p.username || p.password ? `${enc(p.username || "")}:${enc(p.password || "")}@` : "";
      t.proxy = `${p.scheme || "http"}://${auth}${p.host}:${p.port}`;
    } else {
      t.proxy = "";
    }
    if (t.fptStrategy === "specific") {
      if (!t.fingerprintFile) throw new Error("a specific fingerprint needs a file");
      if (!manager.listAllFingerprints().some((f) => f.file === t.fingerprintFile)) throw new Error("unknown fingerprint file");
    } else {
      t.fingerprintFile = "";
    }
    for (const k of ["folder", "status", "notes", "browser"]) if (t[k] === undefined) t[k] = "";
    t.tags = t.tags || [];
    t.startUrls = t.startUrls || [];
    return t;
  }

  /** Exactly one default: the flagged one wins, else the first. */
  function settleDefault(list, preferId) {
    let found = false;
    for (const t of list) {
      t.isDefault = !found && (preferId ? t.id === preferId : t.isDefault);
      found = found || t.isDefault;
    }
    if (!found && list.length) list[0].isDefault = true;
    return list;
  }

  const newId = () => "t-" + crypto.randomBytes(4).toString("hex");
  const publish = (list) => deps.broadcast("templates", list.map(pub));

  /* ---------------- name patterns ---------------- */

  const hasCounter = (pattern) => /\{n(?::\d+)?\}/.test(pattern);
  function expand(pattern, n) {
    const date = new Date().toISOString().slice(0, 10);
    return pattern
      .replace(/\{n(?::(\d+))?\}/g, (_, pad) => (pad ? String(n).padStart(Number(pad), "0") : String(n)))
      .replace(/\{date\}/g, date);
  }

  /** `count` free names for `pattern`; existing and trashed ids stay taken (case-insensitively). */
  function nextNames(pattern, count) {
    const taken = new Set([...manager.listSessions(), ...manager.listTrash()].map((s) => s.id.toLowerCase()));
    const names = [];
    if (!hasCounter(pattern)) return [expand(pattern, 1)]; // a fixed name; create() reports the clash
    for (let n = 1; names.length < count && n < 100000; n++) {
      const name = expand(pattern, n);
      if (taken.has(name.toLowerCase())) continue;
      taken.add(name.toLowerCase());
      names.push(name);
    }
    return names;
  }

  /* ---------------- proxy picking ---------------- */

  /** data/proxies.json (the proxy library's file) as parsed proxies; null when absent or empty. */
  function libraryProxies() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(PROXIES_FILE, "utf8"));
    } catch {
      return null;
    }
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.proxies) ? raw.proxies : [];
    if (!list.length) return null;
    const out = [];
    for (const e of list) {
      try {
        const p = e.url
          ? manager.parseProxy(e.url)
          : { scheme: e.scheme || "http", host: e.host, port: Number(e.port), username: e.username || "", password: e.password || "" };
        if (p.host && Number.isInteger(p.port)) out.push({ ...p, ok: e.check?.ok === true });
      } catch {
        // one bad entry must not block a create
      }
    }
    return out;
  }

  function boundProxyKeys() {
    const keys = new Set(manager.listAllProxies().filter((p) => p.isAssigned).map((p) => p.key));
    for (const s of [...manager.listSessions(), ...manager.listTrash()]) if (s.proxy) keys.add(`${s.proxy.host}:${s.proxy.port}`);
    return keys;
  }

  /* ---------------- routes ---------------- */

  const find = (list, id) => list.find((t) => t.id === id);

  app.get("/api/templates", (req, res) => res.json(readAll().map(pub)));

  app.post("/api/templates", (req, res) => {
    try {
      const list = readAll();
      const t = { ...validate(req.body || {}), id: newId(), createdAt: now(), updatedAt: now() };
      list.push(t);
      writeAll(settleDefault(list, t.isDefault ? t.id : undefined));
      publish(list);
      res.json(pub(t));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.patch("/api/templates/:id", (req, res) => {
    const list = readAll();
    const i = list.findIndex((t) => t.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: "template not found" });
    try {
      const t = { ...validate(req.body || {}, list[i]), id: list[i].id, createdAt: list[i].createdAt, updatedAt: now() };
      // Unsetting the default is ignored: one must always exist, and it should not silently move.
      if (list[i].isDefault) t.isDefault = true;
      list[i] = t;
      writeAll(settleDefault(list, t.isDefault ? t.id : undefined));
      publish(list);
      res.json(pub(list[i]));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete("/api/templates/:id", (req, res) => {
    const list = readAll();
    const t = find(list, req.params.id);
    if (!t) return res.status(404).json({ error: "template not found" });
    if (list.length === 1) return res.status(409).json({ error: "the last template cannot be deleted" });
    const next = settleDefault(list.filter((x) => x !== t));
    writeAll(next);
    publish(next);
    res.json({ ok: true, default: next.find((x) => x.isDefault).id });
  });

  app.post("/api/templates/:id/duplicate", (req, res) => {
    const list = readAll();
    const src = find(list, req.params.id);
    if (!src) return res.status(404).json({ error: "template not found" });
    const t = { ...src, id: newId(), name: `${src.name} copy`.slice(0, 40), isDefault: false, createdAt: now(), updatedAt: now() };
    list.push(t);
    writeAll(list);
    publish(list);
    res.json(pub(t));
  });

  app.post("/api/templates/:id/create", async (req, res) => {
    const t = find(readAll(), req.params.id);
    if (!t) return res.status(404).json({ error: "template not found" });
    const count = req.body?.count === undefined ? 1 : Number(req.body.count);
    if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
      return res.status(400).json({ error: `count must be an integer between 1 and ${MAX_COUNT}` });
    }
    if (count > 1 && !hasCounter(t.pattern)) return res.status(400).json({ error: "the pattern needs {n} to create several profiles" });
    if (count > 1 && (t.proxyStrategy === "specific" || t.fptStrategy === "specific")) {
      return res.status(400).json({ error: "a specific proxy or fingerprint can only be used by one profile" });
    }
    let folder = t.folder;
    if (req.body?.folder !== undefined) {
      if (typeof req.body.folder !== "string") return res.status(400).json({ error: "folder must be text" });
      folder = req.body.folder.trim().slice(0, 40);
    }

    // 'unused-ok' falls back to the plain pool when there is no proxy library yet.
    const library = t.proxyStrategy === "unused-ok" ? libraryProxies() : null;
    const bound = library ? boundProxyKeys() : null;
    const patch = {};
    if (t.tags.length) patch.tags = t.tags;
    if (t.status) patch.label = t.status;
    if (folder) patch.folder = folder;
    if (t.startUrls.length) patch.startUrls = t.startUrls;
    if (t.notes) patch.notes = t.notes;

    const created = [];
    const skipped = [];
    for (const name of nextNames(t.pattern, count)) {
      try {
        const extras = { email: name, mustBeNew: true };
        if (t.proxyStrategy === "specific") extras.proxy = manager.parseProxy(t.proxy);
        else if (library) {
          const free = library.find((p) => p.ok && !bound.has(`${p.host}:${p.port}`));
          if (!free) throw new Error("no checked, unbound proxies left in the proxy library");
          bound.add(`${free.host}:${free.port}`);
          extras.proxy = { scheme: free.scheme, host: free.host, port: free.port, username: free.username, password: free.password };
        }
        if (t.fptStrategy === "specific") extras.fingerprintFile = t.fingerprintFile;
        if (t.browser) extras.browser = await require("../browsers").validId(t.browser);
        let rec = await manager.createSessionRecord(name, extras);
        if (Object.keys(patch).length) rec = await manager.saveSessionPatch(rec.id, patch);
        created.push(rec);
      } catch (err) {
        skipped.push({ name, error: err.message });
      }
    }
    deps.log(
      skipped.length ? "warn" : "info",
      "SESSION",
      `Template "${t.name}": created ${created.length} profile(s)${skipped.length ? `, ${skipped.length} skipped (${skipped[0].error})` : ""}`,
      created.length === 1 ? created[0].id : undefined
    );
    res.json({ created: created.map(manager.publicRecord), skipped });
  });
};
