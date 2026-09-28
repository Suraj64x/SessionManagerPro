// Home overview: one cheap summary — what is running, what broke, what is next. Reads
// files and in-memory state only: no network, no browser calls. See README.md for deps.
module.exports = function register(app, deps) {
  const { orchestrator, manager, scripts } = deps;
  // listAllProxies() is backed by the proxy feature's data/proxies.json, whose entries carry
  // check: { ok, at } | null. A proxy never checked (or a store without checks) is unchecked.
  function proxySummary() {
    const all = manager.listAllProxies();
    let ok = 0;
    let failed = 0;
    for (const p of all) {
      if (p.check?.ok) ok += 1;
      else if (p.check) failed += 1;
    }
    return { total: all.length, assigned: all.filter((p) => p.isAssigned).length, ok, failed, unchecked: all.length - ok - failed };
  }

  function runSummary(run) {
    const counts = { ok: 0, error: 0, stopped: 0, pending: 0 };
    let end = 0;
    for (const r of Object.values(run.results)) {
      const k = r.state === "running" ? "pending" : r.state;
      if (k in counts) counts[k] += 1;
      if (r.startedAt && r.ms != null) end = Math.max(end, new Date(r.startedAt).getTime() + r.ms);
    }
    return {
      id: run.id,
      scriptName: run.scriptName,
      mode: run.mode,
      startedAt: run.startedAt,
      cancelled: run.cancelled,
      targets: Object.keys(run.results).length,
      ...counts,
      // Wall time to the last result. null while a target is still going, or when no result
      // carries timing (a run refused because nothing was live).
      ms: counts.pending || !end ? null : Math.max(0, end - new Date(run.startedAt).getTime()),
    };
  }

  app.get("/api/home", (req, res) => {
    const sessions = manager.listSessions();
    const pool = orchestrator.getStatus();
    const live = new Set(pool.live.map((l) => l.id));
    const queued = new Set(pool.queued);
    const stats = manager.getSystemStats();
    res.json({
      profiles: {
        total: sessions.length,
        live: live.size,
        queued: queued.size,
        // Same rule as /api/sessions: a failure only shows while the profile is idle.
        errors: sessions.filter((s) => !live.has(s.id) && !queued.has(s.id) && s.lastResult?.status === "error").length,
        trash: manager.listTrash().length,
      },
      proxies: proxySummary(),
      fingerprints: { total: stats.fingerprintsTotal, free: stats.fingerprintsFree },
      recentRuns: scripts.recentRuns().slice(0, 8).map(runSummary),
      problems: orchestrator.getLogs(300).filter((l) => l.level === "warn" || l.level === "error").slice(-10),
    });
  });
};
