import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, CircleHelp, Monitor, Moon, Sun } from 'lucide-react';
import { Brand, Rail, TAB_ORDER } from './components/Rail';
import { ProfilesView } from './components/ProfilesView';
import { ProfileDrawer } from './components/ProfileDrawer';
import { FingerprintPanel } from './components/FingerprintPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { ConsoleDock } from './components/ConsoleDock';
import { NewSessionModal, SpecsModal } from './components/Modals';
import { ShortcutHelper } from './components/ShortcutHelper';
import { ZoomControl } from './components/ZoomControl';
import { clampZoom, stepZoom } from './zoom';
import { HomeView } from './features/home';
import { AutomationView } from './features/automation';
import { ProxiesView } from './features/proxies';
import { ApiView } from './features/apidocs';
import { UIProvider, useStored, useUI } from './ui';
import { FaceHuddle } from './faces';
import { AppCtx, type AppState, type Tab } from './app-context';
import { renderSlot } from './contributions';
import { api, MAX_THREADS, type AppSettings, type BulkAction } from './api';
import { ACCENTS } from './types';
import type {
  FingerprintResource,
  LogEntry,
  PoolStatus,
  ProxyResource,
  Script,
  ScriptDraft,
  ScriptRun,
  SessionRecord,
  Theme,
  TrashItem,
} from './types';

const LOG_BUFFER = 500;
const THEME_ICON = { dark: Moon, light: Sun, system: Monitor };

