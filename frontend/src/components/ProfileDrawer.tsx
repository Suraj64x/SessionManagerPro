import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, CircleAlert, Copy, Download, Loader2, Play, Square, Trash2, Upload, X } from 'lucide-react';
import type { FingerprintResource, ProxyResource, SessionRecord } from '../types';
import { SWATCHES } from '../types';
import { api, downloadJson } from '../api';
import { Avatar, CopyButton, Menu, Picker, StatusBadge, TagInput, ago, pickTextFile, useDialog, useUI, type PickerOption } from '../ui';
import { fptMeta, fptShort } from './FingerprintPanel';
import { Specs } from './Modals';
import { listSlot, renderSlot } from '../contributions';
import { sameName, useOrganize } from '../features/organize/model';
import { EngineSelect } from '../features/engines';
import { DEFAULT_ENGINE, fitsEngine, useBrowsers } from '../features/engines/store';

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const urlsOf = (text: string) => text.split('\n').map((u) => u.trim()).filter(Boolean);

type Form = {
  notes: string;
  label: string;
  folder: string;
  color: string;
  tags: string[];
  pages: string;
  proxyKey: string;
  fptFile: string;
  browser: string;
  geolocation: 'block' | 'spoof';
  webrtc: 'masked' | 'off';
};

const formOf = (s: SessionRecord): Form => ({
  notes: s.notes || '',
  label: s.label || '',
  folder: s.folder || '',
  color: s.color || '',
  tags: s.tags || [],
  pages: (s.startUrls || []).join('\n'),
  proxyKey: s.proxy ? `${s.proxy.host}:${s.proxy.port}` : '',
  fptFile: s.fingerprintFile || '',
  browser: s.browser || DEFAULT_ENGINE,
  geolocation: s.geolocation === 'spoof' ? 'spoof' : 'block',
  webrtc: s.webrtc === 'off' ? 'off' : 'masked',
});

const sameField = (a: unknown, b: unknown) =>
  Array.isArray(a) && Array.isArray(b) ? sameList(a, b) : a === b;

