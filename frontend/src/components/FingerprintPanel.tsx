import React, { useMemo, useState } from 'react';
import { Eye, Search } from 'lucide-react';
import type { FingerprintResource } from '../types';
import { CopyButton, Empty, Pager, Toolbar, usePaged } from '../ui';
import { FaceHuddle } from '../faces';

type Filter = 'all' | 'free' | 'bound' | 'chrome' | 'firefox';

const flag = (cc: string) => (/^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '');

/**
 * Dump filenames come as `<hash>_<CC>_<C|F>` or `<capture-ip>__<hash>`.
 * Pick the hash from either, rather than labelling every print with a truncated IP.
 */
export function fptShort(file: string) {
  const segments = file.replace(/\.json(\.gz)?$/, '').split(/_+/).filter(Boolean);
  const hash = segments.find((s) => /^[0-9a-f]{8,}$/i.test(s));
  return (hash || segments[0] || file).slice(0, 8);
}

export function fptMeta(f: FingerprintResource) {
  const segments = f.file.replace(/\.json(\.gz)?$/, '').split(/_+/).filter(Boolean);
  const country = f.country || segments.find((s) => /^[A-Za-z]{2}$/.test(s))?.toUpperCase();
  return {
    shortId: fptShort(f.file),
    country: !country || country === 'GLOBAL' ? '' : country,
    browserName: f.browserName || (segments.includes('F') ? 'Firefox' : 'Chrome'),
  };
}

export const FingerprintPanel: React.FC<{
  fingerprints: FingerprintResource[];
  query: string;
  onQuery: (q: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  onInspect: (f: FingerprintResource) => void;
  onRefresh: () => void;
  pageSize: number;
  onPageSize: (n: number) => void;
}> = ({ fingerprints, query, onQuery, searchRef, onInspect, onRefresh, pageSize, onPageSize }) => {
  const [filter, setFilter] = useState<Filter>('all');
  const free = fingerprints.filter((f) => !f.isAssigned && !f.error).length;

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return fingerprints.filter((f) => {
      const m = fptMeta(f);
      if (filter === 'free' && (f.isAssigned || f.error)) return false;
      if (filter === 'bound' && !f.isAssigned) return false;
      if (filter === 'chrome' && m.browserName !== 'Chrome') return false;
      if (filter === 'firefox' && m.browserName !== 'Firefox') return false;
      if (!q) return true;
      return [f.file, m.country, m.browserName, f.platform, f.viewport, f.assignedTo]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
  }, [fingerprints, query, filter]);

  const paged = usePaged(rows, pageSize, `${filter}|${query}`);

  return (
    <>
      <Toolbar title="Fingerprints">
        <div className="seg" role="group" aria-label="Filter">
          {(['all', 'free', 'bound', 'chrome', 'firefox'] as Filter[]).map((f) => (
            <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f[0].toUpperCase() + f.slice(1)}
              {f === 'all' && <span className="n">{fingerprints.length}</span>}
              {f === 'free' && <span className="n">{free}</span>}
            </button>
          ))}
        </div>
        <div className="field search">
          <Search size={14} />
          <input
            ref={searchRef}
            type="search"
            data-search=""
            className="input"
            placeholder="Id, region, platform…"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            aria-label="Search fingerprints"
          />
        </div>
      </Toolbar>

      <div className="view">
        {!fingerprints.length ? (
          <div className="table-wrap">
            <Empty
              icon={<FaceHuddle mood="calm" />}
              text="No fingerprints yet"
              hint="Drop .json or .json.gz fingerprint dumps into resources/fpts/, then rescan."
              action={
                <button className="btn" onClick={onRefresh}>
                  Rescan
                </button>
              }
            />
          </div>
        ) : !rows.length ? (
          <div className="table-wrap">
            <Empty icon={<FaceHuddle mood="puzzled" />} text="Nothing matches" />
          </div>
        ) : (
          <div className="table-wrap">
            <div className="table-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Id</th>
                    <th>Region</th>
                    <th>Browser</th>
                    <th>Platform</th>
                    <th>Screen</th>
                    <th>Bound to</th>
                    <th className="tight" />
                  </tr>
                </thead>
                <tbody>
                  {paged.slice.map((f) => {
                    const m = fptMeta(f);
                    return (
                      <tr key={f.file}>
                        <td>
                          <span className="inline" style={{ gap: 2 }}>
                            <span className="mono" style={{ color: 'var(--txt)' }}>
                              {m.shortId}
                            </span>
                            <CopyButton value={f.file} label="Copy filename" className="reveal" />
                          </span>
                        </td>
                        <td>{m.country ? `${flag(m.country)} ${m.country}` : <span className="dim">—</span>}</td>
                        <td>
                          {m.browserName}
                          <span className="dim"> {f.chromeVersion?.split('.')[0]}</span>
                        </td>
                        <td>{f.error ? <span className="badge error" title={f.error}>unreadable</span> : f.platform || '—'}</td>
                        <td className="mono dim">{f.viewport || '—'}</td>
                        <td>
                          {f.isAssigned ? (
                            <span className="name" style={{ fontSize: 12, maxWidth: '22ch' }} title={f.assignedTo || ''}>
                              {f.assignedTo}
                            </span>
                          ) : f.error ? (
                            <span className="dim">—</span>
                          ) : (
                            <span className="badge live">free</span>
                          )}
                        </td>
                        <td className="tight">
                          <button
                            className="icon-btn xs reveal"
                            onClick={() => onInspect(f)}
                            aria-label={`Inspect ${m.shortId}`}
                            title="Inspect"
                          >
                            <Eye size={14} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pager paged={paged} total={rows.length} noun="prints" pageSize={pageSize} onPageSize={onPageSize} />
          </div>
        )}
      </div>
    </>
  );
};
