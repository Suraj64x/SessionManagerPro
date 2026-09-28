import React, { useState } from 'react';
import { AppWindow, CircleAlert, FolderOpen, Loader2, Plus, Star, Trash2 } from 'lucide-react';
import { useApp } from '../../app-context';
import { Menu, Picker, useUI, type PickerOption } from '../../ui';
import { DEFAULT_ENGINE, browsersApi, kindLabel, refreshBrowsers, useBrowsers, type BrowserEntry } from './store';

const GROUPS: Array<{ label: string; test: (b: BrowserEntry) => boolean }> = [
  { label: 'Stealth', test: (b) => b.kind === 'stealth' || b.kind === 'camoufox' },
  { label: 'Chromium', test: (b) => b.kind === 'chromium' },
  { label: 'Firefox · manual only', test: (b) => b.kind === 'firefox-manual' },
];

const hintOf = (b: BrowserEntry) =>
  [b.version && !b.name.includes(b.version) ? b.version : '', b.installed ? '' : 'not installed', b.limited ? 'limited' : '']
    .filter(Boolean)
    .join(' · ');

/**
 * The engine picker for a profile: grouped, with what the chosen engine does underneath.
 * `inherit` adds a "Default" choice (value "") that follows Settings → Browsers.
 */
export const EngineSelect: React.FC<{ id: string; value: string; onChange: (id: string) => void; disabled?: boolean; inherit?: boolean }> = ({
  id,
  value,
  onChange,
  disabled,
  inherit,
}) => {
  const { data, error } = useBrowsers();
  const list = data?.browsers || [];
  const shown = inherit ? value : value || DEFAULT_ENGINE;
  const fallback = list.find((b) => b.id === data?.default);
  const current = shown ? list.find((b) => b.id === shown) : fallback;
  const options: PickerOption[] = [
    ...(data && inherit ? [{ value: '', label: 'Default', hint: fallback?.name }] : []),
    ...GROUPS.flatMap((g) =>
      list.filter(g.test).map((b) => ({ value: b.id, label: b.name, hint: hintOf(b), group: g.label, disabled: !b.installed && b.id !== value }))
    ),
    // A profile can name an engine this panel no longer offers; keep it selectable.
    ...(data && value && !list.some((b) => b.id === value) ? [{ value, label: value, hint: 'not offered any more' }] : []),
  ];
  return (
    <>
      <Picker
        id={id}
        block
        label="Browser engine"
        value={shown}
        onChange={onChange}
        disabled={disabled || !data}
        placeholder={error ? 'Browsers unavailable' : 'Loading…'}
        options={options}
      />
      {current?.note &&
        (current.limited ? (
          <span className="hint eng-warn">
            <CircleAlert size={12} /> {current.note}
          </span>
        ) : (
          <span className="hint">{current.note}</span>
        ))}
      {data && value && !list.some((b) => b.id === value) && (
        <span className="hint eng-warn">
          <CircleAlert size={12} /> This browser is no longer available; pick another before launching.
        </span>
      )}
    </>
  );
};

/** Bulk bar: move the selected profiles to another engine. Running ones are refused by the server. */
export const BulkBrowser: React.FC<{ ids: string[]; running: number }> = ({ ids, running }) => {
  const { bulk } = useApp();
  const { data } = useBrowsers();
  const choices = (data?.browsers || []).filter((b) => b.installed);
  return (
    <Menu
      fixed
      trigger={(t) => (
        <button className="btn xs" aria-haspopup="menu" disabled={!choices.length} {...t}>
          <AppWindow size={12} /> Browser…
        </button>
      )}
    >
      {(close) => (
        <div className="eng-menu" role="menu">
          <div className="menu-head">
            Run {ids.length} profile{ids.length > 1 ? 's' : ''} on
          </div>
          {choices.map((b) => (
            <button key={b.id} role="menuitem" onClick={() => (close(), bulk(ids, 'browser', b.id))}>
              <span className={`eng-cell ${b.family}`}>{b.name}</span>
              {b.limited && <span className="chip eng-limited">Limited</span>}
            </button>
          ))}
          {running > 0 && <div className="menu-head">{running} running: stop them first</div>}
        </div>
      )}
    </Menu>
  );
};