export const ProfileDrawer: React.FC<{
  session: SessionRecord;
  proxies: ProxyResource[];
  fingerprints: FingerprintResource[];
  allTags: string[];
  launching: boolean;
  onClose: () => void;
  onSaved: () => void;
  onLaunch: () => void;
  onStop: () => void;
  onTrash: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}> = ({ session: s, proxies, fingerprints, allTags, launching, onClose, onSaved, onLaunch, onStop, onTrash, onDirtyChange }) => {
  const { toast } = useUI();
  const ref = useRef<HTMLElement>(null);
  useDialog(ref, onClose);

  const currentProxy = s.proxy ? `${s.proxy.host}:${s.proxy.port}` : '';
  // Edits are diffed against a baseline, not the live profile. When the profile changes
  // underneath (bulk tag, sheet sync), untouched fields adopt the new value and the
  // baseline moves — so Save only sends what the user actually changed.
  const incoming = formOf(s);
  const incomingKey = JSON.stringify(incoming);
  const [base, setBase] = useState<Form>(incoming);
  const [form, setForm] = useState<Form>(incoming);
  const [seenKey, setSeenKey] = useState(incomingKey);
  if (seenKey !== incomingKey) {
    setSeenKey(incomingKey);
    setForm((f) => {
      const next = { ...f } as Record<keyof Form, unknown>;
      for (const k of Object.keys(incoming) as Array<keyof Form>) {
        if (sameField(f[k], base[k])) next[k] = incoming[k];
      }
      return next as Form;
    });
    setBase(incoming);
  }
  const setField =
    <K extends keyof Form>(k: K) =>
    (v: Form[K]) =>
      setForm((f) => ({ ...f, [k]: v }));
  const { notes, label, folder, color, tags, pages, proxyKey, fptFile, browser, geolocation, webrtc } = form;
  const setNotes = setField('notes');
  const setLabel = setField('label');
  const setFolder = setField('folder');
  const setColor = setField('color');
  const setTags = setField('tags');
  const setPages = setField('pages');
  const setProxyKey = setField('proxyKey');
  const setFptFile = setField('fptFile');
  const setBrowser = setField('browser');
  const setGeolocation = setField('geolocation');
  const setWebrtc = setField('webrtc');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startUrls = urlsOf(pages);
  const changed = {
    notes: notes !== base.notes,
    label: label.trim() !== base.label,
    folder: folder !== base.folder,
    color: color !== base.color,
    tags: !sameList(tags, base.tags),
    startUrls: !sameList(startUrls, urlsOf(base.pages)),
    proxy: proxyKey !== base.proxyKey,
    fingerprintFile: fptFile !== base.fptFile,
    browser: browser !== base.browser,
    geolocation: geolocation !== base.geolocation,
    webrtc: webrtc !== base.webrtc,
  };
  const dirty = Object.values(changed).some(Boolean);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const proxyOptions = useMemo(
    () => proxies.filter((p) => !p.isAssigned || p.key === currentProxy),
    [proxies, currentProxy]
  );
  // Only fingerprint dumps the chosen engine can wear (a Chrome dump on a Firefox engine is a tell).
  const { data: engines } = useBrowsers();
  const engine = engines?.browsers.find((b) => b.id === browser);
  // Only Stealth Firefox can show the proxy's IP over WebRTC; the others are always proxy-only.
  const stealth = browser === DEFAULT_ENGINE;
  const fptOptions = useMemo(
    () =>
      fingerprints.filter(
        (f) => f.file === s.fingerprintFile || (!f.isAssigned && !f.error && fitsEngine(engine, fptMeta(f).browserName))
      ),
    [fingerprints, s.fingerprintFile, engine]
  );
  const currentFpt = fingerprints.find((f) => f.file === fptFile);
  const fptMismatch = Boolean(engine && currentFpt && !fitsEngine(engine, fptMeta(currentFpt).browserName));

  const reset = () => {
    setForm(base);
    setError(null);
  };

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      const patch: Record<string, unknown> = {};
      if (changed.notes) patch.notes = notes;
      if (changed.label) patch.label = label.trim();
      if (changed.folder) patch.folder = folder;
      if (changed.color) patch.color = color;
      if (changed.tags) patch.tags = tags;
      if (changed.startUrls) patch.startUrls = startUrls;
      if (changed.fingerprintFile && fptFile) patch.fingerprintFile = fptFile;
      if (changed.browser) patch.browser = browser;
      if (changed.geolocation) patch.geolocation = geolocation;
      if (changed.webrtc) patch.webrtc = webrtc;
      if (changed.proxy) {
        const chosen = proxies.find((p) => p.key === proxyKey);
        if (!chosen) throw new Error('That proxy is no longer available');
        patch.proxyKey = chosen.key; // the server looks up the credentials; the panel never has them
      }
      await api.patchSession(s.id, patch);
      toast('success', 'Saved');
      onSaved();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const exportCookies = async () => {
    try {
      const cookies = await api.getCookies(s.id);
      if (!cookies.length) return toast('info', 'No cookies saved yet');
      downloadJson(`${s.id}-cookies.json`, cookies);
    } catch (err: any) {
      toast('error', err.message);
    }
  };

  const importCookies = async (text: string | null): Promise<boolean> => {
    if (!text) return false;
    try {
      const r = await api.importCookies(s.id, text);
      if (r.applied !== 'now') toast('success', `${r.count} cookies will load on next launch`);
      else if (r.count === r.total) toast('success', `Imported ${r.count} cookies`);
      else toast('error', `Browser kept ${r.count} of ${r.total} cookies`);
      onSaved();
      return true;
    } catch (err: any) {
      toast('error', err.message);
      return false;
    }
  };

  const fp = s.fingerprint;
  const live = s.status === 'live';

  // Status and folder come from the lists in Settings; a value not in them stays selectable
  // (an old label, a folder deleted since) so the form never silently drops it.
  const { statuses, folders } = useOrganize();
  const statusValue = statuses.find((st) => sameName(st.name, label))?.name ?? label;

  // Features add tabs (History, …) after the profile form.
  const extraTabs = listSlot('drawerTabs');
  const [tab, setTab] = useState('profile');
  const current = extraTabs.find((t) => t.id === tab);

  return (
    <aside ref={ref} className="drawer" role="dialog" aria-modal="true" aria-label={`Profile ${s.id}`}>
      <div className="drawer-head">
        <Avatar s={{ id: s.id, color }} />
        <h2 title={s.id}>{s.id}</h2>
        <StatusBadge s={s} />
        <span className="grow" />
        {s.status === 'live' && renderSlot('liveActions', { session: s })}
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <X size={15} />
        </button>
      </div>

      {extraTabs.length > 0 && (
        <div className="drawer-tabs" role="tablist" aria-label="Profile sections">
          {[{ id: 'profile', label: 'Profile' }, ...extraTabs].map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      )}

      {current ? (
        <div className="drawer-body" role="tabpanel">
          {current.render(s)}
        </div>
      ) : (
        <>
      <div className="drawer-body">
        <div className="drawer-actions">
          {live ? (
            <button className="btn danger" onClick={onStop}>
              <Square size={11} /> Stop
            </button>
          ) : (
            <button className="btn primary" onClick={onLaunch} disabled={launching || s.status === 'queued'}>
              {launching ? <Loader2 size={13} className="spin" /> : <Play size={12} />} Launch
            </button>
          )}
          <CloneMenu id={s.id} onDone={onSaved} />
          <button className="btn" onClick={onTrash}>
            <Trash2 size={13} /> Trash
          </button>
        </div>

        {s.status === 'error' && s.lastResult?.reason && (
          <div className="alert">
            <CircleAlert size={14} style={{ marginTop: 1 }} />
            {s.lastResult.reason}
          </div>
        )}

        <div className="group">
          <div className="row">
            <label htmlFor="d-notes">Notes</label>
            <textarea
              id="d-notes"
              className="input"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={2000}
            />
          </div>
          <div className="inline" style={{ alignItems: 'flex-start' }}>
            <div className="row" style={{ flex: 1 }}>
              <label htmlFor="d-status">Status</label>
              <Picker
                id="d-status"
                block
                label="Status"
                value={statusValue}
                onChange={setLabel}
                options={[
                  { value: '', label: 'No status' },
                  ...(label && statusValue === label && !statuses.some((st) => st.name === label)
                    ? [{ value: label, label, hint: 'not in the list' }]
                    : []),
                  ...statuses.map((st) => ({ value: st.name, label: st.name })),
                ]}
              />
            </div>
            <div className="row" style={{ flex: 1 }}>
              <label htmlFor="d-folder">Folder</label>
              <Picker
                id="d-folder"
                block
                label="Folder"
                value={folder}
                onChange={setFolder}
                options={[
                  { value: '', label: 'No folder' },
                  ...(folder && !folders.includes(folder) ? [{ value: folder, label: folder, hint: 'not in the list' }] : []),
                  ...folders.map((f) => ({ value: f, label: f })),
                ]}
              />
            </div>
          </div>
          <div className="row">
            <span className="row-label" id="d-color-label">
              Avatar colour
            </span>
            <div className="swatches" role="group" aria-labelledby="d-color-label">
              <button className="swatch none" aria-pressed={!color} onClick={() => setColor('')} aria-label="No colour" />
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  className="swatch"
                  style={{ background: c }}
                  aria-pressed={color === c}
                  onClick={() => setColor(c)}
                  aria-label={`Colour ${c}`}
                />
              ))}
            </div>
          </div>
          <div className="row">
            <label htmlFor="d-tags">Tags</label>
            <TagInput id="d-tags" value={tags} onChange={setTags} suggestions={allTags} />
          </div>
          <div className="row">
            <label htmlFor="d-pages">Start pages</label>
            <textarea
              id="d-pages"
              className="input mono"
              rows={2}
              placeholder="One URL per line. Empty = reopen last tabs."
              value={pages}
              onChange={(e) => setPages(e.target.value)}
            />
          </div>
        </div>

        <div className="group">
          <h3>Identity</h3>
          <div className="row">
            <label htmlFor="d-browser">Browser</label>
            <EngineSelect id="d-browser" value={browser} onChange={setBrowser} disabled={live} />
            {live && <span className="hint">Stop the profile to change its browser.</span>}
          </div>
          <div className="row">
            <label htmlFor="d-proxy">Proxy</label>
            <Picker
              id="d-proxy"
              block
              label="Proxy"
              value={proxyKey}
              onChange={setProxyKey}
              options={[
                ...(!currentProxy ? [{ value: '', label: 'None' }] : []),
                ...(currentProxy && !proxyOptions.some((p) => p.key === currentProxy)
                  ? [{ value: currentProxy, label: currentProxy, hint: 'current, missing from pool' }]
                  : []),
                ...proxyOptions.map((p) => ({ value: p.key, label: p.key, hint: p.key === currentProxy ? 'current' : undefined })),
              ]}
            />
          </div>
          <div className="row">
            <label htmlFor="d-fpt">Fingerprint</label>
            <Picker
              id="d-fpt"
              block
              label="Fingerprint"
              value={fptFile}
              onChange={setFptFile}
              options={[
                ...(!s.fingerprintFile ? [{ value: '', label: 'None' }] : []),
                ...(s.fingerprintFile && !fptOptions.some((f) => f.file === s.fingerprintFile)
                  ? [{ value: s.fingerprintFile, label: fptShort(s.fingerprintFile), hint: 'current, missing from pool' }]
                  : []),
                ...fptOptions.map((f) => {
                  const m = fptMeta(f);
                  return {
                    value: f.file,
                    label: `${m.shortId} · ${m.country || '—'} · ${f.platform}`,
                    hint: f.file === s.fingerprintFile ? 'current' : undefined,
                    title: f.file,
                  } as PickerOption;
                }),
              ]}
            />
          </div>
          {fptMismatch && (
            <span className="hint eng-warn">
              <CircleAlert size={12} /> This fingerprint was made for another browser; pick one for {engine?.name}.
            </span>
          )}
          <div className="row">
            <span className="row-label" id="d-geo">Geolocation API</span>
            <div className="seg" role="group" aria-labelledby="d-geo">
              <button type="button" aria-pressed={geolocation === 'block'} onClick={() => setGeolocation('block')}>
                Block
              </button>
              <button type="button" aria-pressed={geolocation === 'spoof'} onClick={() => setGeolocation('spoof')}>
                Proxy location
              </button>
            </div>
            <span className="hint">
              {geolocation === 'block' ? 'Sites can’t read a location (recommended).' : 'Sites that ask get the proxy’s coordinates.'}
            </span>
          </div>
          <div className="row">
            <span className="row-label" id="d-webrtc">WebRTC</span>
            <div className="seg" role="group" aria-labelledby="d-webrtc">
              <button type="button" aria-pressed={stealth && webrtc === 'masked'} disabled={!stealth} onClick={() => setWebrtc('masked')}>
                Proxy IP
              </button>
              <button type="button" aria-pressed={!stealth || webrtc === 'off'} onClick={() => setWebrtc('off')}>
                Off
              </button>
            </div>
            <span className="hint">
              {!stealth
                ? 'This browser only sends WebRTC through the proxy; sites see no WebRTC address.'
                : webrtc === 'masked'
                  ? 'Sites see the proxy’s IP, like a normal browser behind a router; no STUN request leaves this computer (recommended).'
                  : 'Nothing at all leaves outside the proxy and sites see no WebRTC address; some checkers (iphey) never finish.'}
            </span>
          </div>
          {(changed.proxy || changed.fingerprintFile) && (
            <span className="hint">Saving rebuilds the fingerprint. Timezone follows the proxy's exit IP at launch.</span>
          )}
        </div>

        <div className="group">
          <h3>Cookies · {s.cookieCount}</h3>
          <div className="inline">
            <button className="btn" onClick={exportCookies}>
              <Download size={13} /> Export
            </button>
            <button className="btn" onClick={() => pickTextFile('.json,.txt').then(importCookies)}>
              <Upload size={13} /> Import file
            </button>
            <PasteCookies onImport={importCookies} />
          </div>
          <span className="hint">
            JSON (Playwright, EditThisCookie, Cookie-Editor) or Netscape cookies.txt.
            {live ? ' Applied immediately.' : ' Applied on next launch.'}
          </span>
        </div>

        <details>
          <summary>
            <ChevronRight size={13} /> Details
          </summary>
          <div className="group" style={{ marginTop: 8 }}>
            <dl className="kv">
              <div>
                <dt>Proxy</dt>
                <dd className="inline" style={{ gap: 2 }}>
                  {currentProxy || '—'}
                  {currentProxy && <CopyButton value={currentProxy} label="Copy proxy" />}
                </dd>
              </div>
              <div>
                <dt>Fingerprint</dt>
                <dd>{s.fingerprintFile ? fptShort(s.fingerprintFile) : '—'}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{ago(s.createdAt)}</dd>
              </div>
              <div>
                <dt>Last opened</dt>
                <dd>{ago(s.lastOpenedAt)}</dd>
              </div>
            </dl>
            {s.tabs?.length > 0 && (
              <div className="row">
                <span className="row-label">Last tabs</span>
                <div className="code-block">{s.tabs.join('\n')}</div>
              </div>
            )}
            {fp && <Specs fp={fp} />}
          </div>
        </details>
      </div>

      {dirty && (
        <div className="drawer-foot">
          {error && (
            <span className="hint" style={{ color: 'var(--danger)', marginRight: 'auto' }}>
              {error}
            </span>
          )}
          <button className="btn" onClick={reset} disabled={busy}>
            Discard
          </button>
          <button className="btn primary" onClick={save} disabled={busy}>
            {busy && <Loader2 size={13} className="spin" />} Save
          </button>
        </div>
      )}
        </>
      )}
    </aside>
  );
};

