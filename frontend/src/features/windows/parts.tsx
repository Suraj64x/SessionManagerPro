import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AppWindow, ChevronDown, Layers, LayoutGrid, LoaderCircle, Maximize2, Minimize2, Radio, Upload } from 'lucide-react';
import type { PoolStatus, SessionRecord } from '../../types';
import { useApp } from '../../app-context';
import { Empty, Menu, Modal, Picker, pickTextFile, useStored, useUI } from '../../ui';
import { Avatar, FaceHuddle } from '../../faces';
import { windowsApi } from './api';
import type { BroadcastRequest, Results, WindowAction } from './api';

// The pieces index.tsx contributes: focus, arrange and broadcast.

type Toast = ReturnType<typeof useUI>['toast'];

/** Headless profiles have no window the OS can move (ENGINE.md §1, `window`). */
const hasWindow = (pool: PoolStatus | null, id: string) => {
  const l = pool?.live.find((x) => x.id === id);
  return !!l && !l.headless;
};
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const DONE: Record<WindowAction, string> = {
  focus: 'Focused',
  cascade: 'Cascaded',
  tile: 'Tiled',
  minimize: 'Minimized',
  restore: 'Restored',
};

async function windowAction(ids: string[], action: WindowAction, toast: Toast, quietOk = false) {
  try {
    const { results } = await windowsApi.window(ids, action);
    const all = Object.entries(results);
    const failed = all.filter(([, r]) => !r.ok);
    if (!failed.length) {
      if (!quietOk) toast('success', `${DONE[action]} ${plural(all.length, 'window')}`);
    } else if (all.length === 1) {
      toast('error', failed[0][1].error || 'Failed');
    } else {
      toast('error', `${DONE[action]} ${all.length - failed.length} of ${all.length} · ${failed[0][0]}: ${failed[0][1].error}`);
    }
  } catch (e) {
    toast('error', errMsg(e));
  }
}

/* ---------------- row menu, live row ---------------- */

export const FocusItem: React.FC<{ session: SessionRecord; close: () => void }> = ({ session, close }) => {
  const { pool } = useApp();
  const { toast } = useUI();
  if (session.status !== 'live' || !hasWindow(pool, session.id)) return null;
  return (
    <button onClick={() => (close(), windowAction([session.id], 'focus', toast, true))}>
      <AppWindow size={12} /> Focus window
    </button>
  );
};

export const FocusButton: React.FC<{ session: SessionRecord }> = ({ session }) => {
  const { pool } = useApp();
  const { toast } = useUI();
  const [busy, setBusy] = useState(false);
  if (!hasWindow(pool, session.id)) return null;
  return (
    <button
      className="btn xs"
      disabled={busy}
      title="Bring its window to the front"
      aria-label={`Focus ${session.id} window`}
      onClick={async () => {
        setBusy(true);
        await windowAction([session.id], 'focus', toast, true);
        setBusy(false);
      }}
    >
      <AppWindow size={11} /> Focus
    </button>
  );
};

/* ---------------- bulk bar ---------------- */

export const ArrangeMenu: React.FC<{ live: SessionRecord[] }> = ({ live }) => {
  const { pool } = useApp();
  const { toast } = useUI();
  const [busy, setBusy] = useState(false);
  const ids = live.filter((s) => hasWindow(pool, s.id)).map((s) => s.id);
  const run = async (action: WindowAction, close: () => void) => {
    close();
    setBusy(true);
    await windowAction(ids, action, toast);
    setBusy(false);
  };
  const item = (action: WindowAction, icon: React.ReactNode, label: string, close: () => void) => (
    <button onClick={() => run(action, close)}>
      {icon} {label}
    </button>
  );
  return (
    <Menu
      up
      trigger={(t) => (
        <button
          className="btn xs"
          {...t}
          disabled={ids.length < 2 || busy}
          title={ids.length < 2 ? 'Select at least 2 running profiles with a window' : undefined}
        >
          {busy ? <LoaderCircle size={12} className="spin" /> : <LayoutGrid size={12} />} Arrange <ChevronDown size={11} />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="menu-head">{plural(ids.length, 'window')}</div>
          {item('cascade', <Layers size={12} />, 'Cascade', close)}
          <button className="win-two" onClick={() => run('tile', close)}>
            <LayoutGrid size={12} />
            <span>
              Tile
              <span className="hint">overview — pages are clipped, not reflowed, because the engine pins each viewport to its fingerprint</span>
            </span>
          </button>
          <hr />
          {item('minimize', <Minimize2 size={12} />, 'Minimize all', close)}
          {item('restore', <Maximize2 size={12} />, 'Restore all', close)}
        </>
      )}
    </Menu>
  );
};

