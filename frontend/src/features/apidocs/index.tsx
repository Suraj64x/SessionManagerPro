import React, { useId, useState } from 'react';
import { ArrowDown, ArrowUp, ExternalLink, Globe, Plus, ShieldCheck, X } from 'lucide-react';
import type { Contributions } from '../../contributions';
import type { SessionRecord } from '../../types';
import type { AppSettings } from '../../api';
import { useApp } from '../../app-context';
import { CopyButton, Empty, Picker, Toolbar, useStored, useUI } from '../../ui';
import { apidocsApi } from './api';
import { tokens } from './highlight';
import { CurlIcon, NodeIcon, PlaywrightIcon, SeleniumIcon } from './icons';
import { LeakCheckButton, LeakCheckHost } from './leakcheck';
import { openLeakCheck } from './leakstore';
import { endpoints, LANG, snippets, type LangId } from './snippets';
import './apidocs.css';

// Local API reference, the "open check page" row action and the Browser / Check pages settings.

// Mirrors the server's defaults so a mangled list can be put back from Settings.
const DEFAULT_CHECK_PAGES = [
  'https://pixelscan.net',
  'https://www.browserscan.net',
  'https://abrahamjuliot.github.io/creepjs/',
  'https://ipinfo.io',
];
const MAX_CHECK_PAGES = 10;

const checkPagesOf = (app: AppSettings | null) =>
  Array.isArray(app?.checkPages) ? (app.checkPages as unknown[]).filter((u): u is string => typeof u === 'string') : [];

/** "https://abrahamjuliot.github.io/creepjs/" → "abrahamjuliot.github.io/creepjs/" */
const hostOf = (u: string) => {
  try {
    const { host, pathname } = new URL(u);
    return host + (pathname === '/' ? '' : pathname);
  } catch {
    return u;
  }
};

/* ------------------------------------------------------------------ *
 * API reference
 * ------------------------------------------------------------------ */

// The code panel's tabs, in the order of snippets(); each icon is in colour only while chosen.
const TABS: { id: LangId; label: string; Icon: React.FC }[] = [
  { id: 'curl', label: 'cURL', Icon: CurlIcon },
  { id: 'node', label: 'Node.js', Icon: NodeIcon },
  { id: 'selenium', label: 'Selenium', Icon: SeleniumIcon },
  { id: 'playwright', label: 'Playwright', Icon: PlaywrightIcon },
];

// The code card: language tabs, a copy button and the chosen endpoint's snippet.
const CodePanel: React.FC<{ code: Record<LangId, string>; tab: LangId; setTab: (t: LangId) => void }> = ({
  code,
  tab,
  setTab,
}) => {
  const id = useId();
  const cur = Math.max(0, TABS.findIndex((t) => t.id === tab)); // a stale stored tab falls back to cURL
  const { id: langId, label } = TABS[cur];
  // Tabs pattern: arrows and Home/End move the selection and focus with it.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const to = ({ ArrowLeft: cur - 1, ArrowRight: cur + 1, Home: 0, End: TABS.length - 1 } as Record<string, number>)[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = TABS[(to + TABS.length) % TABS.length].id;
    setTab(next);
    document.getElementById(`${id}-${next}`)?.focus();
  };
  return (
    <div className="api-code">
      <div className="api-code-head">
        <div className="api-tabs" role="tablist" aria-label="Snippet language">
          {TABS.map((t, i) => (
            <button
              key={t.id}
              id={`${id}-${t.id}`}
              className="api-tab"
              role="tab"
              aria-selected={i === cur}
              aria-controls={`${id}-code`}
              tabIndex={i === cur ? 0 : -1}
              onClick={() => setTab(t.id)}
              onKeyDown={onKeyDown}
            >
              <t.Icon />
              <span data-label={t.label}>{t.label}</span>
            </button>
          ))}
        </div>
        <CopyButton value={code[langId]} label={`Copy ${label} snippet`} />
      </div>
      <pre className="code-block" id={`${id}-code`} role="tabpanel" aria-labelledby={`${id}-${langId}`} tabIndex={0}>
        {tokens(code[langId], LANG[langId]).map(([kind, text], i) => (kind ? <span key={i} className={`tok-${kind}`}>{text}</span> : text))}
      </pre>
    </div>
  );
};

