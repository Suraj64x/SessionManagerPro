import React, { useState } from 'react';
import { CircleAlert, Loader2, Plus } from 'lucide-react';
import type { FingerprintResource, ProxyResource } from '../types';
import { Modal, Picker } from '../ui';
import { fptMeta } from './FingerprintPanel';
import { EngineSelect } from '../features/engines';
import { DEFAULT_ENGINE, fitsEngine, useBrowsers } from '../features/engines/store';
import { useApp } from '../app-context';

type Mode = 'single' | 'batch';

export const NewSessionModal: React.FC<{
  onClose: () => void;
  /** `proxyKey` is a library proxy's "host:port"; the server fills in its credentials. */
  onCreateSingle: (name: string, proxyKey?: string, fingerprintFile?: string, browser?: string) => Promise<void>;
  onCreateBatch: (count: number, prefix: string) => Promise<void>;
  proxies: ProxyResource[];
  fingerprints: FingerprintResource[];
}> = ({ onClose, onCreateSingle, onCreateBatch, proxies, fingerprints }) => {
  const [mode, setMode] = useState<Mode>('single');
  const [name, setName] = useState('');
  const [proxy, setProxy] = useState('');
  const [fpt, setFpt] = useState('');
  const { app } = useApp();
  const { data: engines } = useBrowsers();
  const defaultBrowser = (app?.defaultBrowser as string | undefined) || engines?.default || DEFAULT_ENGINE;
  const [browserPick, setBrowser] = useState<string | null>(null);
  const browser = browserPick ?? defaultBrowser;
  const engine = engines?.browsers.find((b) => b.id === browser);
  const [count, setCount] = useState(3);
  const [prefix, setPrefix] = useState('profile');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const freeProxies = proxies.filter((p) => !p.isAssigned);
  // Only dumps the chosen browser can wear.
  const freeFpts = fingerprints.filter((f) => !f.isAssigned && !f.error && fitsEngine(engine, fptMeta(f).browserName));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'single') {
        if (!name.trim()) throw new Error('Name is required');
        await onCreateSingle(name.trim(), proxy || undefined, fpt || undefined, browser);
      } else {
        if (count < 1 || count > 100) throw new Error('Count must be 1–100');
        await onCreateBatch(count, prefix.trim() || 'profile');
      }
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New profiles"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="new-profile" className="btn primary" disabled={busy}>
            {busy ? <Loader2 size={13} className="spin" /> : <Plus size={13} />} Create
          </button>
        </>
      }
    >
      <div className="seg" role="group" aria-label="How" style={{ alignSelf: 'flex-start' }}>
        {(
          [
            ['single', 'One'],
            ['batch', 'Batch'],
          ] as Array<[Mode, string]>
        ).map(([id, label]) => (
          <button key={id} type="button" aria-pressed={mode === id} onClick={() => setMode(id)}>
            {label}
          </button>
        ))}
      </div>

      <form id="new-profile" onSubmit={submit} className="form">
        {error && (
          <div className="alert">
            <CircleAlert size={14} style={{ marginTop: 1 }} />
            {error}
          </div>
        )}

        {mode === 'single' && (
          <>
            <div className="row">
              <label htmlFor="n-name">Name or email</label>
              <input id="n-name" className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="buyer-01" />
            </div>
            <div className="row">
              <label htmlFor="n-browser">Browser</label>
              <EngineSelect id="n-browser" value={browser} onChange={(b) => (setBrowser(b), setFpt(''))} />
            </div>
            <div className="row">
              <label htmlFor="n-proxy">Proxy</label>
              <Picker
                id="n-proxy"
                block
                label="Proxy"
                value={proxy}
                onChange={setProxy}
                options={[
                  { value: '', label: 'Auto', hint: `${freeProxies.length} free` },
                  ...freeProxies.map((p) => ({ value: p.key, label: p.key })),
                ]}
              />
            </div>
            <div className="row">
              <label htmlFor="n-fpt">Fingerprint</label>
              <Picker
                id="n-fpt"
                block
                label="Fingerprint"
                value={fpt}
                onChange={setFpt}
                options={[
                  { value: '', label: 'Auto', hint: `${freeFpts.length} free` },
                  ...freeFpts.map((f) => {
                    const m = fptMeta(f);
                    return { value: f.file, label: `${m.shortId} · ${m.country || '—'} · ${f.platform}`, title: f.file };
                  }),
                ]}
              />
            </div>
          </>
        )}

        {mode === 'batch' && (
          <div className="inline" style={{ alignItems: 'flex-start' }}>
            <div className="row" style={{ flex: 2 }}>
              <label htmlFor="n-prefix">Prefix</label>
              <input id="n-prefix" className="input" autoFocus value={prefix} onChange={(e) => setPrefix(e.target.value)} />
              <span className="hint">
                Creates {prefix || 'profile'}-1, {prefix || 'profile'}-2… each with a free proxy and fingerprint.
              </span>
            </div>
            <div className="row" style={{ flex: 1 }}>
              <label htmlFor="n-count">Count</label>
              <input
                id="n-count"
                type="number"
                min={1}
                max={100}
                className="input"
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
              />
            </div>
          </div>
        )}

      </form>
    </Modal>
  );
};

/* ---------------- read-only fingerprint specs ---------------- */

const Field: React.FC<{ k: string; v: React.ReactNode }> = ({ k, v }) => (
  <div>
    <dt>{k}</dt>
    <dd>{v || '—'}</dd>
  </div>
);

export const Specs: React.FC<{ fp: any }> = ({ fp }) => {
  const vp = fp.viewport;
  const gl = fp.webgl || {};
  return (
    <>
      <div className="code-block">{fp.userAgent || 'Default user agent'}</div>
      <dl className="kv">
        <Field k="Platform" v={fp.platform} />
        <Field k="Browser" v={fp.chromeVersion} />
        <Field
          k="Screen"
          v={typeof vp === 'string' ? vp : vp ? `${vp.width}×${vp.height} @${vp.deviceScaleFactor || 1}x` : null}
        />
        <Field k="Cores / RAM" v={`${fp.hardwareConcurrency || '?'} / ${fp.deviceMemory || '?'} GB`} />
      </dl>
      <div className="code-block">
        {fp.webglVendor || gl.vendor || '—'}
        {'\n'}
        {fp.webglRenderer || gl.renderer || '—'}
      </div>
    </>
  );
};

export const SpecsModal: React.FC<{ fp: any; title: string; onClose: () => void }> = ({ fp, title, onClose }) => (
  <Modal
    title={title}
    width={520}
    onClose={onClose}
    footer={
      <button className="btn" onClick={onClose}>
        Close
      </button>
    }
  >
    <Specs fp={fp} />
  </Modal>
);