export const BroadcastButton: React.FC<{ live: SessionRecord[] }> = ({ live }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="btn xs"
        disabled={!live.length}
        title={live.length ? undefined : 'Select a running profile'}
        onClick={() => setOpen(true)}
      >
        <Radio size={12} /> Broadcast…
      </button>
      {/* Portaled: the bulk bar is translated, which would pin a fixed scrim to it. */}
      {open && createPortal(<BroadcastDialog live={live} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
};

/* ---------------- broadcast dialog ---------------- */

type Action = 'open_new' | 'open_current' | 'reload' | 'close_other_tabs' | 'type' | 'press' | 'scroll';
const ACTIONS: Array<[Action, string]> = [
  ['open_new', 'Open URL in a new tab'],
  ['open_current', 'Open URL in the current tab'],
  ['reload', 'Reload'],
  ['close_other_tabs', 'Close other tabs'],
  ['type', 'Type text'],
  ['press', 'Press key'],
  ['scroll', 'Scroll'],
];
type TypeMode = 'same' | 'lines' | 'random';
const TYPE_MODES: Array<[TypeMode, string]> = [
  ['same', 'Same text for all'],
  ['lines', 'One line per profile'],
  ['random', 'Random number'],
];
// Mirrors the server's allow-list: no modifiers, so a stray Control+W cannot close every window.
const KEYS = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Space', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageDown', 'PageUp', 'F5'];
const isKey = (k: string) => KEYS.includes(k) || /^[a-zA-Z0-9]$/.test(k);
const isUrl = (u: string) => {
  if (u === 'about:blank') return true;
  try {
    return ['http:', 'https:'].includes(new URL(u).protocol);
  } catch {
    return false;
  }
};
const MAX_TEXT = 2000;

interface Form {
  action: Action;
  url: string;
  mode: TypeMode;
  min: string;
  max: string;
  key: string;
  dy: string;
}
const INITIAL: Form = { action: 'open_new', url: '', mode: 'same', min: '1', max: '100', key: 'Enter', dy: '600' };

/** The request for the form, or why it cannot be sent. Typed text is never stored. */
function build(f: Form, text: string, lines: string[], ids: string[]): BroadcastRequest | string {
  switch (f.action) {
    case 'open_new':
    case 'open_current': {
      const url = f.url.trim();
      if (!url) return 'Enter a URL';
      if (!isUrl(url)) return 'URL must start with http:// or https://';
      return { op: 'open_url', args: { url, where: f.action === 'open_new' ? 'new' : 'current' } };
    }
    case 'reload':
    case 'close_other_tabs':
      return { op: f.action };
    case 'press':
      return isKey(f.key) ? { op: 'press', args: { key: f.key } } : 'Pick a key from the list, or one letter or digit';
    case 'scroll': {
      const dy = Number(f.dy);
      return f.dy.trim() && Number.isFinite(dy) && Math.abs(dy) <= 20000 ? { op: 'scroll', args: { dy } } : 'Pixels must be a number within ±20000';
    }
    case 'type': {
      if (f.mode === 'random') {
        const [min, max] = [Number(f.min), Number(f.max)];
        if (!f.min.trim() || !f.max.trim() || !Number.isInteger(min) || !Number.isInteger(max)) return 'Enter two whole numbers';
        return min <= max ? { op: 'type', args: { random: [min, max] } } : '“From” must not be above “to”';
      }
      if (f.mode === 'same') {
        if (!text) return 'Enter the text to type';
        return text.length > MAX_TEXT ? `At most ${MAX_TEXT} characters` : { op: 'type', args: { text } };
      }
      const perProfile: Record<string, { text: string }> = {};
      ids.forEach((id, i) => lines[i] && (perProfile[id] = { text: lines[i] }));
      if (!Object.keys(perProfile).length) return 'Enter one line per profile';
      return lines.some((l) => l.length > MAX_TEXT) ? `At most ${MAX_TEXT} characters a line` : { op: 'type', perProfile };
    }
  }
}

/** What a successful result shows beside "ok". */
const okValue = (action: Action, value: unknown) => {
  if (action === 'close_other_tabs' && typeof value === 'number') return `${value} closed`;
  if (action === 'type' && typeof value === 'string') return value;
  return '';
};

const BroadcastDialog: React.FC<{ live: SessionRecord[]; onClose: () => void }> = ({ live, onClose }) => {
  const { toast } = useUI();
  const [form, setForm] = useStored<Form>('windows.broadcast', INITIAL);
  const f: Form = { ...INITIAL, ...form };
  const set = (patch: Partial<Form>) => setForm({ ...f, ...patch });
  const [text, setText] = useState('');
  const [linesText, setLinesText] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ action: Action; ids: string[]; results: Results | null } | null>(null);
  const namesRef = useRef<HTMLDivElement>(null);

  const ids = live.map((s) => s.id);
  const lines = linesText.split(/\r?\n/);
  const req = build(f, text, lines, ids);
  const byLine = f.action === 'type' && f.mode === 'lines';
  // A profile without a line is skipped, not sent an empty string.
  const targets = byLine ? ids.filter((_, i) => lines[i]) : ids;
  const extra = lines.filter((l, i) => i >= ids.length && l).length;
  const rows = Math.min(Math.max(ids.length, 3), 10);

  const send = async () => {
    if (typeof req === 'string' || busy || !targets.length) return;
    setBusy(true);
    setSent({ action: f.action, ids: targets, results: null });
    try {
      const { results } = await windowsApi.broadcast(targets, req);
      setSent({ action: f.action, ids: targets, results });
    } catch (e) {
      setSent(null);
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      send();
    }
  };

  const okCount = sent?.results ? Object.values(sent.results).filter((r) => r.ok).length : 0;
  const byId = new Map(live.map((s) => [s.id, s]));

  return (
    <Modal
      title="Broadcast"
      width={640}
      onClose={onClose}
      footer={
        <>
          {ids.length > 0 && typeof req === 'string' && <span className="hint win-why">{req}</span>}
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" disabled={busy || !targets.length || typeof req === 'string'} onClick={send}>
            {busy && <LoaderCircle size={13} className="spin" />}
            Send to {plural(targets.length, 'profile')}
          </button>
        </>
      }
    >
      {!ids.length ? (
        <Empty
          icon={<FaceHuddle mood="calm" />}
          text="None of the selected profiles is running"
          hint="Broadcast reaches running profiles only."
          action={
            <button className="btn" onClick={onClose}>
              Close
            </button>
          }
        />
      ) : (
        <div
          className="form"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              send();
            }
          }}
        >
          <div className="row">
            <label htmlFor="win-action">Action</label>
            <Picker
              id="win-action"
              block
              label="Action"
              value={f.action}
              onChange={(v) => set({ action: v as Action })}
              options={ACTIONS.map(([id, label]) => ({ value: id, label }))}
            />
          </div>

          {(f.action === 'open_new' || f.action === 'open_current') && (
            <div className="row">
              <label htmlFor="win-url">URL</label>
              <input
                id="win-url"
                className="input mono"
                placeholder="https://"
                value={f.url}
                maxLength={2000}
                spellCheck={false}
                onChange={(e) => set({ url: e.target.value })}
                onKeyDown={onEnter}
              />
            </div>
          )}

          {f.action === 'close_other_tabs' && <p className="hint">Keeps each profile’s active tab and closes the rest.</p>}

          {f.action === 'type' && (
            <>
              <div className="seg win-seg" role="group" aria-label="What to type">
                {TYPE_MODES.map(([id, label]) => (
                  <button key={id} aria-pressed={f.mode === id} onClick={() => set({ mode: id })}>
                    {label}
                  </button>
                ))}
              </div>
              {f.mode === 'same' && (
                <div className="row">
                  <label htmlFor="win-text">Text</label>
                  <input
                    id="win-text"
                    className="input"
                    value={text}
                    maxLength={MAX_TEXT}
                    autoComplete="off"
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={onEnter}
                  />
                </div>
              )}
              {f.mode === 'lines' && (
                <div className="row">
                  <div className="inline">
                    <label htmlFor="win-lines" className="row-label">
                      Lines, in the order of the profiles
                    </label>
                    <span className="grow" />
                    <button
                      className="btn xs ghost"
                      onClick={async () => {
                        const t = await pickTextFile('.txt,.csv,text/plain');
                        if (t !== null) setLinesText(t.replace(/\r?\n$/, ''));
                      }}
                    >
                      <Upload size={11} /> From file
                    </button>
                  </div>
                  <div className="win-lines" style={{ '--rows': rows } as React.CSSProperties}>
                    <div className="win-names" ref={namesRef} aria-hidden="true">
                      {live.map((s, i) => (
                        <div key={s.id} className={lines[i] ? undefined : 'win-missing'} title={s.id}>
                          <Avatar s={s} size={14} />
                          <span>{s.id}</span>
                        </div>
                      ))}
                    </div>
                    <textarea
                      id="win-lines"
                      className="input mono"
                      rows={rows}
                      wrap="off"
                      spellCheck={false}
                      value={linesText}
                      onChange={(e) => setLinesText(e.target.value)}
                      onScroll={(e) => namesRef.current && (namesRef.current.scrollTop = e.currentTarget.scrollTop)}
                    />
                  </div>
                  <span className="hint">
                    {targets.length} of {plural(ids.length, 'profile')} have a line
                    {targets.length > 0 && targets.length < ids.length && ' · the rest are skipped'}
                    {extra > 0 && ` · ${plural(extra, 'extra line')} ignored`}
                  </span>
                </div>
              )}
              {f.mode === 'random' && (
                <div className="inline">
                  <div className="row">
                    <label htmlFor="win-min">From</label>
                    <input id="win-min" className="input win-num" type="number" step={1} value={f.min} onChange={(e) => set({ min: e.target.value })} onKeyDown={onEnter} />
                  </div>
                  <div className="row">
                    <label htmlFor="win-max">To</label>
                    <input id="win-max" className="input win-num" type="number" step={1} value={f.max} onChange={(e) => set({ max: e.target.value })} onKeyDown={onEnter} />
                  </div>
                  <span className="hint win-random-hint">A new whole number for each profile</span>
                </div>
              )}
              <p className="hint">Types into whatever has focus on each profile’s active tab, key by key.</p>
            </>
          )}

          {f.action === 'press' && (
            <div className="row">
              <label htmlFor="win-key">Key</label>
              <input
                id="win-key"
                className="input mono win-short"
                list="win-keys"
                value={f.key}
                spellCheck={false}
                onChange={(e) => set({ key: e.target.value.trim() })}
                onKeyDown={onEnter}
              />
              <datalist id="win-keys">
                {KEYS.map((k) => (
                  <option key={k} value={k} />
                ))}
              </datalist>
              <span className="hint">A named key or one letter or digit</span>
            </div>
          )}

          {f.action === 'scroll' && (
            <div className="row">
              <label htmlFor="win-dy">Pixels</label>
              <input id="win-dy" className="input win-num win-short" type="number" step={100} value={f.dy} onChange={(e) => set({ dy: e.target.value })} onKeyDown={onEnter} />
              <span className="hint">Negative scrolls up</span>
            </div>
          )}

          {sent && (
            <div className="win-results" aria-live="polite">
              <div className="row-label">
                {ACTIONS.find(([id]) => id === sent.action)?.[1]}
                {sent.results ? (
                  <>
                    {' · '}
                    <span className={okCount === sent.ids.length ? 'st-ok' : 'st-error'}>
                      {okCount} of {sent.ids.length} ok
                    </span>
                  </>
                ) : (
                  ' · sending…'
                )}
              </div>
              <ul>
                {sent.ids.map((id) => {
                  const r = sent.results?.[id];
                  const v = r?.ok ? okValue(sent.action, r.value) : '';
                  return (
                    <li key={id}>
                      <Avatar s={byId.get(id) ?? { id }} size={16} />
                      <span className="name" title={id}>
                        {id}
                      </span>
                      {!r ? (
                        <span className="chip">
                          <LoaderCircle size={10} className="spin" /> Sending
                        </span>
                      ) : r.ok ? (
                        <span className="chip ok">ok</span>
                      ) : (
                        <span className="chip fail">failed</span>
                      )}
                      {r && (r.ok ? v && <span className="detail mono" title={v}>{v}</span> : <span className="detail reason" title={r.error}>{r.error}</span>)}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
};