const CloneMenu: React.FC<{ id: string; onDone: () => void }> = ({ id, onDone }) => {
  const { toast } = useUI();
  const [name, setName] = useState(`${id}-copy`);
  const [withCookies, setWithCookies] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Menu
      left
      trigger={(t) => (
        <button className="btn" {...t}>
          <Copy size={13} /> Clone
        </button>
      )}
    >
      {(close) => (
        <form
          style={{ width: 240, padding: 4 }}
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const c = await api.cloneSession(id, name.trim(), withCookies);
              toast('success', `Cloned as ${c.id}`);
              onDone();
              close();
            } catch (err: any) {
              toast('error', err.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="menu-head">New profile, fresh proxy &amp; fingerprint</div>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="Clone name" />
          <label className="switch" style={{ margin: '4px 4px 8px', fontSize: 12 }}>
            <input type="checkbox" checked={withCookies} onChange={(e) => setWithCookies(e.target.checked)} />
            Copy cookies
          </label>
          <button type="submit" className="btn primary" style={{ width: '100%' }} disabled={busy || !name.trim()}>
            {busy && <Loader2 size={13} className="spin" />} Clone
          </button>
        </form>
      )}
    </Menu>
  );
};

const PasteCookies: React.FC<{ onImport: (text: string) => Promise<boolean> }> = ({ onImport }) => {
  const [text, setText] = useState('');
  return (
    <Menu
      left
      trigger={(t) => (
        <button className="btn ghost" {...t}>
          Paste
        </button>
      )}
    >
      {(close) => (
        <div style={{ width: 300, padding: 4 }}>
          <textarea
            className="input mono"
            rows={6}
            autoFocus
            placeholder="Paste JSON or cookies.txt"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button
            className="btn primary"
            style={{ width: '100%', marginTop: 8 }}
            disabled={!text.trim()}
            // Keep the pasted text if the import fails, so it can be fixed and retried.
            onClick={() => onImport(text).then((ok) => ok && (setText(''), close()))}
          >
            Import
          </button>
        </div>
      )}
    </Menu>
  );
};
