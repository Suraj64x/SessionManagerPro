import React, { useEffect, useMemo, useState } from 'react';
import { Copy, Loader2, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Trash2, UserRoundPlus, X, Zap } from 'lucide-react';
import { useApp, useEvent } from '../../app-context';
import { CheckBox, CopyButton, Empty, Menu, Pager, Toolbar, ago, usePaged, useStored } from '../../ui';
import { FaceHuddle } from '../../faces';
import { labelOf, useProxyActions } from './actions';
import { AddDialog, AssignDialog, EditDialog, StatusDot } from './parts';
import { flag, healthOf, liveOwner, patchCheck, reload, useLibrary } from './store';
import type { LibProxy, ProxyCheck } from './types';

type Tab = 'all' | 'unused' | 'errors';
const failed = (p: LibProxy) => p.check !== null && !p.check.ok;

// Proxy library: paste or import, check, change IP, assign to profiles.
export const ProxiesView: React.FC<{ active: boolean }> = () => {
  const { sessions, proxies: resources, selectedIds, openId, openProfile, refresh } = useApp();
  const { list, error, busy } = useLibrary();
  const { check, rotate, copyLines, remove } = useProxyActions();
  const [tab, setTab] = useState<Tab>('all');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [pageSize, setPageSize] = useStored<number>('pageSize', 50);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<LibProxy | null>(null);
  const [assigning, setAssigning] = useState(false);

  useEvent('proxy', (d: { id: string; check: ProxyCheck | null }) => patchCheck(d.id, d.check));

  // Bindings live on the profiles: refetch when any profile's proxy changes, or on a rescan.
  const bindings = sessions.map((s) => `${s.id}=${s.proxy ? `${s.proxy.host}:${s.proxy.port}` : ''}`).join('|');
  useEffect(() => {
    void reload();
  }, [bindings, resources]);

  const all = useMemo(() => list ?? [], [list]);
  const counts = useMemo(
    () => ({ all: all.length, unused: all.filter((p) => !p.isAssigned).length, errors: all.filter(failed).length }),
    [all]
  );
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((p) => {
      if (tab === 'unused' && p.isAssigned) return false;
      if (tab === 'errors' && !failed(p)) return false;
      if (!q) return true;
      const c = p.check;
      return [p.name, p.host, String(p.port), p.username, p.scheme, p.notes, p.assignedTo, c?.ip, c?.country, c?.countryCode, c?.city]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
  }, [all, tab, query]);
  const paged = usePaged(rows, pageSize, `${tab}|${query}`);

  const byId = useMemo(() => new Map(all.map((p) => [p.id, p])), [all]);
  const chosen = picked.map((id) => byId.get(id)).filter((p): p is LibProxy => Boolean(p));
  const chosenSet = new Set(chosen.map((p) => p.id));
  const shown = paged.slice;
  const shownPicked = shown.filter((p) => chosenSet.has(p.id)).length;
  const head: boolean | 'mixed' = !shown.length || !shownPicked ? false : shownPicked === shown.length ? true : 'mixed';
  const toggle = (id: string) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const toggleShown = () => {
    const ids = shown.map((p) => p.id);
    setPicked((cur) => (head === true ? cur.filter((id) => !ids.includes(id)) : [...new Set([...cur, ...ids])]));
  };

  const narrowed = tab !== 'all' || query.trim() !== '';
  const idle = rows.filter((p) => !busy.has(p.id));

  return (
    <>
      <Toolbar title="Proxies" count={list ? all.length : undefined}>
        <div className="seg" role="group" aria-label="Show">
          {(
            [
              ['all', 'All'],
              ['unused', 'Unused'],
              ['errors', 'Errors'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>
              {label} <span className="n">{counts[id]}</span>
            </button>
          ))}
        </div>
        <div className="field search">
          <Search size={14} />
          <input
            type="search"
            data-search=""
            className="input"
            placeholder="Name, host, IP, country…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search proxies"
          />
        </div>
        <button
          className="btn"
          onClick={() => check(idle.map((p) => p.id))}
          disabled={!idle.length}
          title={busy.size ? `${busy.size} checking` : undefined}
        >
          {busy.size ? <Loader2 size={13} className="spin" /> : <Zap size={13} />}
          {narrowed ? `Check ${rows.length}` : 'Check all'}
        </button>
        <button className="btn primary" onClick={() => setAdding(true)}>
          <Plus size={14} /> Add proxies
        </button>
      </Toolbar>

      <div className={`view${chosen.length ? ' pad-bulk' : ''}`}>
        {!list ? (
          <div className="table-wrap">
            {error ? (
              <Empty
                icon={<FaceHuddle mood="puzzled" />}
                text="Could not load proxies"
                hint={error}
                action={
                  <button className="btn" onClick={() => reload()}>
                    <RefreshCw size={13} /> Retry
                  </button>
                }
              />
            ) : (
              <Empty icon={<Loader2 size={18} className="spin dim" />} text="Loading proxies…" />
            )}
          </div>
        ) : !all.length ? (
          <div className="table-wrap">
            <Empty
              icon={<FaceHuddle mood="calm" />}
              text="No proxies yet"
              hint="Paste them in any common format, or drop a .txt into resources/proxies."
              action={
                <button className="btn primary" onClick={() => setAdding(true)}>
                  <Plus size={14} /> Paste proxies
                </button>
              }
            />
          </div>
        ) : !rows.length ? (
          <div className="table-wrap">
            <Empty
              icon={<FaceHuddle mood={tab === 'errors' && !query ? 'calm' : 'puzzled'} />}
              text={tab === 'errors' && !query ? 'No failed proxies' : tab === 'unused' && !query ? 'Every proxy is in use' : 'Nothing matches'}
              action={
                narrowed ? (
                  <button
                    className="btn"
                    onClick={() => {
                      setTab('all');
                      setQuery('');
                    }}
                  >
                    <X size={13} /> Show all
                  </button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div className="table-wrap">
            <div className="table-scroll">
              <table className="tbl px-table">
                <thead>
                  <tr>
                    <th className="tight">
                      <CheckBox state={head} onClick={toggleShown} label="Select all shown" />
                    </th>
                    <th className="tight">
                      <span className="sr-only">Status</span>
                    </th>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Address</th>
                    <th>Exit IP</th>
                    <th className="num">Latency</th>
                    <th>Profile</th>
                    <th>Checked</th>
                    <th>Notes</th>
                    <th className="tight" />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((p) => {
                    const c = p.check;
                    const fresh = healthOf(c);
                    const owner = liveOwner(p.assignedTo);
                    const isBusy = busy.has(p.id);
                    return (
                      <tr key={p.id} data-selected={chosenSet.has(p.id)}>
                        <td className="tight">
                          <CheckBox state={chosenSet.has(p.id)} onClick={() => toggle(p.id)} label={`Select ${labelOf(p)}`} />
                        </td>
                        <td className="tight">
                          <StatusDot check={c} busy={isBusy} />
                        </td>
                        <td>{p.name ? <span className="name px-name">{p.name}</span> : <span className="dim">—</span>}</td>
                        <td>
                          <span className="px-type">{p.scheme}</span>
                        </td>
                        <td>
                          <span className="inline px-addr">
                            <span className="mono">
                              {p.host}:{p.port}
                            </span>
                            {p.username && <span className="dim px-user" title={`User ${p.username}`}>{p.username}</span>}
                            <CopyButton value={p.line} label="Copy line (no password)" className="reveal" />
                          </span>
                        </td>
                        <td>
                          {c?.ok ? (
                            <span className={fresh === 'stale' ? 'px-stale' : undefined}>
                              <span className="name mono">
                                {flag(c.countryCode) && <span aria-hidden="true">{flag(c.countryCode)} </span>}
                                {c.ip || '—'}
                              </span>
                              <span className="sub">{[c.city, c.country].filter(Boolean).join(', ') || '—'}</span>
                            </span>
                          ) : c ? (
                            <span className="px-err px-clip" title={c.error || ''}>
                              {c.error || 'unreachable'}
                            </span>
                          ) : (
                            <span className="dim">—</span>
                          )}
                        </td>
                        <td className={`num${c?.ok && (c.latency ?? 0) > 1500 ? ' px-slow' : ''}`}>
                          {c?.ok && c.latency != null ? `${c.latency} ms` : <span className="dim">—</span>}
                        </td>
                        <td>
                          {owner ? (
                            <button className="px-link" onClick={() => openProfile(owner)} title={`Open ${owner}`}>
                              {owner}
                            </button>
                          ) : p.assignedTo ? (
                            <span className="dim px-clip" title="Held by a profile in the trash">
                              {p.assignedTo}
                            </span>
                          ) : (
                            <span className="dim">—</span>
                          )}
                        </td>
                        <td className="dim" title={c ? new Date(c.at).toLocaleString() : undefined}>
                          {c ? ago(c.at) : 'never'}
                        </td>
                        <td>
                          {p.notes ? (
                            <span className="px-clip px-notes" title={p.notes}>
                              {p.notes}
                            </span>
                          ) : (
                            <span className="dim">—</span>
                          )}
                        </td>
                        <td className="tight">
                          <div className="inline" style={{ gap: 4, justifyContent: 'flex-end' }}>
                            <button className="btn xs" onClick={() => check([p.id])} disabled={isBusy}>
                              <Zap size={11} /> Check
                            </button>
                            <Menu
                              fixed
                              trigger={(t) => (
                                <button className="icon-btn xs" aria-label={`More for ${labelOf(p)}`} {...t}>
                                  <MoreHorizontal size={15} />
                                </button>
                              )}
                            >
                              {(close) => (
                                <>
                                  {p.changeIpUrl && (
                                    <button disabled={isBusy} onClick={() => (close(), rotate(p))}>
                                      <RefreshCw size={13} /> Change IP
                                    </button>
                                  )}
                                  <button onClick={() => (close(), setEditing(p))}>
                                    <Pencil size={13} /> Edit…
                                  </button>
                                  <button onClick={() => (close(), copyLines([p]))}>
                                    <Copy size={13} /> Copy line
                                  </button>
                                  <hr />
                                  <button className="danger" onClick={() => (close(), remove([p]))}>
                                    <Trash2 size={13} /> Delete…
                                  </button>
                                </>
                              )}
                            </Menu>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pager paged={paged} total={rows.length} noun="proxies" pageSize={pageSize} onPageSize={setPageSize} />
          </div>
        )}
      </div>

      {chosen.length > 0 && (
        <div className={`bulkbar${openId ? ' beside-drawer' : ''}`} role="toolbar" aria-label="Selected proxies">
          <span className="count">{chosen.length} selected</span>
          <button
            className="btn xs"
            onClick={() => check(chosen.filter((p) => !busy.has(p.id)).map((p) => p.id))}
            disabled={chosen.every((p) => busy.has(p.id))}
          >
            <Zap size={11} /> Check
          </button>
          <button className="btn xs" onClick={() => copyLines(chosen)}>
            <Copy size={11} /> Copy lines
          </button>
          <button
            className="btn xs"
            onClick={() => setAssigning(true)}
            disabled={!selectedIds.length}
            title={selectedIds.length ? undefined : 'Select profiles on the Profiles page first'}
          >
            <UserRoundPlus size={12} />
            {selectedIds.length ? `Assign to ${selectedIds.length} selected ${selectedIds.length === 1 ? 'profile' : 'profiles'}` : 'Assign to selected profiles'}
          </button>
          <button
            className="btn xs danger"
            onClick={async () => {
              if (await remove(chosen)) setPicked([]);
            }}
          >
            <Trash2 size={11} /> Delete
          </button>
          <span className="vr" />
          <button className="icon-btn xs" onClick={() => setPicked([])} aria-label="Clear selection">
            <X size={14} />
          </button>
        </div>
      )}

      {adding && (
        <AddDialog
          onClose={() => setAdding(false)}
          onAdded={(ids, andCheck) => {
            void refresh.resources();
            void reload().then(() => (andCheck ? check(ids) : undefined));
          }}
        />
      )}
      {editing && <EditDialog proxy={editing} onClose={() => setEditing(null)} />}
      {assigning && <AssignDialog profileIds={selectedIds} proxyIds={chosen.map((p) => p.id)} onClose={() => setAssigning(false)} />}
    </>
  );
};