const Panel: React.FC = () => {
  const { toast, confirm } = useUI();

  const [storedTab, setStoredTab] = useStored<string>('tab', 'home');
  // 'scripts' is what older panels stored for today's Automation section.
  const tab: Tab = storedTab === 'scripts' ? 'automation' : TAB_ORDER.includes(storedTab as Tab) ? (storedTab as Tab) : 'home';
  const [pageSize, setPageSize] = useStored<number>('pageSize', 50);
  const [launchUrl, setLaunchUrl] = useStored<string>('url', '');
  const [dock, setDock] = useStored<'closed' | 'normal' | 'tall'>('dock', 'closed');
  const [theme, setTheme] = useStored<Theme>('theme', 'dark');
  const [storedZoom, setZoom] = useStored<number>('zoom', 1);
  const zoom = clampZoom(Number(storedZoom) || 1);
  const [accent, setAccent] = useStored<string>('accent', 'emerald');
  const [railPref, setRailPref] = useStored<'open' | 'collapsed'>('rail', 'open');

  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [trash, setTrash] = useState<TrashItem[]>([]);
  const [pool, setPool] = useState<PoolStatus | null>(null);
  const [proxies, setProxies] = useState<ProxyResource[]>([]);
  const [fingerprints, setFingerprints] = useState<FingerprintResource[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [scripts, setScripts] = useState<Script[]>([]);
  const [runs, setRuns] = useState<ScriptRun[]>([]);

  const [query, setQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [launching, setLaunching] = useState<string[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [connected, setConnected] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [openId, setOpenId] = useState<string | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [quit, setQuit] = useState(false);
  // The drawer reports unsaved edits so switching profile or closing can ask first.
  const drawerDirty = useRef(false);
  const onDrawerDirty = useCallback((d: boolean) => {
    drawerDirty.current = d;
  }, []);
  // Changes when the server restarts, so a reconnect can tell a restart from a network blip.
  const bootId = useRef<string | null>(null);
  const loadFailed = useRef(false);
  const [newOpen, setNewOpen] = useState(false);
  const [specs, setSpecs] = useState<{ title: string; fp: unknown } | null>(null);
  const [showKeys, setShowKeys] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);
  const threadLimit = pool?.threadLimit ?? 5;
  const openSession = sessions.find((s) => s.id === openId) || null;
  const allTags = useMemo(() => [...new Set(sessions.flatMap((s) => s.tags || []))].sort(), [sessions]);

  /* ---------------- appearance ---------------- */

  // Window width, for the sidebar collapse. Compared in the panel's own pixels (after zoom):
  // a media query would see the unzoomed window and keep the sidebar open at 150%.
  const [winWidth, setWinWidth] = useState(() => window.innerWidth);
  const [systemLight, setSystemLight] = useState(() => matchMedia('(prefers-color-scheme: light)').matches);
  useEffect(() => {
    const scheme = matchMedia('(prefers-color-scheme: light)');
    const onResize = () => setWinWidth(window.innerWidth);
    const onScheme = () => setSystemLight(scheme.matches);
    window.addEventListener('resize', onResize);
    scheme.addEventListener('change', onScheme);
    return () => {
      window.removeEventListener('resize', onResize);
      scheme.removeEventListener('change', onScheme);
    };
  }, []);
  const narrow = winWidth / zoom <= 1100;
  // The sidebar collapses on its own in a narrow window; the preference applies otherwise.
  const collapsed = narrow || railPref === 'collapsed';

  // Layout effect: the theme and accent land before the first paint, not one frame after.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme === 'system' ? (systemLight ? 'light' : 'dark') : theme;
    const a = ACCENTS.find((x) => x.id === accent) || ACCENTS[0];
    root.style.setProperty('--accent', a.color);
    root.style.setProperty('--accent-ink', a.ink);
  }, [theme, accent, systemLight]);

  // Panel zoom: CSS zoom on <html> (index.html applies it before the first paint too).
  // Fixed-position maths converts through ./zoom, so menus and popovers stay anchored.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.zoom = zoom === 1 ? '' : String(zoom);
    root.style.setProperty('--z', String(zoom));
  }, [zoom]);

  // Ctrl + / − / 0 and Ctrl + scroll zoom the panel from anywhere, dialogs included.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const dir = ['=', '+'].includes(e.key) || e.code === 'NumpadAdd' ? 1 : ['-', '_'].includes(e.key) || e.code === 'NumpadSubtract' ? -1 : 0;
      if (dir) {
        e.preventDefault();
        setZoom((z) => stepZoom(clampZoom(Number(z) || 1), dir));
      } else if (e.key === '0' || e.code === 'Numpad0') {
        e.preventDefault();
        setZoom(1);
      }
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom((z) => stepZoom(clampZoom(Number(z) || 1), e.deltaY < 0 ? 1 : -1));
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', onWheel);
    };
  }, [setZoom]);

  /* ---------------- data ---------------- */

  const refreshSessions = useCallback(() => api.getSessions().then(setSessions).catch(() => {}), []);
  const refreshTrash = useCallback(() => api.getTrash().then(setTrash).catch(() => {}), []);
  const refreshScripts = useCallback(() => api.getScripts().then(setScripts).catch(() => {}), []);
  const refreshApp = useCallback(() => api.getApp().then(setAppSettings).catch(() => {}), []);
  const refreshResources = useCallback(
    () =>
      api
        .getResources()
        .then((r) => {
          setProxies(r.proxies || []);
          setFingerprints(r.fingerprints || []);
        })
        .catch(() => {}),
    []
  );

  const loadAll = useCallback(async () => {
    const [s, p, res, lg, sc, tr, rn, ap] = await Promise.allSettled([
      api.getSessions(),
      api.getPool(),
      api.getResources(),
      api.getLogs(150),
      api.getScripts(),
      api.getTrash(),
      api.getRuns(),
      api.getApp(),
    ]);
    const failed: string[] = [];
    if (s.status === 'fulfilled') setSessions(s.value);
    else failed.push('profiles');
    if (p.status === 'fulfilled') setPool(p.value);
    if (res.status === 'fulfilled') {
      setProxies(res.value.proxies || []);
      setFingerprints(res.value.fingerprints || []);
    } else failed.push('resources');
    if (lg.status === 'fulfilled') setLogs(lg.value);
    if (sc.status === 'fulfilled') setScripts(sc.value);
    if (tr.status === 'fulfilled') setTrash(tr.value);
    if (rn.status === 'fulfilled') setRuns(rn.value);
    if (ap.status === 'fulfilled') setAppSettings(ap.value);
    // A failed fetch is not an empty inventory; never render it as one.
    loadFailed.current = failed.length > 0;
    setLoadError(failed.length ? `Could not load ${failed.join(' and ')}` : null);
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const upsertRun = useCallback(
    (run: ScriptRun) => setRuns((prev) => [run, ...prev.filter((r) => r.id !== run.id)].slice(0, 30)),
    []
  );

  // Features subscribe to message types they own; every message is offered to them.
  const listeners = useRef(new Map<string, Set<(data: any) => void>>());
  const onEvent = useCallback((type: string, handler: (data: any) => void) => {
    let set = listeners.current.get(type);
    if (!set) {
      set = new Set();
      listeners.current.set(type, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }, []);

  // Live stream. Reconnects on drop; subscribes once.
  useEffect(() => {
    const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let quitting = false;
    const connect = () => {
      ws = new WebSocket(url);
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => {
        let msg: { type: string; data: any };
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.type === 'hello') {
          // After a server restart old log ids restart at 1 and old runs are gone: start fresh.
          const restarted = !!bootId.current && bootId.current !== msg.data.bootId;
          if (restarted) setLogs([]);
          // Reload what a restart (or a backend that was down at first load) left stale.
          if (restarted || loadFailed.current) loadAll();
          bootId.current = msg.data.bootId;
          setRuns(msg.data.runs || []);
        } else if (msg.type === 'quit') {
          // Quit from the tray or another window. The window closes once the server is gone.
          quitting = true;
          setQuit(true);
        } else if (msg.type === 'pool') {
          setPool(msg.data);
          refreshSessions();
        } else if (msg.type === 'session') {
          refreshSessions();
        } else if (msg.type === 'app') {
          setAppSettings(msg.data);
        } else if (msg.type === 'log') {
          setLogs((prev) => [...prev.slice(-(LOG_BUFFER - 1)), msg.data]);
        } else if (msg.type === 'logs') {
          // Reconnect backfill: merge, never replace a longer local buffer.
          setLogs((prev) => {
            const seen = new Set(prev.map((l) => l.id));
            return [...prev, ...(msg.data as LogEntry[]).filter((l) => !seen.has(l.id))].slice(-LOG_BUFFER);
          });
        } else if (msg.type === 'run') {
          upsertRun(msg.data);
        }
        listeners.current.get(msg.type)?.forEach((h) => {
          try {
            h(msg.data);
          } catch (err) {
            console.error(`[${msg.type}] handler failed`, err);
          }
        });
      };
      ws.onclose = () => {
        if (closed) return;
        setConnected(false);
        // Closes the desktop app window; a normal browser tab ignores it and keeps the notice.
        if (quitting) return window.close();
        timer = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [refreshSessions, upsertRun, loadAll]);

  // Drop selections for profiles that no longer exist; close a drawer whose profile left.
  useEffect(() => {
    const alive = new Set(sessions.map((s) => s.id));
    setSelectedIds((prev) => (prev.every((id) => alive.has(id)) ? prev : prev.filter((id) => alive.has(id))));
    if (openId && !alive.has(openId)) setOpenId(null);
  }, [sessions, openId]);

  // Search is per view.
  const [queriedTab, setQueriedTab] = useState(tab);
  if (queriedTab !== tab) {
    setQueriedTab(tab);
    setQuery('');
  }

  /* ---------------- actions ---------------- */

  const launch = useCallback(
    async (ids: string[]) => {
      if (!ids.length) return;
      if (launchUrl.trim() && !/^https?:\/\//i.test(launchUrl.trim())) {
        toast('error', 'Start URL must begin with http:// or https://');
        return;
      }
      setLaunching((prev) => [...new Set([...prev, ...ids])]);
      try {
        // Send '' rather than omitting it: '' clears a URL remembered from an earlier launch.
        await api.launchSessions(ids, threadLimit, launchUrl.trim());
        toast('success', `Queued ${ids.length} profile${ids.length > 1 ? 's' : ''}`);
      } catch (err: any) {
        toast('error', err.message);
      } finally {
        setLaunching((prev) => prev.filter((id) => !ids.includes(id)));
      }
    },
    [threadLimit, launchUrl, toast]
  );

  // Steps accumulate against the pending value; a burst becomes one write.
  const pendingLimit = useRef<number | null>(null);
  const limitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stepThreadLimit = (delta: 1 | -1) => setThreadLimit((pendingLimit.current ?? threadLimit) + delta);
  const setThreadLimit = (n: number) => {
    const next = Math.min(MAX_THREADS, Math.max(1, n));
    pendingLimit.current = next;
    setPool((p) => (p ? { ...p, threadLimit: next } : p));
    if (limitTimer.current) clearTimeout(limitTimer.current);
    limitTimer.current = setTimeout(async () => {
      pendingLimit.current = null;
      try {
        setPool(await api.setThreadLimit(next));
      } catch (err: any) {
        toast('error', err.message);
        loadAll();
      }
    }, 300);
  };

  const stop = useCallback(
    async (id: string) => {
      await api.stopSession(id).catch((err) => toast('error', err.message));
    },
    [toast]
  );

  const stopAll = useCallback(async () => {
    const ok = await confirm({ title: 'Stop every running window?', body: 'Cookies are saved first.', confirmLabel: 'Stop all', danger: true });
    if (ok) await api.stopAllSessions().catch((err) => toast('error', err.message));
  }, [confirm, toast]);

  const bulk = useCallback(
    async (ids: string[], action: BulkAction, value?: unknown) => {
      try {
        const r = await api.bulk(ids, action, value);
        const verb =
          ({ tag: 'Tagged', untag: 'Untagged', label: 'Labelled', status: 'Status set on', folder: 'Moved', stop: 'Stopping', trash: 'Moved to trash:', browser: 'Browser set on' } as Record<string, string>)[action] ||
          'Done:';
        if (r.failed.length) toast('error', `${r.failed.length} failed: ${r.failed[0].error}`);
        else toast('success', `${verb} ${r.ok}`);
        if (action === 'trash') {
          setSelectedIds((prev) => prev.filter((id) => !ids.includes(id)));
          refreshTrash();
        }
        await refreshSessions();
      } catch (err: any) {
        toast('error', err.message);
      }
    },
    [toast, refreshTrash, refreshSessions]
  );

  const runScript = useCallback(
    async (target: { scriptId: string } | { draft: ScriptDraft }, ids: string[]) => {
      try {
        const run = await api.runScript(target, ids);
        // Fast scripts finish before this response lands, so the socket may already have
        // delivered newer states. The response only seeds a run the socket hasn't reported.
        setRuns((prev) => (prev.some((r) => r.id === run.id) ? prev : [run, ...prev].slice(0, 30)));
        toast('info', `Running “${run.scriptName}” on ${ids.length}`);
        return run;
      } catch (err: any) {
        toast('error', err.message);
        return null;
      }
    },
    [toast]
  );

  const restore = async (id: string) => {
    try {
      await api.restore(id);
      toast('success', `Restored ${id}`);
      await Promise.all([refreshTrash(), refreshSessions()]);
    } catch (err: any) {
      toast('error', err.message);
    }
  };

  const purge = async (id: string) => {
    try {
      await api.purge(id);
      await Promise.all([refreshTrash(), loadAll()]);
    } catch (err: any) {
      toast('error', err.message);
    }
  };

  const emptyTrash = async () => {
    try {
      const r = await api.emptyTrash();
      toast('success', `Deleted ${r.purged.length} forever`);
      await loadAll();
    } catch (err: any) {
      toast('error', err.message);
    }
  };

  const syncSheet = async () => {
    setIsSyncing(true);
    try {
      const r = await api.syncSheet();
      toast('success', `Sheet synced — ${r.created} new, ${r.updated} updated`);
      await loadAll();
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setIsSyncing(false);
    }
  };

  const trashOne = async (id: string) => {
    const ok = await confirm({
      title: `Move ${id} to trash?`,
      body: 'Kept for 48 hours with its proxy and fingerprint reserved.',
      confirmLabel: 'Move to trash',
      danger: true,
    });
    if (ok) await bulk([id], 'trash');
  };

  // Switching profile, closing the drawer or leaving the tab asks before discarding unsaved
  // edits. Resolves false when the user keeps editing.
  const openProfile = useCallback(
    async (id: string | null) => {
      if (id === openId) return true;
      if (openId && drawerDirty.current) {
        const ok = await confirm({ title: 'Discard unsaved changes?', confirmLabel: 'Discard', danger: true });
        if (!ok) return false;
      }
      drawerDirty.current = false;
      setOpenId(id);
      return true;
    },
    [openId, confirm]
  );

  const switchTab = useCallback(
    async (next: Tab) => {
      if (next !== tab && (await openProfile(null))) setStoredTab(next);
    },
    [tab, openProfile, setStoredTab]
  );

  const changeApp = useCallback(
    async (patch: Partial<AppSettings>) => {
      try {
        setAppSettings(await api.patchApp(patch));
      } catch (err: any) {
        toast('error', err.message);
      }
    },
    [toast]
  );

  const quitApp = async () => {
    const live = pool?.activeCount ?? 0;
    const ok = await confirm({
      title: 'Quit SessionManagerPro?',
      body: live
        ? `${live} running browser${live > 1 ? 's' : ''} will close. Cookies are saved first.`
        : 'The app and its tray icon will close.',
      confirmLabel: 'Quit',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.quitApp();
      setQuit(true); // the server's 'quit' message closes the window once it has exited
    } catch (err: any) {
      toast('error', err.message);
    }
  };

  const cycleTheme = () => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark');

  /* ---------------- keyboard ---------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A dialog or the drawer owns the keyboard; both handle their own Escape.
      if (document.querySelector('.scrim, .drawer')) return;
      const typing = !!(e.target as HTMLElement)?.closest?.('input, textarea, select');
      const mod = e.ctrlKey || e.metaKey;
      // Shift+1…7 switch sections — never while typing, where Shift+digit is ! @ # $ % ^ &.
      if (!typing && e.shiftKey && !mod && !e.altKey && /^Digit[1-7]$/.test(e.code)) {
        const next = TAB_ORDER[Number(e.code.slice(5)) - 1];
        if (next) {
          e.preventDefault();
          switchTab(next);
        }
        return;
      }
      if (typing) return;
      if (e.key === '?') {
        setShowKeys((v) => !v);
      } else if (e.key === 'Escape') {
        setSelectedIds([]);
      } else if (e.key === '/' || (mod && (e.key === 'k' || e.key === 'f'))) {
        // Whichever view is open marks its search box with data-search.
        const box = document.querySelector<HTMLInputElement>('input[data-search]');
        if (!box) return;
        e.preventDefault();
        box.focus();
        box.select();
      } else if (mod && e.key === 'Enter' && tab === 'profiles' && selectedIds.length) {
        e.preventDefault();
        launch(selectedIds);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedIds, launch, tab, switchTab]);

  /* ---------------- shared state ---------------- */

  // Its own stable object: features key effects on it, and it must not change with every log line.
  const refresh = useMemo(
    () => ({
      all: loadAll,
      sessions: refreshSessions,
      trash: refreshTrash,
      scripts: refreshScripts,
      resources: refreshResources,
      app: refreshApp,
    }),
    [loadAll, refreshSessions, refreshTrash, refreshScripts, refreshResources, refreshApp]
  );

  const state: AppState = useMemo(
    () => ({
      tab,
      setTab: switchTab,
      sessions,
      trash,
      pool,
      proxies,
      fingerprints,
      scripts,
      runs,
      logs,
      app: appSettings,
      connected,
      selectedIds,
      setSelectedIds,
      openId,
      openProfile,
      openNew: () => setNewOpen(true),
      refresh,
      launch,
      stop,
      stopAll,
      bulk,
      runScript,
      changeApp,
      onEvent,
    }),
    [
      tab,
      switchTab,
      sessions,
      trash,
      pool,
      proxies,
      fingerprints,
      scripts,
      runs,
      logs,
      appSettings,
      connected,
      selectedIds,
      openId,
      openProfile,
      refresh,
      launch,
      stop,
      stopAll,
      bulk,
      runScript,
      changeApp,
      onEvent,
    ]
  );

  /* ---------------- render ---------------- */

  if (quit) {
    return (
      <div className="quit-screen" role="status">
        <FaceHuddle mood="calm" />
        <h1>SessionManagerPro has quit</h1>
        <p className="hint">All browsers were closed and their cookies saved. You can close this window.</p>
      </div>
    );
  }

  const ThemeIcon = THEME_ICON[theme];
  const liveCount = pool?.activeCount ?? 0;

  return (
    <AppCtx.Provider value={state}>
      <div className="app" data-rail={collapsed ? 'collapsed' : 'open'}>
        <header className="appbar">
          <Brand />
          <span className="grow" />
          {liveCount > 0 && (
            <button className="chip-live" onClick={() => switchTab('home')} title="Open Home">
              <span className="dot" />
              {liveCount} running
            </button>
          )}
          {!connected && (
            <span className="chip-off" role="status">
              Reconnecting…
            </span>
          )}
          <ZoomControl zoom={zoom} onZoom={setZoom} />
          <button className="icon-btn" onClick={cycleTheme} aria-label={`Theme: ${theme}. Click to change`} data-tip={`Theme: ${theme}`}>
            <ThemeIcon size={16} strokeWidth={1.8} />
          </button>
          <button className="icon-btn" onClick={() => setShowKeys(true)} aria-label="Keyboard shortcuts" data-tip="Shortcuts">
            <CircleHelp size={16} strokeWidth={1.8} />
          </button>
        </header>

        <Rail
          tab={tab}
          onTab={switchTab}
          liveCount={liveCount}
          connected={connected}
          logOpen={dock !== 'closed'}
          onToggleLog={() => setDock(dock === 'closed' ? 'normal' : 'closed')}
          onRefresh={loadAll}
          collapsed={collapsed}
          onCollapse={(c) => setRailPref(c ? 'collapsed' : 'open')}
        />

        <main
          className="main"
          // Floating bars (bulk actions) sit above the log dock rather than on top of it.
          style={{ '--dock-h': { closed: '0px', normal: '260px', tall: 'calc(var(--vh) * 0.55)' }[dock] } as React.CSSProperties}
        >
          {loadError && (
            <div className="banner" role="alert">
              <CircleAlert size={14} /> {loadError} — is the backend running?
              <button className="btn xs" onClick={loadAll}>
                Retry
              </button>
            </div>
          )}

          {tab === 'home' && <HomeView active />}
          {tab === 'profiles' && (
            <ProfilesView
              sessions={sessions}
              trash={trash}
              pool={pool}
              scripts={scripts}
              query={query}
              onQuery={setQuery}
              searchRef={searchRef}
              selectedIds={selectedIds}
              onSelect={setSelectedIds}
              launchingIds={launching}
              openId={openId}
              onOpen={(s) => openProfile(s.id)}
              onNew={() => setNewOpen(true)}
              onLaunch={launch}
              onStop={stop}
              onStopAll={stopAll}
              threadLimit={threadLimit}
              onThreadStep={stepThreadLimit}
              onThreadSet={setThreadLimit}
              launchUrl={launchUrl}
              onLaunchUrl={setLaunchUrl}
              onBulk={bulk}
              onRunScript={(scriptId, ids) => runScript({ scriptId }, ids)}
              onRestore={restore}
              onPurge={purge}
              onEmptyTrash={emptyTrash}
              pageSize={pageSize}
              onPageSize={setPageSize}
            />
          )}
          {/* Kept mounted so an unsaved script survives a trip to another tab. */}
          <div style={{ display: tab === 'automation' ? 'contents' : 'none' }}>
            <AutomationView active={tab === 'automation'} />
          </div>
          {tab === 'proxies' && <ProxiesView active />}
          {tab === 'fingerprints' && (
            <FingerprintPanel
              fingerprints={fingerprints}
              query={query}
              onQuery={setQuery}
              searchRef={searchRef}
              onInspect={(f) => setSpecs({ title: f.file, fp: f })}
              onRefresh={loadAll}
              pageSize={pageSize}
              onPageSize={setPageSize}
            />
          )}
          {tab === 'api' && <ApiView active />}
          {tab === 'settings' && (
            <SettingsPanel
              theme={theme}
              onTheme={setTheme}
              accent={accent}
              onAccent={setAccent}
              app={appSettings}
              onApp={changeApp}
              onQuit={quitApp}
              onRefresh={loadAll}
              onSync={syncSheet}
              isSyncing={isSyncing}
            />
          )}

          {dock !== 'closed' && (
            <ConsoleDock logs={logs} onClear={() => setLogs([])} size={dock} onSize={setDock} connected={connected} />
          )}
        </main>

        {/* Always mounted, wherever you are, and takes no space: the leak-check dialog lives here. */}
        <div className="slot-host">{renderSlot('statusItems')}</div>

        {openSession && (
          <ProfileDrawer
            key={openSession.id}
            session={openSession}
            proxies={proxies}
            fingerprints={fingerprints}
            allTags={allTags}
            launching={launching.includes(openSession.id)}
            onClose={() => openProfile(null)}
            onSaved={() => loadAll()}
            onDirtyChange={onDrawerDirty}
            onLaunch={() => launch([openSession.id])}
            onStop={() => stop(openSession.id)}
            onTrash={() => trashOne(openSession.id)}
          />
        )}

        {newOpen && (
          <NewSessionModal
            onClose={() => setNewOpen(false)}
            proxies={proxies}
            fingerprints={fingerprints}
            onCreateSingle={async (name, proxyKey, fpt, browser) => {
              try {
                await api.createSession({ name, proxyKey, fingerprintFile: fpt, browser });
                toast('success', `Created ${name}`);
              } finally {
                await loadAll();
              }
            }}
            onCreateBatch={async (count, prefix) => {
              try {
                const r = await api.autoGenerateSessions(count, prefix);
                toast('success', `Created ${r.created.length} profiles`);
              } finally {
                await loadAll();
              }
            }}
          />
        )}

        {specs && <SpecsModal title={specs.title} fp={specs.fp} onClose={() => setSpecs(null)} />}
        {showKeys && <ShortcutHelper onClose={() => setShowKeys(false)} />}
      </div>
    </AppCtx.Provider>
  );
};

export const App: React.FC = () => (
  <UIProvider>
    <Panel />
  </UIProvider>
);

export default App;
