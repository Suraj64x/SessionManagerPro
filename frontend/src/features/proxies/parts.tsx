import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, CircleAlert, CircleCheck, Copy, FileText, Loader2 } from 'lucide-react';
import { useApp } from '../../app-context';
import { Avatar, Modal, Picker, ago, pickTextFile, useStored, useUI } from '../../ui';
import { api } from './api';
import { healthOf, reload } from './store';
import type { AssignSource, AssignValue, LibProxy, ParseRow, PlanRow, ProxyCheck, Scheme } from './types';

const SCHEMES: Scheme[] = ['http', 'https', 'socks4', 'socks5'];

/* ---------------- status dot ---------------- */

export const StatusDot: React.FC<{ check: ProxyCheck | null; busy?: boolean }> = ({ check, busy }) => {
  if (busy) return <Loader2 size={12} className="spin px-busy" aria-label="Checking" />;
  const h = healthOf(check);
  const title =
    h === 'unchecked'
      ? 'Not checked yet'
      : h === 'ok'
        ? `Working · checked ${ago(check!.at)}`
        : h === 'failed'
          ? `Failed: ${check!.error || 'unreachable'} · ${ago(check!.at)}`
          : `Last checked ${ago(check!.at)} (${check!.ok ? 'worked' : 'failed'}), check again`;
  return <span className={`px-dot ${h}`} role="img" aria-label={title} title={title} />;
};

/* ---------------- add ---------------- */

const PLACEHOLDER = `socks5://user:pass@host:port
host:port:user:pass [https://change-ip-url] {Name}
user:pass@host:port
host:port`;

