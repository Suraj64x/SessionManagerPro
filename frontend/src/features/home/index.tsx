import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, CircleAlert, CircleCheck, Clock, Code2, Earth, Fingerprint, PlayCircle, Plus, Square, Users } from 'lucide-react';
import type { Contributions } from '../../contributions';
import { renderSlot } from '../../contributions';
import { useApp, useEvent } from '../../app-context';
import type { LogEntry, PoolStatus, SessionRecord } from '../../types';
import { Avatar, Empty, Toolbar, ago, useElapsed } from '../../ui';
import { FaceHuddle } from '../../faces';
import { homeApi } from './api';
import type { HomeRun, HomeSummary } from './types';
import './home.css';

const fmtMs = (ms: number | null) => {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}:${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}`;
};
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// Home overview: what is running, what broke, what is next.
export const HomeView: React.FC<{ active: boolean }> = ({ active }) => {
  const { sessions, pool, setTab, openNew, stopAll, refresh } = useApp();
  const [summary, setSummary] = useState<HomeSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A stale answer never overwrites a newer one.
  const seq = useRef(0);
  const sessionCount = useRef(sessions.length);
  useEffect(() => {
    sessionCount.current = sessions.length;
  }, [sessions.length]);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const s = await homeApi.summary();
      if (n !== seq.current) return;
      setSummary(s);
      setError(null);
      // A profile created or restored outside the panel (API, curl) sends no session event;
      // the list must know it for a problem line to open its drawer.
      if (s.profiles.total !== sessionCount.current) refresh.sessions();
    } catch (err: any) {
      if (n === seq.current) setError(err.message);
    }
  }, [refresh]);

  // Events come in bursts (a launch fires pool, session and log together): one fetch per burst.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(active);
  const schedule = useCallback(
    (delay = 300) => {
      if (!activeRef.current) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(load, delay);
    },
    [load]
  );

  useEffect(() => {
    activeRef.current = active;
    // Through the timer, not a direct call: it merges with any event burst of the same tick.
    if (active) schedule(0);
  }, [active, schedule]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  useEvent('pool', () => schedule());
  useEvent('session', () => schedule());
  useEvent('run', () => schedule());
  useEvent('log', (l: LogEntry) => {
    if (l.level === 'warn' || l.level === 'error') schedule();
  });

  const live = pool?.live ?? [];
  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);

  return (
    <>
      <Toolbar title="Home">
        <button className="btn" onClick={() => setTab('proxies')}>
          <Earth size={13} /> Add proxies
        </button>
        <button className="btn" onClick={() => setTab('automation')}>
          <Code2 size={13} /> New script
        </button>
        <button className="btn primary" onClick={openNew}>
          <Plus size={14} /> New profile
        </button>
      </Toolbar>

      <div className="view home">
        {error && (
          <div className="alert" role="alert">
            <CircleAlert size={14} />
            <span className="grow">Could not load the overview — {error}</span>
            <button className="btn xs" onClick={load}>
              Retry
            </button>
          </div>
        )}

        {!summary ? (
          !error && (
            <p className="hint" role="status">
              Loading…
            </p>
          )
        ) : summary.profiles.total === 0 ? (
          <Setup s={summary} />
        ) : (
          <>
            <Tiles s={summary} limit={pool?.threadLimit} />
            <div className="home-grid">
              <Card
                title="Running now"
                count={live.length}
                wide
                actions={
                  live.length > 0 && (
                    <button className="btn xs danger" onClick={stopAll}>
                      <Square size={10} /> Stop all
                    </button>
                  )
                }
              >
                {live.length === 0 ? (
                  <Empty
                    icon={<FaceHuddle mood="calm" />}
                    text="Nothing running"
                    hint="Launch profiles from the Profiles section."
                    action={
                      <button className="btn xs" onClick={() => setTab('profiles')}>
                        Open Profiles
                      </button>
                    }
                  />
                ) : (
                  <div className="home-list">
                    {live.map((l) => (
                      <LiveRow key={l.id} live={l} session={byId.get(l.id)} />
                    ))}
                  </div>
                )}
              </Card>

              <Card title="Recent runs" count={summary.recentRuns.length}>
                {summary.recentRuns.length === 0 ? (
                  <Empty
                    icon={<Code2 size={22} />}
                    text="No runs yet"
                    hint="Scripts run on live profiles from Automation."
                    action={
                      <button className="btn xs" onClick={() => setTab('automation')}>
                        Open Automation
                      </button>
                    }
                  />
                ) : (
                  <div className="home-list">
                    {summary.recentRuns.map((r) => (
                      <RunRow key={r.id} r={r} onClick={() => setTab('automation')} />
                    ))}
                  </div>
                )}
              </Card>

              <Card title="Problems" count={summary.problems.length}>
                <Problems problems={summary.problems} />
              </Card>
            </div>
          </>
        )}

        {renderSlot('homeSections')}
      </div>
    </>
  );
};

/* ------------------------------------------------------------------ */

const Card: React.FC<{
  title: string;
  count?: number;
  wide?: boolean;
  actions?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, count, wide, actions, children }) => (
  <section className={`card home-card${wide ? ' wide' : ''}`} aria-label={title}>
    <header className="home-head">
      <h2>
        {title}
        {count !== undefined && count > 0 && <span className="badge">{count}</span>}
      </h2>
      <span className="grow" />
      {actions}
    </header>
    {children}
  </section>
);

// `kind` gives the tile its colour; `alert` overrides it when that stat needs attention.
const Tile: React.FC<{
  label: string;
  value: number;
  of?: number;
  sub?: React.ReactNode;
  kind: 'profiles' | 'running' | 'queued' | 'errors' | 'proxies' | 'fpts';
  icon: React.ReactNode;
  alert?: 'warn' | 'danger';
  onClick: () => void;
}> = ({ label, value, of, sub, kind, icon, alert, onClick }) => (
  <button
    className={`tile t-${kind}${alert ? (alert === 'warn' ? ' alert-warn' : ' alert') : ''}`}
    data-zero={value === 0}
    onClick={onClick}
  >
    <span className="k">
      <span className="i" aria-hidden="true">
        {icon}
      </span>
      {label}
    </span>
    <span className="v">
      {value}
      {of !== undefined && <small>/{of}</small>}
    </span>
    {sub && <span className="s">{sub}</span>}
  </button>
);

const Tiles: React.FC<{ s: HomeSummary; limit?: number }> = ({ s, limit }) => {
  const { setTab } = useApp();
  const { profiles: p, proxies: x, fingerprints: f } = s;
  return (
    <div className="tiles">
      <Tile
        kind="profiles"
        icon={<Users size={12} />}
        label="Profiles"
        value={p.total}
        sub={p.trash > 0 && `${p.trash} in trash`}
        onClick={() => setTab('profiles')}
      />
      <Tile kind="running" icon={<PlayCircle size={12} />} label="Running" value={p.live} of={limit} onClick={() => setTab('profiles')} />
      <Tile kind="queued" icon={<Clock size={12} />} label="Queued" value={p.queued} onClick={() => setTab('profiles')} />
      <Tile kind="errors" icon={<CircleAlert size={12} />} label="Errors" value={p.errors} onClick={() => setTab('profiles')} />
      <Tile
        kind="proxies"
        icon={<Earth size={12} />}
        label="Proxies"
        value={x.total}
        sub={
          <>
            <span className="st-ok">{x.ok} ok</span>
            <span className={x.failed ? 'st-error' : undefined}>{x.failed} failed</span>
            <span>{x.unchecked} unchecked</span>
          </>
        }
        onClick={() => setTab('proxies')}
      />
      <Tile
        kind="fpts"
        icon={<Fingerprint size={12} />}
        label="Free fingerprints"
        value={f.free}
        of={f.total}
        alert={f.total > 0 && f.free === 0 ? 'warn' : undefined}
        onClick={() => setTab('fingerprints')}
      />
    </div>
  );
};

const LiveRow: React.FC<{ live: PoolStatus['live'][number]; session?: SessionRecord }> = ({ live, session }) => {
  const { openProfile, stop } = useApp();
  const uptime = useElapsed(live.startedAt);
  const [busy, setBusy] = useState(false);
  return (
    <div className="live-row">
      <button className="who" onClick={() => openProfile(live.id)} aria-label={`Open ${live.id}`}>
        <Avatar s={session ?? { id: live.id }} size={26} />
        <span>
          <span className="name" title={live.id}>
            {live.id}
          </span>
          {/* The pool's URL is the start page or "restore tabs"; the worker's own tab list is not streamed. */}
          <span className="sub mono" title={live.url}>
            {live.url}
          </span>
        </span>
      </button>
      <span className="badge live">
        <span className="dot" />
        {uptime}
      </span>
      {live.exitIp && (
        <span className="tag" title="Exit IP">
          <span>{live.exitIp}</span>
        </span>
      )}
      {session && renderSlot('liveActions', { session })}
      <button
        className="btn xs danger"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await stop(live.id);
          setBusy(false);
        }}
      >
        <Square size={10} /> Stop
      </button>
    </div>
  );
};

const RunRow: React.FC<{ r: HomeRun; onClick: () => void }> = ({ r, onClick }) => (
  <button className="home-row" onClick={onClick} title={`${r.scriptName} on ${r.targets} — open Automation`}>
    <span className="name">{r.scriptName}</span>
    <span className="counts">
      <span className="st-ok">
        {r.ok}/{r.targets} ok
      </span>
      {r.error > 0 && <span className="st-error">{r.error} failed</span>}
      {r.stopped > 0 && <span className="st-stopped">{r.stopped} stopped</span>}
      {r.pending > 0 && <span className="st-pending">{r.pending} running</span>}
    </span>
    <span className="dim mono">{fmtMs(r.ms)}</span>
    <span className="dim when">{ago(r.startedAt)}</span>
  </button>
);

const Problems: React.FC<{ problems: LogEntry[] }> = ({ problems }) => {
  const { sessions, openProfile } = useApp();
  // Newest first, one group per profile; lines without a profile go last under "General".
  const groups = useMemo(() => {
    const m = new Map<string, LogEntry[]>();
    for (const l of [...problems].reverse()) {
      const k = l.sessionId || '';
      const g = m.get(k);
      if (g) g.push(l);
      else m.set(k, [l]);
    }
    return [...m].sort((a, b) => Number(!a[0]) - Number(!b[0]));
  }, [problems]);

  if (!problems.length) {
    return <Empty icon={<CircleCheck size={22} />} text="No problems" hint="No warnings or errors in the recent log." />;
  }
  return (
    <div className="home-list">
      {groups.map(([id, entries]) => {
        const s = sessions.find((x) => x.id === id);
        return (
          <div key={id || '-'} className="prob-group">
            <div className="prob-who">
              {id ? (
                <>
                  <Avatar s={s ?? { id }} size={20} />
                  <span className="name">{id}</span>
                  {!s && <span className="sub">no longer exists</span>}
                </>
              ) : (
                <span className="sub">General</span>
              )}
            </div>
            {entries.map((l) => {
              const inner = (
                <>
                  <time dateTime={l.timestamp}>{clock(l.timestamp)}</time>
                  <span className="msg">{l.message}</span>
                </>
              );
              return s ? (
                <button key={l.id} className={`prob ${l.level}`} onClick={() => openProfile(id)} title={`Open ${id}`}>
                  {inner}
                </button>
              ) : (
                <div key={l.id} className={`prob ${l.level}`}>
                  {inner}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};

/** First run: no profiles at all. */
const Setup: React.FC<{ s: HomeSummary }> = ({ s }) => {
  const { setTab, openNew } = useApp();
  const steps = [
    {
      done: s.proxies.total > 0,
      title: 'Add proxies',
      hint: 'Drop a proxies.txt into resources/proxies, or import them in the Proxies section.',
      action: (
        <button className="btn xs" onClick={() => setTab('proxies')}>
          Proxies
        </button>
      ),
    },
    {
      done: s.fingerprints.total > 0,
      title: 'Add fingerprints',
      hint: 'Copy fingerprint files into resources/fpts.',
      action: (
        <button className="btn xs" onClick={() => setTab('fingerprints')}>
          Fingerprints
        </button>
      ),
    },
    {
      done: false,
      title: 'Create a profile',
      hint: 'Each profile takes a free proxy and fingerprint and keeps its own cookies.',
      action: (
        <button className="btn xs primary" onClick={openNew}>
          <Plus size={12} /> New profile
        </button>
      ),
    },
  ];
  return (
    <div className="card setup">
      <Empty icon={<FaceHuddle />} text="No profiles yet" hint="Three steps to a first browser." />
      <ol className="steps">
        {steps.map((st, i) => (
          <li key={st.title} className={st.done ? 'done' : undefined}>
            <span className="step-n" aria-hidden="true">
              {st.done ? <Check size={13} /> : i + 1}
            </span>
            <span className="grow">
              <span className="name">
                {st.title}
                {st.done && <span className="sr-only"> (done)</span>}
              </span>
              <span className="hint">{st.hint}</span>
            </span>
            {st.action}
          </li>
        ))}
      </ol>
    </div>
  );
};

export const contributions: Contributions = {};