export const ApiView: React.FC<{ active: boolean }> = () => {
  const { sessions, selectedIds, scripts } = useApp();
  const [tab, setTab] = useStored<LangId>('apiLang', 'curl');
  const [epId, setEpId] = useStored<string>('apiEndpoint', 'launch');
  const [pick, setPick] = useState('');
  // The snippets' profile: the one picked here, else the first selected one, else the first.
  const id = sessions.some((s) => s.id === pick) ? pick : selectedIds[0] || sessions[0]?.id || 'profile-1';
  const scriptId = scripts[0]?.id || 'script-id';
  const origin = location.origin;
  const base = `${origin}/api`;
  const list = endpoints(id, scriptId);
  const ep = list.find((e) => e.id === epId) || list[0];
  return (
    <>
      <Toolbar title="API">
        <div className="api-field">
          Base URL
          <span className="api-box">
            <code className="api-url">{base}</code>
            <CopyButton value={base} label="Copy base URL" />
          </span>
        </div>
        {sessions.length > 0 && (
          <span className="api-field">
            Profile
            <Picker label="Profile for the snippets" value={id} onChange={setPick} options={sessions.map((s) => ({ value: s.id, label: s.id }))} />
          </span>
        )}
      </Toolbar>
      <div className="view">
        <p className="hint api-note">
          Non-GET requests need the header <code>X-SMP: 1</code> · only this computer is accepted
        </p>
        {/* A numbered list of calls beside the code card: picking one shows its code. */}
        <div className="api-how">
          <ol className="api-steps" aria-label="Endpoints">
            {list.map((e, i) => (
              <li key={e.id}>
                <button className="api-step" aria-current={e.id === ep.id} onClick={() => setEpId(e.id)}>
                  <span className="n">{String(i + 1).padStart(2, '0')}</span>
                  <span className="t">{e.title}</span>
                  <span className="p">
                    <span className={`api-method ${e.method.toLowerCase()}`}>{e.method}</span>
                    <code>{e.path}</code>
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <CodePanel code={snippets(origin, ep)} tab={tab} setTab={setTab} />
        </div>
      </div>
    </>
  );
};

/* ------------------------------------------------------------------ *
 * Row menu: open a check page in this profile
 * ------------------------------------------------------------------ */

const CheckPageItems: React.FC<{ session: SessionRecord; close: () => void }> = ({ session, close }) => {
  const { app } = useApp();
  const { toast } = useUI();
  const urls = checkPagesOf(app);
  if (!urls.length) return null;
  const open = async (url: string) => {
    close();
    try {
      if (session.status === 'live') {
        await apidocsApi.runOp(session.id, { op: 'new_tab', url });
        toast('success', `Opened ${hostOf(url)} in ${session.id}`);
      } else {
        toast('info', 'Launching…');
        await apidocsApi.launchAt(session.id, url);
      }
    } catch (err: any) {
      toast('error', err.message);
    }
  };
  return (
    <>
      <hr />
      {session.status === 'live' && <span onClick={close}><LeakCheckButton id={session.id} variant="menu" /></span>}
      <div className="menu-head">Check page</div>
      {urls.map((u) => (
        <button key={u} onClick={() => open(u)} title={u}>
          <ExternalLink size={12} /> {hostOf(u)}
        </button>
      ))}
    </>
  );
};

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

const BrowserSection: React.FC = () => {
  const { app, changeApp } = useApp();
  return (
    <div className="setting">
      <div>
        <div className="row-label">Traffic saver</div>
        <div className="hint">
          Blocks images and autoplay on hidden and automated runs; normal launches are unaffected, because blocked images
          are themselves a signal.
        </div>
      </div>
      <label className="switch">
        <input
          type="checkbox"
          checked={app?.trafficSaver === true}
          disabled={!app}
          onChange={(e) => changeApp({ trafficSaver: e.target.checked })}
          aria-label="Traffic saver"
        />
      </label>
    </div>
  );
};

const CheckPagesSection: React.FC = () => {
  const { app, changeApp } = useApp();
  const { toast } = useUI();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const urls = checkPagesOf(app);
  const full = urls.length >= MAX_CHECK_PAGES;

  // changeApp toasts its own errors; busy only stops a second reorder landing on stale order.
  const save = async (next: string[]) => {
    setBusy(true);
    try {
      await changeApp({ checkPages: next });
    } finally {
      setBusy(false);
    }
  };
  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const u = draft.trim();
    if (!/^https?:\/\/\S+$/i.test(u)) return toast('error', 'Enter an http(s) URL');
    if (urls.includes(u)) return toast('error', 'Already in the list');
    setDraft('');
    save([...urls, u]);
  };
  const move = (i: number, d: -1 | 1) => {
    const next = [...urls];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    save(next);
  };

  return (
    <>
      <p className="hint">Opened from a profile&rsquo;s menu to verify its fingerprint and exit IP. Up to {MAX_CHECK_PAGES}.</p>
      {!app ? (
        <p className="hint">Loading…</p>
      ) : !urls.length ? (
        <Empty
          icon={<Globe size={28} color="var(--txt-3)" />}
          text="No check pages"
          action={
            <button className="btn" onClick={() => save(DEFAULT_CHECK_PAGES)} disabled={busy}>
              Restore defaults
            </button>
          }
        />
      ) : (
        <ol className="api-pages" aria-label="Check pages">
          {urls.map((u, i) => (
            <li key={u}>
              <span className="n">{i + 1}</span>
              <span className="api-url" title={u}>
                {u}
              </span>
              <button className="icon-btn xs" aria-label={`Move ${hostOf(u)} up`} disabled={busy || i === 0} onClick={() => move(i, -1)}>
                <ArrowUp size={13} />
              </button>
              <button
                className="icon-btn xs"
                aria-label={`Move ${hostOf(u)} down`}
                disabled={busy || i === urls.length - 1}
                onClick={() => move(i, 1)}
              >
                <ArrowDown size={13} />
              </button>
              <button
                className="icon-btn xs danger"
                aria-label={`Remove ${hostOf(u)}`}
                title={urls.length === 1 ? 'Keep at least one' : 'Remove'}
                disabled={busy || urls.length === 1}
                onClick={() => save(urls.filter((_, j) => j !== i))}
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ol>
      )}
      <form className="inline api-add" onSubmit={add}>
        <input
          className="input"
          placeholder="https://"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={!app || busy || full}
          aria-label="New check page URL"
        />
        <button className="btn" type="submit" disabled={!app || busy || full || !draft.trim()}>
          <Plus size={13} /> Add
        </button>
      </form>
      {full && <p className="hint">That is the limit; remove one to add another.</p>}
    </>
  );
};

export const contributions: Contributions = {
  rowMenu: ({ session, close }) => <CheckPageItems session={session} close={close} />,
  // The status bar is always mounted, so it hosts the leak-check dialog.
  statusItems: () => <LeakCheckHost />,
  liveActions: ({ session }) => <LeakCheckButton id={session.id} variant="icon" />,
  bulkBar: ({ live }) => (
    <button
      className="btn xs"
      onClick={() => openLeakCheck(live.map((s) => s.id))}
      disabled={!live.length}
      title={live.length ? 'Check the running ones for IP, WebRTC and DNS leaks' : 'Launch them first'}
    >
      <ShieldCheck size={12} /> Leak check
    </button>
  ),
  settingsSections: [
    { id: 'browser', title: 'Browser', render: () => <BrowserSection /> },
    { id: 'check-pages', title: 'Check pages', render: () => <CheckPagesSection /> },
  ],
};