export const AddDialog: React.FC<{ onClose: () => void; onAdded: (ids: string[], check: boolean) => void }> = ({
  onClose,
  onAdded,
}) => {
  const { toast } = useUI();
  const [text, setText] = useState('');
  const [scheme, setScheme] = useStored<'http' | 'socks5'>('proxies.scheme', 'http');
  const [checkAfter, setCheckAfter] = useStored('proxies.checkAfter', true);
  const [preview, setPreview] = useState<{ key: string; rows: ParseRow[]; error: string | null } | null>(null);
  const [saving, setSaving] = useState(false);

  const key = `${scheme}\n${text}`;
  const empty = !text.trim();
  useEffect(() => {
    if (!text.trim()) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      api.parse(text, scheme, ctl.signal).then(
        (rows) => setPreview({ key: `${scheme}\n${text}`, rows, error: null }),
        (err: Error) => err.name !== 'AbortError' && setPreview({ key: `${scheme}\n${text}`, rows: [], error: err.message })
      );
    }, 300);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [text, scheme]);

  const cur = !empty && preview?.key === key ? preview : null;
  const fresh = cur !== null;
  const rows = cur ? cur.rows : [];
  const adding = rows.filter((r) => r.ok && !r.duplicate).length;
  const dupes = rows.filter((r) => r.duplicate).length;
  const bad = rows.filter((r) => !r.ok).length;

  const load = async () => {
    const t = await pickTextFile('.txt,.csv,text/plain');
    if (t === null) return;
    setText((cur) => (cur.trim() ? `${cur.trimEnd()}\n${t}` : t));
  };

  const add = async () => {
    if (!fresh || !adding || saving) return;
    setSaving(true);
    try {
      const r = await api.add(text, scheme);
      if (!r.added) {
        toast('info', 'Nothing new to add');
        return;
      }
      toast(
        'success',
        `Added ${r.added} ${r.added === 1 ? 'proxy' : 'proxies'}${r.errors.length ? `, ${r.errors.length} ${r.errors.length === 1 ? 'line' : 'lines'} skipped` : ''}`
      );
      onAdded(
        r.proxies.map((p) => p.id),
        checkAfter
      );
      onClose();
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Add proxies"
      width={640}
      onClose={onClose}
      footer={
        <>
          <label className="switch px-foot-left">
            <input type="checkbox" checked={checkAfter} onChange={(e) => setCheckAfter(e.target.checked)} />
            Check after adding
          </label>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={add} disabled={!fresh || !adding || saving}>
            {saving && <Loader2 size={13} className="spin" />}
            {adding ? `Add ${adding}` : 'Add'}
          </button>
        </>
      }
    >
      <div className="row">
        <label htmlFor="px-paste">One proxy per line</label>
        <textarea
          id="px-paste"
          className="input mono px-paste"
          rows={8}
          spellCheck={false}
          placeholder={PLACEHOLDER}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void add();
            }
          }}
        />
        {/* After the textarea: the dialog focuses its first field. */}
        <div className="inline">
          <span className="hint grow">Optional [change-IP URL] {'{name}'} after a line. Ctrl+Enter adds.</span>
          <span className="px-scheme">
            <Picker
              block
              label="Type for lines without a scheme"
              value={scheme}
              onChange={(v) => setScheme(v as 'http' | 'socks5')}
              options={[
                { value: 'http', label: 'HTTP by default' },
                { value: 'socks5', label: 'SOCKS5 by default' },
              ]}
            />
          </span>
          <button className="btn xs" onClick={load}>
            <FileText size={12} /> Load .txt
          </button>
        </div>
      </div>

      {!empty && (
        <div className="px-preview" aria-live="polite">
          <div className="px-preview-head">
            {!cur ? (
              <>
                <Loader2 size={12} className="spin" /> Reading lines…
              </>
            ) : cur.error ? (
              <span className="px-err">{cur.error}</span>
            ) : (
              <>
                <b>{adding}</b> new
                {dupes > 0 && (
                  <>
                    {' · '}
                    <b>{dupes}</b> already in the library
                  </>
                )}
                {bad > 0 && (
                  <>
                    {' · '}
                    <b className="px-err">{bad}</b> {bad === 1 ? 'error' : 'errors'}
                  </>
                )}
              </>
            )}
          </div>
          {fresh && rows.length > 0 && (
            <ul className="px-lines">
              {rows.slice(0, 300).map((r, i) => (
                <li key={i} className={!r.ok ? 'bad' : r.duplicate ? 'dup' : 'ok'}>
                  {!r.ok ? <CircleAlert size={13} /> : r.duplicate ? <Copy size={13} /> : <CircleCheck size={13} />}
                  <span className="mono px-line" title={r.line}>
                    {r.line}
                  </span>
                  <span className="px-what">
                    {!r.ok
                      ? r.error?.replace(/^invalid proxy "[^"]*" — (expected .*)?/, '') || 'not a proxy line'
                      : r.duplicate
                        ? 'duplicate'
                        : `${r.proxy!.scheme.toUpperCase()}${r.proxy!.name ? ` · ${r.proxy!.name}` : ''}${r.proxy!.changeIpUrl ? ' · change-IP' : ''}`}
                  </span>
                </li>
              ))}
              {rows.length > 300 && <li className="dup">+{rows.length - 300} more</li>}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
};

/* ---------------- edit ---------------- */

export const EditDialog: React.FC<{ proxy: LibProxy; onClose: () => void }> = ({ proxy: p, onClose }) => {
  const { toast } = useUI();
  const { refresh } = useApp();
  const [f, setF] = useState({
    name: p.name,
    scheme: p.scheme,
    username: p.username,
    changeIpUrl: p.changeIpUrl,
    notes: p.notes,
  });
  // Blank means "keep": the panel never learns the stored password.
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((cur) => ({ ...cur, [k]: v }));
  const urlBad = f.changeIpUrl.trim() !== '' && !/^https?:\/\/\S+$/i.test(f.changeIpUrl.trim());

  const save = async () => {
    if (urlBad || saving) return;
    setSaving(true);
    try {
      await api.update(p.id, { ...f, ...(password ? { password } : {}) });
      toast('success', 'Saved');
      await reload();
      void refresh.resources();
      onClose();
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Edit ${p.host}:${p.port}`}
      width={480}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={urlBad || saving}>
            {saving && <Loader2 size={13} className="spin" />} Save
          </button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="px-grid">
          <div className="row">
            <label htmlFor="px-name">Name</label>
            <input id="px-name" className="input" maxLength={60} value={f.name} onChange={(e) => set('name', e.target.value)} />
          </div>
          <div className="row">
            <label htmlFor="px-type">Type</label>
            <Picker
              id="px-type"
              block
              label="Type"
              value={f.scheme}
              onChange={(v) => set('scheme', v as Scheme)}
              options={SCHEMES.map((s) => ({ value: s, label: s.toUpperCase() }))}
            />
          </div>
          <div className="row">
            <label htmlFor="px-user">Username</label>
            <input
              id="px-user"
              className="input"
              autoComplete="off"
              maxLength={200}
              value={f.username}
              onChange={(e) => set('username', e.target.value)}
            />
          </div>
          <div className="row">
            <label htmlFor="px-pass">Password</label>
            <input
              id="px-pass"
              className="input"
              type="password"
              autoComplete="new-password"
              maxLength={200}
              placeholder={p.hasPassword ? 'Unchanged' : 'None'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        </div>
        <div className="row">
          <label htmlFor="px-rot">Change-IP URL</label>
          <input
            id="px-rot"
            className="input mono"
            placeholder="https://…"
            value={f.changeIpUrl}
            aria-invalid={urlBad}
            onChange={(e) => set('changeIpUrl', e.target.value)}
          />
          {urlBad ? <span className="hint px-err">Must start with http:// or https://</span> : <span className="hint">Opened to rotate the exit IP.</span>}
        </div>
        <div className="row">
          <label htmlFor="px-notes">Notes</label>
          <textarea id="px-notes" className="input" rows={3} maxLength={500} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        </div>
        {p.isAssigned && <p className="hint">{p.assignedTo} keeps its own copy of the address and login until it is assigned again.</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
};

/* ---------------- assign ---------------- */

/**
 * Previews then applies the `proxy` bulk action for `profileIds`. Portalled to <body>: the
 * profiles bulk bar is translated, which would otherwise anchor this fixed dialog to it.
 */
export const AssignDialog: React.FC<{ profileIds: string[]; proxyIds?: string[]; onClose: () => void }> = ({
  profileIds,
  proxyIds = [],
  onClose,
}) => {
  const { sessions, refresh } = useApp();
  const { toast } = useUI();
  const [source, setSource] = useState<AssignSource>(proxyIds.length ? 'ids' : 'unused');
  const [order, setOrder] = useStored<'sequential' | 'random'>('proxies.order', 'sequential');
  const [checkFirst, setCheckFirst] = useStored('proxies.checkFirst', false);
  const [plan, setPlan] = useState<{ key: string; rows: PlanRow[]; error: string | null } | null>(null);
  const [applying, setApplying] = useState(false);

  const value: AssignValue = { source, order, ...(source === 'ids' ? { ids: proxyIds } : {}) };
  // Keyed by content: the callers pass fresh arrays on every render.
  const key = JSON.stringify([profileIds, value]);
  useEffect(() => {
    const [ids, v] = JSON.parse(key) as [string[], AssignValue];
    const ctl = new AbortController();
    const t = setTimeout(() => {
      api.plan(ids, v, ctl.signal).then(
        (r) => setPlan({ key, rows: r.plan, error: null }),
        (err: Error) => err.name !== 'AbortError' && setPlan({ key, rows: [], error: err.message })
      );
    }, 150);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [key]);

  const cur = plan?.key === key ? plan : null;
  const fresh = cur !== null;
  const rows = cur ? cur.rows : [];
  const ready = rows.filter((r) => r.proxy).length;
  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);

  const apply = async () => {
    if (!ready || applying) return;
    setApplying(true);
    try {
      const r = await api.assign(profileIds, { ...value, checkFirst });
      if (r.failed.length) toast(r.ok ? 'info' : 'error', `${r.ok} assigned, ${r.failed.length} not: ${r.failed[0].error}`);
      else toast('success', `Assigned ${r.ok} ${r.ok === 1 ? 'proxy' : 'proxies'}`);
      await Promise.all([refresh.sessions(), reload()]);
      void refresh.resources();
      onClose();
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setApplying(false);
    }
  };

  const sources: Array<[AssignSource, string]> = [
    ...(proxyIds.length ? [['ids', `Selected (${proxyIds.length})`] as [AssignSource, string]] : []),
    ['unused', 'Any unused'],
    ['unused-ok', 'Unused and working'],
  ];

  return createPortal(
    <Modal
      title={`Assign proxies to ${profileIds.length} ${profileIds.length === 1 ? 'profile' : 'profiles'}`}
      width={620}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={apply} disabled={!fresh || !ready || applying}>
            {applying && <Loader2 size={13} className="spin" />}
            {applying ? 'Assigning…' : ready ? `Assign ${ready}` : 'Assign'}
          </button>
        </>
      }
    >
      <div className="px-opts">
        <div className="row">
          <span className="row-label">From</span>
          <div className="seg" role="group" aria-label="Proxies to use">
            {sources.map(([id, label]) => (
              <button key={id} aria-pressed={source === id} onClick={() => setSource(id)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {source !== 'ids' && (
          <div className="row">
            <span className="row-label">Order</span>
            <div className="seg" role="group" aria-label="Order">
              <button aria-pressed={order === 'sequential'} onClick={() => setOrder('sequential')}>
                In order
              </button>
              <button aria-pressed={order === 'random'} onClick={() => setOrder('random')}>
                Random
              </button>
            </div>
          </div>
        )}
      </div>
      <label className="switch">
        <input type="checkbox" checked={checkFirst} onChange={(e) => setCheckFirst(e.target.checked)} />
        Check each proxy first and skip the ones that fail
      </label>
      <p className="hint">
        Each profile's fingerprint is rebuilt to match its new proxy.
        {checkFirst && ' Checks run while assigning, so failing proxies are replaced by the next ones.'}
        {source !== 'ids' && order === 'random' && ' Random order is drawn again when you apply.'}
      </p>

      <div className="table-wrap px-plan">
        {!cur ? (
          <div className="px-plan-state">
            <Loader2 size={13} className="spin" /> Planning…
          </div>
        ) : cur.error ? (
          <div className="alert">
            <CircleAlert size={14} /> {cur.error}
          </div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Profile</th>
                <th className="tight" aria-label="becomes" />
                <th>Proxy</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const s = byId.get(r.id);
                return (
                  <tr key={r.id}>
                    <td>
                      <div className="who">
                        <Avatar s={s || { id: r.id }} size={22} />
                        <span>
                          <span className="name">{r.id}</span>
                          <span className="sub mono">{s?.proxy ? `${s.proxy.host}:${s.proxy.port}` : 'no proxy'}</span>
                        </span>
                      </div>
                    </td>
                    <td className="tight dim">
                      <ArrowRight size={13} />
                    </td>
                    <td>
                      {r.proxy ? (
                        <div className="inline px-cell">
                          <StatusDot check={r.proxy.check} />
                          <span>
                            <span className="name mono">
                              {r.proxy.host}:{r.proxy.port}
                            </span>
                            <span className="sub">
                              {[r.proxy.name, r.proxy.scheme.toUpperCase(), r.proxy.check?.ip].filter(Boolean).join(' · ')}
                            </span>
                          </span>
                        </div>
                      ) : (
                        <span className="px-err">{r.error}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Modal>,
    document.body
  );
};
