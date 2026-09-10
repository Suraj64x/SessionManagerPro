import React, { useMemo, useRef, useState } from 'react';
import { Check, Globe, Loader2, Search, Zap } from 'lucide-react';
import type { ProxyResource } from '../types';
import { api } from '../api';
import { CopyButton, Empty, Pager, Toolbar, usePaged } from '../ui';

type Probe = { status: 'testing' | 'ok' | 'fail'; latency?: number; ip?: string; error?: string };
type Filter = 'all' | 'free' | 'bound';
type SortMode = 'default' | 'latency';

interface Props {
  proxies: ProxyResource[];
  query: string;
  onQuery: (q: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  pageSize: number;
  onPageSize: (n: number) => void;
  onToast: (kind: 'success' | 'error' | 'info', text: string) => void;
  onRefresh: () => void;
}

export const ProxyPanel: React.FC<Props> = ({
  proxies,
  query,
  onQuery,
  searchRef,
  pageSize,
  onPageSize,
  onToast,
  onRefresh,
}) => {
  const [probes, setProbes] = useState<Record<string, Probe>>({});
  const [filter, setFilter] = useState<Filter>('all');
  const [sortMode, setSortMode] = useState<SortMode>('default');
  const [busy, setBusy] = useState(false);

  const free = proxies.filter((p) => !p.isAssigned).length;

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = proxies.filter((p) => {
      if (filter === 'free' && p.isAssigned) return false;
      if (filter === 'bound' && !p.isAssigned) return false;
      if (!q) return true;
      return [p.host, String(p.port), p.username, p.assignedTo]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
    if (sortMode === 'latency') {
      return [...filtered].sort((a, b) => {
        const la = probes[a.key]?.latency ?? Infinity;
        const lb = probes[b.key]?.latency ?? Infinity;
        return la - lb;
      });
    }
    return filtered;
  }, [proxies, query, filter, sortMode, probes]);

  const paged = usePaged(rows, pageSize, `${filter}|${query}`);

  const probe = async (p: ProxyResource) => {
    setProbes((s) => ({ ...s, [p.key]: { status: 'testing' } }));
    try {
      const res = await api.testProxy(p);
      setProbes((s) => ({
        ...s,
        [p.key]: res.ok
          ? { status: 'ok', latency: res.latency, ip: res.ip }
          : { status: 'fail', error: res.error || 'No route' },
      }));
      return res.ok;
    } catch (err: any) {
      setProbes((s) => ({ ...s, [p.key]: { status: 'fail', error: err.message } }));
      return false;
    }
  };

  // Tests everything the current filter shows, not just the visible page. Each probe
  // can block for 6s, so run them in small batches and let the operator stop the run.
  const cancelled = useRef(false);
  const probeAll = async () => {
    if (busy) {
      cancelled.current = true;
      return;
    }
    cancelled.current = false;
    setBusy(true);
    let ok = 0;
    let done = 0;
    for (let i = 0; i < rows.length && !cancelled.current; i += 8) {
      const batch = rows.slice(i, i + 8);
      const results = await Promise.all(batch.map(probe));
      ok += results.filter(Boolean).length;
      done += batch.length;
    }
    setBusy(false);
    const stopped = cancelled.current;
    onToast(
      !stopped && ok === rows.length ? 'success' : 'info',
      `${ok}/${done} reachable${stopped ? ' (stopped)' : ''}`
    );
  };

  return (
    <>
      <Toolbar title="Proxies" count={proxies.length}>
        <div className="seg" role="group" aria-label="Filter proxies">
          <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
            All
          </button>
          <button aria-pressed={filter === 'free'} onClick={() => setFilter('free')}>
            Free {free}
          </button>
          <button aria-pressed={filter === 'bound'} onClick={() => setFilter('bound')}>
            Bound
          </button>
        </div>

        <div className="field search">
          <Search size={14} />
          <input
            ref={searchRef}
            type="search"
            className="input"
            placeholder="Search  /"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            aria-label="Search proxies"
          />
        </div>

        <button className="btn" onClick={probeAll} disabled={!rows.length}>
          {busy ? <Loader2 size={13} className="spin" /> : <Zap size={13} strokeWidth={1.9} />}
          {busy ? 'Stop' : `Test ${rows.length}`}
        </button>

        <div className="seg" role="group" aria-label="Sort">
          <button aria-pressed={sortMode === 'default'} onClick={() => setSortMode('default')}>Default</button>
          <button aria-pressed={sortMode === 'latency'} onClick={() => setSortMode('latency')}>By latency</button>
        </div>
      </Toolbar>

      <div className="view">
        {!proxies.length ? (
          <div className="card">
            <Empty
              icon={<Globe size={30} strokeWidth={1.5} />}
              text="No proxies in resources/proxies/"
              action={
                <button className="btn" onClick={onRefresh}>
                  Rescan
                </button>
              }
            />
          </div>
        ) : (
          <>
            <div className="grid">
              {paged.slice.map((p) => {
                const r = probes[p.key];
                return (
                  <div key={p.key} className="tile">
                    <div className="tile-head">
                      <span
                        className="mono"
                        style={{ fontSize: 12.5, color: 'var(--txt)' }}
                        title={`${p.host}:${p.port}`}
                      >
                        {p.host}:{p.port}
                      </span>
                      {p.isAssigned ? (
                        <span className="badge">Bound</span>
                      ) : (
                        <span className="badge live">
                          <span className="dot" />
                          Free
                        </span>
                      )}
                    </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {p.isAssigned && (
                          <div className="tile-kv">
                            <span>Session</span>
                            <b title={p.assignedTo || ''}>{p.assignedTo}</b>
                          </div>
                        )}
                        <div className="tile-kv">
                          <span>Exit IP</span>
                          <b style={{ color: r?.ip ? 'var(--accent)' : undefined }}>{r?.ip || '—'}</b>
                        </div>
                        <div className="tile-kv">
                          <span>Latency</span>
                          <b>{r?.latency ? (
                            <span className={`latency-badge ${r.latency < 200 ? 'good' : r.latency < 600 ? 'medium' : 'slow'}`}>
                              <span className="latency-dot" />
                              {r.latency} ms
                            </span>
                          ) : r?.status === 'fail' ? (
                            <span className="latency-badge slow">
                              <span className="latency-dot" />
                              Failed
                            </span>
                          ) : (
                            <span className="latency-badge untested">
                              <span className="latency-dot" />
                              —
                            </span>
                          )}</b>
                        </div>
                        {r?.error && (
                          <div className="tile-kv">
                            <span>Error</span>
                            <b style={{ color: 'var(--danger)' }}>{r.error}</b>
                          </div>
                        )}
                      </div>

                    <div className="tile-foot">
                      <span className="sub" title={p.username || 'no auth'}>
                        {p.username || 'no auth'}
                      </span>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <CopyButton value={p.url} label="Copy URL" />
                        <button
                          className="btn xs"
                          onClick={() => probe(p)}
                          disabled={r?.status === 'testing'}
                        >
                          {r?.status === 'testing' ? (
                            <Loader2 size={11} className="spin" />
                          ) : r?.status === 'ok' ? (
                            <Check size={11} color="var(--accent)" strokeWidth={2.25} />
                          ) : (
                            <Zap size={11} strokeWidth={1.9} />
                          )}
                          Test
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {rows.length === 0 ? (
              <div className="card">
                <Empty icon={<Search size={26} strokeWidth={1.5} />} text="Nothing matches." />
              </div>
            ) : (
              <Pager
                standalone
                page={paged.page}
                pages={paged.pages}
                from={paged.from}
                to={paged.to}
                total={rows.length}
                noun="proxies"
                pageSize={pageSize}
                onPage={paged.setPage}
                onPageSize={onPageSize}
              />
            )}
          </>
        )}
      </div>
    </>
  );
};
