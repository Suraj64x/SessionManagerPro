// Statuses and folders: app settings + bulk actions. See README.md in this folder for deps.
//
// A profile's status is its `label`; its folder is its `folder`. Both fields are already
// accepted by PATCH /api/sessions/:id, so this module only owns the two lists and the
// bulk actions that set them.

const DEFAULT_STATUSES = [
  { name: "New", color: "#94a3b8" },
  { name: "Warming", color: "#f5b544" },
  { name: "Ready", color: "#22d3ee" },
  { name: "Active", color: "#34d399" },
  { name: "Banned", color: "#f43f5e" },
];
const MIGRATED_COLOR = "#94a3b8";
const MAX_STATUSES = 30;

function validStatuses(v) {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_STATUSES) {
    throw new Error(`statuses must be a list of 1-${MAX_STATUSES} entries`);
  }
  const seen = new Set();
  return v.map((s) => {
    const name = String(s?.name ?? "").trim();
    const color = String(s?.color ?? "").trim().toLowerCase();
    if (!name || name.length > 24) throw new Error("a status name is 1-24 characters");
    if (!/^#[0-9a-f]{6}$/.test(color)) throw new Error(`status "${name}" needs a #rrggbb colour`);
    // Labels are matched case-insensitively, so "active" and "Active" cannot both exist.
    if (seen.has(name.toLowerCase())) throw new Error(`duplicate status "${name}"`);
    seen.add(name.toLowerCase());
    return { name, color };
  });
}

function validFolders(v) {
  if (!Array.isArray(v)) throw new Error("folders must be a list");
  const seen = new Set();
  return v.map((f) => {
    const name = String(f ?? "").trim();
    if (!name || name.length > 40) throw new Error("a folder name is 1-40 characters");
    if (seen.has(name.toLowerCase())) throw new Error(`duplicate folder "${name}"`);
    seen.add(name.toLowerCase());
    return name;
  });
}

module.exports = function register(app, deps) {
  deps.appSettings.register("statuses", DEFAULT_STATUSES, validStatuses);
  deps.appSettings.register("folders", [], validFolders);

  // Labels that predate the list become statuses (grey), so nothing on a profile is
  // invisible in the picker. Deferred one tick so the boot log shows it after "features loaded".
  setImmediate(() => {
    try {
      const current = deps.appSettings.read();
      const known = new Set(current.statuses.map((s) => s.name.toLowerCase()));
      const extra = [];
      for (const rec of deps.manager.listSessions()) {
        const label = String(rec.label || "").trim();
        if (!label || known.has(label.toLowerCase()) || current.statuses.length + extra.length >= MAX_STATUSES) continue;
        known.add(label.toLowerCase());
        extra.push({ name: label.slice(0, 24), color: MIGRATED_COLOR });
      }
      if (extra.length) {
        deps.appSettings.write({ statuses: [...current.statuses, ...extra] });
        deps.log("info", "SESSION", `Statuses: added ${extra.map((s) => s.name).join(", ")} from existing labels`);
      }
    } catch (err) {
      console.error("[organize] status migration failed:", err.message);
    }
  });

  deps.bulk.status = (rec, value) =>
    deps.manager.saveSessionPatch(rec.id, { label: String(value || "").trim().slice(0, 24) });

  // Only a folder from the list (or none): the strip cannot show an orphan.
  deps.bulk.folder = (rec, value) => {
    const folder = String(value || "").trim().slice(0, 40);
    if (folder && !deps.readApp().folders.includes(folder)) throw new Error(`unknown folder: ${folder}`);
    return deps.manager.saveSessionPatch(rec.id, { folder });
  };
};

module.exports.DEFAULT_STATUSES = DEFAULT_STATUSES;
