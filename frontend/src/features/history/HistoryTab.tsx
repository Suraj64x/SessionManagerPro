import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  CircleAlert,
  Code2,
  Cookie,
  Download,
  History,
  Loader2,
  PenLine,
  Play,
  RotateCcw,
  Square,
} from 'lucide-react';
import type { SessionRecord } from '../../types';
import { useApp, useEvent } from '../../app-context';
import { Empty, Pager, ago, usePaged, useStored, useUI } from '../../ui';
import { historyApi } from './api';
import type { HistoryEvent, HistoryResponse, Snapshot } from './types';

type Filter = 'all' | 'launches' | 'scripts' | 'cookies' | 'changes';

const GROUPS: Record<Exclude<Filter, 'all'>, string[]> = {
  launches: ['launched', 'closed', 'launch_failed'],
  scripts: ['script_ok', 'script_failed'],
  cookies: ['cookies_imported', 'snapshot_restored'],
  changes: ['created', 'cloned', 'restored', 'trashed', 'fingerprint_changed', 'proxy_changed'],
};
const FILTERS: Array<[Filter, string]> = [
  ['all', 'All'],
  ['launches', 'Launches'],
  ['scripts', 'Scripts'],
  ['cookies', 'Cookies'],
  ['changes', 'Changes'],
];
const ICONS: Record<Exclude<Filter, 'all'>, React.ReactNode> = {
  launches: <Play size={13} />,
  scripts: <Code2 size={13} />,
  cookies: <Cookie size={13} />,
  changes: <PenLine size={13} />,
};
const groupOf = (type: string) =>
  (Object.keys(GROUPS) as Array<keyof typeof GROUPS>).find((g) => GROUPS[g].includes(type));

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const pad = (n: number) => String(n).padStart(2, '0');
const hmm = (secs: number) => `${Math.floor(secs / 3600)}:${pad(Math.floor((secs % 3600) / 60))}`;
const span = (ms = 0) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
const size = (b: number) =>
  b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`;
const stamp = (iso: string) =>
  new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One line per event; `err` marks the ones that went wrong. */
function describe(e: HistoryEvent): { text: string; err?: boolean } {
  switch (e.type) {
    case 'launched': {
      const where = e.exitIp ? ` · ${e.exitIp}${e.country ? ` (${e.country})` : ''}` : '';
      return { text: `Launched${e.headless ? ' headless' : ''}${where}` };
    }
    case 'closed':
      return e.status === 'success'
        ? { text: `Closed after ${span(e.durationMs)}${e.closedByUser ? '' : ` · ${e.reason || 'ended'}`}` }
        : { text: `Stopped after ${span(e.durationMs)}: ${e.reason || 'error'}`, err: true };
    case 'launch_failed':
      return { text: `Launch failed: ${e.reason || 'unknown'}`, err: true };
    case 'cookies_imported':
      return { text: `Imported ${e.count} of ${plural(e.total ?? 0, 'cookie')}` };
    case 'snapshot_restored':
      return { text: `Restored a snapshot · ${plural(e.count ?? 0, 'cookie')}, ${e.applied === 'now' ? 'applied live' : 'for next launch'}` };
    case 'created':
      return { text: e.via ? `Created from ${e.via === 'template' ? 'a template' : 'an import'}` : 'Created' };
    case 'cloned':
      return { text: `Cloned from ${e.from}` };
    case 'restored':
      return { text: 'Restored from trash' };
    case 'trashed':
      return { text: 'Moved to trash' };
    case 'fingerprint_changed':
      return { text: 'Fingerprint rebuilt' };
    case 'proxy_changed':
      return { text: `Proxy ${e.from || 'none'} → ${e.to || 'none'}` };
    case 'script_ok':
      return { text: `${e.script} finished in ${e.ms} ms` };
    case 'script_failed':
      return { text: e.message || 'Script failed', err: true };
    default:
      return { text: e.type };
  }
}

export const HistoryTab: React.FC<{ session: SessionRecord }> = ({ session }) => {
  const id = session.id;
  const live = session.status === 'live';
  const { launch } = useApp();
  const { confirm, toast } = useUI();
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [snaps, setSnaps] = useState<Snapshot[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useStored<Filter>('history.filter', 'all');
  const [pageSize, setPageSize] = useStored('history.pageSize', 50);

  // Two independent requests: a slow snapshot listing never holds up the events.
  const load = useCallback(() => {
    historyApi.history(id).then(
      (d) => (setData(d), setError('')),
      (e) => setError(errText(e))
    );
    historyApi.snapshots(id).then(setSnaps, () => setSnaps((prev) => prev ?? []));
  }, [id]);
  useEffect(load, [load]);

  // Launches, closes and log lines arrive in bursts: one refetch per burst.
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const soon = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(load, 500);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEvent('session', (d) => d?.id === id && soon());
  useEvent('log', (d) => d?.sessionId === id && soon());
  useEvent('history', (d) => d?.id === id && soon());

  const events = data?.events ?? [];
  const shown = filter === 'all' ? events : events.filter((e) => GROUPS[filter].includes(e.type));
  const paged = usePaged(shown, pageSize, filter);

  const restore = async (s: Snapshot) => {
    const ok = await confirm({
      title: 'Restore snapshot?',
      body: `Replace the current cookies with this snapshot? ${plural(s.count, 'cookie')} from ${stamp(s.at)}, ${
        live ? 'applies now.' : 'loaded at the next launch.'
      }`,
      confirmLabel: 'Restore',
    });
    if (!ok) return;
    setBusy(s.file);
    try {
      const r = await historyApi.restore(id, s.file);
      toast('success', `Restored ${plural(r.count, 'cookie')}${r.applied === 'now' ? '' : ' for the next launch'}`);
      load();
    } catch (e) {
      toast('error', `Restore failed: ${errText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  if (!data) {
    return error ? (
      <Empty
        icon={<CircleAlert size={22} />}
        text="Couldn't load history"
        hint={error}
        action={
          <button className="btn" onClick={load}>
            Retry
          </button>
        }
      />
    ) : (
      <p className="hint hist-loading">
        <Loader2 size={13} className="spin" /> Loading history…
      </p>
    );
  }

  const { stats } = data;
  return (
    <>
      <div className="hist-tiles">
        <div className="hist-tile">
          <span className="k">Launches</span>
          <span className="v">{stats.launchCount}</span>
        </div>
        <div className="hist-tile">
          <span className="k">Work time</span>
          <span className="v">{hmm(stats.workSeconds)}</span>
        </div>
        <div className="hist-tile">
          <span className="k">Last exit IP</span>
          <span className="v ip" title={stats.lastExitIp || undefined}>
            {stats.lastExitIp || '—'}
          </span>
          {stats.lastCountry && <span className="s">{stats.lastCountry}</span>}
        </div>
        <div className="hist-tile">
          <span className="k">Created</span>
          <span className="v" title={stats.createdAt && new Date(stats.createdAt).toLocaleString()}>
            {ago(stats.createdAt)}
          </span>
        </div>
      </div>

      <div className="group">
        <div className="seg hist-filter" role="group" aria-label="Show events">
          {FILTERS.map(([f, label]) => {
            const n = f === 'all' ? events.length : events.filter((e) => GROUPS[f].includes(e.type)).length;
            return (
              <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {label} <span className="n">{n}</span>
              </button>
            );
          })}
        </div>

        {shown.length === 0 ? (
          filter === 'all' ? (
            <Empty
              icon={<History size={22} />}
              text="No history yet"
              hint="Launches, scripts, cookie imports and edits show up here."
              action={
                !live && (
                  <button className="btn" onClick={() => launch([id])}>
                    <Play size={12} /> Launch
                  </button>
                )
              }
            />
          ) : (
            <Empty
              icon={<History size={22} />}
              text={`No ${FILTERS.find(([f]) => f === filter)?.[1].toLowerCase()} yet`}
              action={
                <button className="btn" onClick={() => setFilter('all')}>
                  Show all
                </button>
              }
            />
          )
        ) : (
          <>
            <ol className="hist-events">
              {paged.slice.map((e, i) => {
                const d = describe(e);
                const g = groupOf(e.type);
                return (
                  <li key={`${e.at}-${i}`} className={d.err ? 'err' : undefined}>
                    <span className="ico" aria-hidden="true">
                      {e.type === 'closed' ? <Square size={11} /> : g ? ICONS[g] : <History size={13} />}
                    </span>
                    <span className="d" title={d.text}>
                      {d.text}
                    </span>
                    <time dateTime={e.at} title={new Date(e.at).toLocaleString()}>
                      {ago(e.at)}
                    </time>
                  </li>
                );
              })}
            </ol>
            {shown.length > 25 && (
              <Pager paged={paged} total={shown.length} noun="events" pageSize={pageSize} onPageSize={setPageSize} />
            )}
          </>
        )}
      </div>

      <div className="card hist-snaps">
        <div className="hist-snaps-head">
          <h3>Cookie snapshots</h3>
          <span className="hint">Saved on every clean close, newest 5 kept</span>
        </div>
        {snaps === null ? (
          <p className="hint hist-loading">
            <Loader2 size={13} className="spin" /> Loading…
          </p>
        ) : snaps.length === 0 ? (
          <Empty icon={<Cookie size={22} />} text="No snapshots yet" hint="One is saved when the browser closes cleanly." />
        ) : (
          <ul>
            {snaps.map((s) => (
              <li key={s.file}>
                <div className="when">
                  <time dateTime={s.at}>{stamp(s.at)}</time>
                  <span className="hint">
                    {plural(s.count, 'cookie')} · {size(s.bytes)} · {ago(s.at)}
                  </span>
                </div>
                <button
                  className="btn xs"
                  onClick={() => restore(s)}
                  disabled={busy !== null}
                  aria-label={`Restore snapshot from ${stamp(s.at)}`}
                >
                  {busy === s.file ? <Loader2 size={12} className="spin" /> : <RotateCcw size={12} />} Restore
                </button>
                <a
                  className="btn xs ghost"
                  href={historyApi.downloadUrl(id, s.file)}
                  download
                  aria-label={`Download snapshot from ${stamp(s.at)}`}
                >
                  <Download size={12} /> Download
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
};