/** Settings → Browsers: every engine, the default for new profiles, and custom builds. */
export const EnginesSection: React.FC = () => {
  const { data, error } = useBrowsers();
  const { app, changeApp, sessions } = useApp();
  const { toast, confirm } = useUI();
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const defaultId = (app?.defaultBrowser as string | undefined) || data?.default || DEFAULT_ENGINE;
  const usage = (id: string) => sessions.filter((s) => (s.browser || DEFAULT_ENGINE) === id).length;

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!path.trim()) return;
    setBusy(true);
    try {
      const b = await browsersApi.addCustom(path.trim().replace(/^"|"$/g, ''), name.trim() || undefined);
      toast('success', `Added ${b.name}`);
      setPath('');
      setName('');
      await refreshBrowsers();
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (b: BrowserEntry) => {
    const ok = await confirm({ title: `Remove ${b.name}?`, body: 'Only the entry is removed; the files on disk stay.', confirmLabel: 'Remove', danger: true });
    if (!ok) return;
    try {
      await browsersApi.removeCustom(b.id);
      await refreshBrowsers();
    } catch (err: any) {
      toast('error', err.message);
    }
  };

  const makeDefault = async (b: BrowserEntry) => {
    await changeApp({ defaultBrowser: b.id });
    await refreshBrowsers();
  };

  if (!data) {
    return error ? (
      <div className="alert">
        <CircleAlert size={14} /> {error}
      </div>
    ) : (
      <p className="hint">
        <Loader2 size={12} className="spin" /> Finding browsers…
      </p>
    );
  }

  return (
    <div className="eng">
      <p className="hint">
        Each profile runs on one of these. Stealth Firefox is the original engine; Chromium profiles use a real Chromium build with the
        proxy, timezone, language, DNS and WebRTC aligned. Every engine reaches its proxy through a local tunnel: the browser never
        holds the proxy password, and when the proxy fails nothing goes out directly. New profiles start on the default.
      </p>
      <ul className="eng-list">
        {data.browsers.map((b) => {
          const n = usage(b.id);
          const isDefault = b.id === defaultId;
          return (
            <li key={b.id} className="eng-row" data-installed={b.installed}>
              <span className={`eng-mark ${b.family}`} aria-hidden="true">
                {b.family === 'chromium' ? 'C' : 'F'}
              </span>
              <div className="eng-main">
                <div className="eng-title">
                  <b>{b.name}</b>
                  {b.version && !b.name.includes(b.version) && <span className="mono dim">{b.version}</span>}
                  <span className={`chip eng-kind ${b.kind}`}>{kindLabel(b)}</span>
                  {!b.installed && <span className="chip eng-missing">Not installed</span>}
                  {b.limited && <span className="chip eng-limited">Limited</span>}
                  {isDefault && (
                    <span className="chip eng-default">
                      <Star size={10} /> Default
                    </span>
                  )}
                </div>
                {b.path && (
                  <span className="eng-path mono" title={b.path}>
                    {b.path}
                  </span>
                )}
                {b.limited && b.note && <span className="eng-note">{b.note}</span>}
              </div>
              <span className="eng-usage dim">{n ? `${n} profile${n > 1 ? 's' : ''}` : ''}</span>
              {!isDefault && b.installed && (
                <button className="btn xs" onClick={() => makeDefault(b)}>
                  Make default
                </button>
              )}
              {b.custom && (
                <button className="icon-btn xs danger" onClick={() => remove(b)} aria-label={`Remove ${b.name}`} data-tip="Remove">
                  <Trash2 size={13} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <form className="eng-add" onSubmit={add}>
        <div className="field grow">
          <FolderOpen size={14} />
          <input
            className="input mono"
            placeholder="Path to chrome.exe, worker.exe or firefox.exe of another build"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            aria-label="Browser executable path"
          />
        </div>
        <input className="input eng-name" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} aria-label="Browser name" maxLength={40} />
        <button className="btn" type="submit" disabled={busy || !path.trim()}>
          {busy ? <Loader2 size={13} className="spin" /> : <Plus size={13} />} Add
        </button>
      </form>
      <p className="hint">
        Engines placed in <span className="mono">%LOCALAPPDATA%\SessionManagerPro\engines\&lt;Name&gt;\&lt;version&gt;</span> appear here by
        themselves.
      </p>
    </div>
  );
};
