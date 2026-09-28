import React, { useState } from 'react';
import { CalendarClock, ChevronRight, Loader2, RotateCcw, Square } from 'lucide-react';
import { useApp } from '../../app-context';
import { Empty, useElapsed, useUI } from '../../ui';
import { FaceHuddle } from '../../faces';
import { Results } from './ScriptsView';
import { api } from './api';
import type { Run, Schedule } from './types';

const isActive = (r: Run) => Object.values(r.results).some((x) => x.state === 'pending' || x.state === 'running');

// Same m:ss / h:mm:ss as the live counter, so a run's time keeps its shape when it ends.
const fmtMs = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
};

/** Start of the run to the last profile's end. */
const duration = (r: Run) => {
  const t0 = Date.parse(r.startedAt);
  let end = t0;
  for (const x of Object.values(r.results)) {
    if (x.startedAt && x.ms != null) end = Math.max(end, Date.parse(x.startedAt) + x.ms);
  }
  return end - t0;
};

const Duration: React.FC<{ run: Run; active: boolean }> = ({ run, active }) => {
  const live = useElapsed(active ? run.startedAt : null);
  return <span className="dim mono">{active ? live : fmtMs(duration(run))}</span>;
};

const RunRow: React.FC<{ run: Run; open: boolean; onToggle: () => void; onRerun: (r: Run) => void; schedule?: Schedule }> = ({
  run,
  open,
  onToggle,
  onRerun,
  schedule,
}) => {
  const { toast } = useUI();
  const [busy, setBusy] = useState(false);
  const rs = Object.entries(run.results);
  const count = (s: string) => rs.filter(([, r]) => r.state === s).length;
  const ok = count('ok');
  const failed = count('error');
  const stopped = count('stopped');
  const active = isActive(run);
  const done = rs.length - count('pending') - count('running');
  const ids = rs.map(([id]) => id);
  const who = ids.length <= 2 ? ids.join(', ') : `${ids.slice(0, 2).join(', ')} +${ids.length - 2}`;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card aut-run">
      <div className="aut-run-head">
        <button className="aut-run-toggle" onClick={onToggle} aria-expanded={open} aria-label={`${run.scriptName}, ${open ? 'hide' : 'show'} results`}>
          <ChevronRight size={14} className="aut-chev" />
          <span className="aut-run-name">
            <span className="name">{run.scriptName}</span>
            <span className="sub" title={ids.join('\n')}>
              {ids.length} profile{ids.length > 1 ? 's' : ''} · {who}
            </span>
          </span>
        </button>
        {run.scheduleId && (
          <span className="badge" title={schedule ? `Schedule “${schedule.name}”` : 'A schedule started it'}>
            <CalendarClock size={11} /> {schedule?.name || 'Scheduled'}
          </span>
        )}
        <span className="aut-counts">
          {active && (
            <span className="badge live">
              <Loader2 size={11} className="spin" /> {done}/{rs.length}
            </span>
          )}
          {ok > 0 && <span className="badge label">{ok} ok</span>}
          {failed > 0 && <span className="badge error">{failed} failed</span>}
          {stopped > 0 && <span className="badge warn">{stopped} stopped</span>}
        </span>
        <span className="dim aut-when" title={new Date(run.startedAt).toLocaleString()}>
          {new Date(run.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
        </span>
        <Duration run={run} active={active} />
        <span className="aut-run-actions">
          {active && (
            <button className="btn xs danger" disabled={busy} onClick={() => act(() => api.stopRun(run.id))}>
              <Square size={10} /> Stop
            </button>
          )}
          {!active && failed > 0 && (
            <button className="btn xs" disabled={busy} onClick={() => act(async () => onRerun(await api.rerunFailed(run.id)))}>
              <RotateCcw size={12} /> Re-run failed
            </button>
          )}
        </span>
      </div>
      {open && <Results run={run} />}
    </div>
  );
};

export const RunsView: React.FC<{
  tabs: React.ReactNode;
  schedules: Schedule[];
  openRun: string | null;
  setOpenRun: (id: string | null) => void;
}> = ({ tabs, schedules, openRun, setOpenRun }) => {
  const { runs } = useApp();
  const { toast } = useUI();
  const list = [...(runs as Run[])].sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  return (
    <>
      <header className="section-head">
        <h1>Automation</h1>
        {tabs}
        <span className="grow" />
      </header>
      <div className="view">
        {!list.length ? (
          <Empty
            icon={<FaceHuddle mood="calm" />}
            text="No runs yet"
            hint="Scripts, warm-ups and schedules show their runs here until the app restarts."
          />
        ) : (
          <>
            <div className="aut-runs">
              {list.map((r) => (
                <RunRow
                  key={r.id}
                  run={r}
                  open={openRun === r.id}
                  onToggle={() => setOpenRun(openRun === r.id ? null : r.id)}
                  schedule={schedules.find((s) => s.id === r.scheduleId)}
                  onRerun={(next) => {
                    toast('info', `Re-running ${Object.keys(next.results).length} failed`);
                    setOpenRun(next.id);
                  }}
                />
              ))}
            </div>
            <p className="hint">The last 30 runs, kept until the app restarts.</p>
          </>
        )}
      </div>
    </>
  );
};
