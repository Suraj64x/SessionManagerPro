import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { CircleAlert, CircleCheck, CircleX, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { useApp } from '../../app-context';
import { Avatar, CopyButton, Modal } from '../../ui';
import { apidocsApi, type LeakResult, type LeakRow } from './api';
import { getLeakIds, openLeakCheck, subscribeLeak } from './leakstore';


export const LeakCheckHost: React.FC = () => {
  const ids = useSyncExternalStore(subscribeLeak, getLeakIds);
  return ids ? <LeakCheckDialog ids={ids} onClose={() => openLeakCheck(null)} /> : null;
};

type Entry = { state: 'waiting' | 'running' | 'done' | 'error'; result?: LeakResult; error?: string };

const VERDICT: Record<LeakResult['verdict'], { label: string; cls: string }> = {
  clean: { label: 'No leaks', cls: 'live' },
  check: { label: 'Check warnings', cls: 'warn' },
  leak: { label: 'Leaking', cls: 'error' },
};

const STATUS_ICON: Record<LeakRow['status'], React.ReactNode> = {
  pass: <CircleCheck size={14} className="lk-pass" />,
  fail: <CircleX size={14} className="lk-fail" />,
  warn: <CircleAlert size={14} className="lk-warn" />,
};

const reportText = (id: string, r: LeakResult) =>
  [`${id} — ${VERDICT[r.verdict].label} (${new Date(r.at).toLocaleString()})`, ...r.rows.map((x) => `${x.status.toUpperCase().padEnd(4)}  ${x.label.padEnd(18)} ${x.value}${x.note ? `  (${x.note})` : ''}`)].join('\n');

/** Checks each running profile in turn: what sites see against this machine's real IPs and DNS. */
const LeakCheckDialog: React.FC<{ ids: string[]; onClose: () => void }> = ({ ids, onClose }) => {
  const { sessions } = useApp();
  const [entries, setEntries] = useState<Record<string, Entry>>(() => Object.fromEntries(ids.map((id) => [id, { state: 'waiting' }])));
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    []
  );

  const run = useCallback(async (list: string[]) => {
    for (const id of list) {
      if (!alive.current) return;
      setEntries((e) => ({ ...e, [id]: { state: 'running' } }));
      try {
        const result = await apidocsApi.leakCheck(id);
        if (alive.current) setEntries((e) => ({ ...e, [id]: { state: 'done', result } }));
      } catch (err: any) {
        if (alive.current) setEntries((e) => ({ ...e, [id]: { state: 'error', error: err.message } }));
      }
    }
  }, []);

  // A tick later, not during the effect: and React's development double-mount clears the
  // first timer, so each profile is checked once.
  useEffect(() => {
    const t = setTimeout(() => run(ids));
    return () => clearTimeout(t);
  }, [ids, run]);

  const busy = Object.values(entries).some((e) => e.state === 'running' || e.state === 'waiting');
  const done = Object.entries(entries).filter(([, e]) => e.result);
  const all = done.map(([id, e]) => reportText(id, e.result!)).join('\n\n');

  return (
    <Modal
      title={ids.length > 1 ? `Leak check · ${ids.length} profiles` : 'Leak check'}
      width={720}
      onClose={onClose}
      footer={
        <>
          {done.length > 0 && <CopyButton value={all} label="Copy report" className="lk-copy" />}
          <span className="grow" />
          <button className="btn" onClick={() => run(ids)} disabled={busy}>
            <RefreshCw size={13} className={busy ? 'spin' : undefined} /> Run again
          </button>
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <p className="hint lk-intro">
        What sites see from each profile, compared with this computer’s own IP and DNS. Takes about 15 seconds per profile.
      </p>
      <div className="lk-list">
        {ids.map((id) => {
          const e = entries[id];
          const s = sessions.find((x) => x.id === id);
          return (
            <section key={id} className="lk-card" aria-busy={e.state === 'running'}>
              <header className="lk-head">
                <Avatar s={{ id, color: s?.color }} size={24} />
                <b className="lk-name" title={id}>
                  {id}
                </b>
                <span className="grow" />
                {e.state === 'running' && (
                  <span className="lk-running">
                    <Loader2 size={13} className="spin" /> Checking…
                  </span>
                )}
                {e.state === 'waiting' && <span className="dim">Waiting</span>}
                {e.result && <span className={`badge ${VERDICT[e.result.verdict].cls}`}>{VERDICT[e.result.verdict].label}</span>}
                {e.result && <CopyButton value={reportText(id, e.result)} label={`Copy ${id}'s report`} />}
              </header>
              {e.state === 'error' && (
                <div className="alert lk-error">
                  <CircleAlert size={14} /> {e.error}
                </div>
              )}
              {e.result && (
                <table className="tbl lk-table">
                  <tbody>
                    {e.result.rows.map((r) => (
                      <tr key={r.key} data-status={r.status}>
                        <td className="tight">
                          <span role="img" aria-label={r.status}>
                            {STATUS_ICON[r.status]}
                          </span>
                        </td>
                        <td className="lk-label">{r.label}</td>
                        <td className="mono lk-value" title={r.value}>
                          {r.value}
                        </td>
                        <td className="lk-note">{r.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          );
        })}
      </div>
    </Modal>
  );
};

/** Row-menu, drawer and Home entry point for one running profile. */
export const LeakCheckButton: React.FC<{ id: string; variant: 'menu' | 'icon' }> = ({ id, variant }) =>
  variant === 'menu' ? (
    <button onClick={() => openLeakCheck([id])}>
      <ShieldCheck size={12} /> Leak check…
    </button>
  ) : (
    <button className="icon-btn xs" onClick={() => openLeakCheck([id])} aria-label={`Leak check ${id}`} data-tip="Leak check">
      <ShieldCheck size={14} />
    </button>
  );
