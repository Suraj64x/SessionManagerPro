import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Download, LoaderCircle, RefreshCw } from 'lucide-react';
import { useEvent } from '../../app-context';
import { CopyButton, useUI } from '../../ui';
import { engineApi, type EngineEvent, type EngineStatus } from './api';

/** The engine's status plus the live download line, used by the banner and by Settings. */
function useEngine() {
  const { toast } = useUI();
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [line, setLine] = useState('');
  // Both views hear the same broadcast; only the one that started the download toasts.
  const startedHere = useRef(false);

  const apply = useCallback((s: EngineStatus) => {
    setStatus(s);
    setLoadError(null);
    setRunning(s.fetching);
  }, []);
  const fail = useCallback((err: Error) => setLoadError(err.message), []);
  const load = useCallback(() => engineApi.status().then(apply, fail), [apply, fail]);

  useEffect(() => {
    engineApi.status().then(apply, fail);
  }, [apply, fail]);

  useEvent('engine', (e: EngineEvent) => {
    setLine(e.line);
    if (e.state === 'running') {
      setRunning(true);
      return;
    }
    setRunning(false);
    void load();
    if (startedHere.current) {
      startedHere.current = false;
      toast(e.state === 'done' ? 'success' : 'error', e.state === 'done' ? 'Browser engine ready' : `Download failed: ${e.line}`);
    }
  });

  const start = async () => {
    startedHere.current = true;
    setRunning(true);
    setLine('Starting…');
    try {
      await engineApi.fetch();
    } catch (err) {
      startedHere.current = false;
      setRunning(false);
      setLine('');
      toast('error', (err as Error).message);
    }
  };

  return { status, loadError, running, line, load, start };
}

/** Above the profiles table, only while the engine is missing. */
export const Banner: React.FC = () => {
  const { status, running, line, start } = useEngine();
  if (!status || status.ready) return null;
  if (!status.python) {
    return (
      <div className="banner engine-banner" role="status">
        The browser runtime is missing. Reinstall SessionManagerPro.
      </div>
    );
  }
  return (
    <div className="banner engine-banner" role="status">
      {running ? (
        <>
          <LoaderCircle size={14} className="spin" aria-hidden />
          <span className="engine-line">Downloading the browser engine… {line}</span>
        </>
      ) : (
        <>
          The browser engine is not downloaded yet
          <button className="btn xs" onClick={start}>
            <Download size={12} /> Download
          </button>
        </>
      )}
    </div>
  );
};

const Path: React.FC<{ value: string | null; label: string }> = ({ value, label }) =>
  value ? (
    <span className="engine-path">
      <span>{value}</span>
      <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
    </span>
  ) : (
    <>—</>
  );

export const EngineSettings: React.FC = () => {
  const { status, loadError, running, line, load, start } = useEngine();

  let badge: React.ReactNode;
  if (running) {
    badge = (
      <span className="badge live">
        <span className="dot" /> Downloading
      </span>
    );
  } else if (!status) {
    badge = <span className="badge">{loadError ? 'Unknown' : 'Checking…'}</span>;
  } else if (status.ready) {
    badge = <span className="badge live">Ready</span>;
  } else {
    badge = <span className="badge warn">{status.python ? 'Not downloaded' : 'Runtime missing'}</span>;
  }

  const v = status?.versions;
  // "not downloaded" only repeats the badge.
  const detail = status && !/^not downloaded$/i.test(status.detail) ? status.detail : '';
  return (
    <>
      <div className="setting">
        <div className="engine-state">
          <div className="inline">
            <span className="row-label">Patched Firefox</span>
            {badge}
          </div>
          <div className="hint engine-line" aria-live="polite">
            {running ? line || 'Starting…' : loadError ? `Could not read the engine status: ${loadError}` : detail}
          </div>
        </div>
        <div className="inline engine-actions">
          <button className="icon-btn" aria-label="Check again" title="Check again" onClick={load} disabled={running}>
            <RefreshCw size={14} />
          </button>
          <button className="btn" onClick={start} disabled={running || !status?.python}>
            {running ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}
            {status?.ready ? 'Update' : 'Download'}
          </button>
        </div>
      </div>
      <dl className="kv">
        <div>
          <dt>Python</dt>
          <dd>
            <Path value={status?.python ?? null} label="Python path" />
          </dd>
        </div>
        <div>
          <dt>Cache folder</dt>
          <dd>
            <Path value={status?.cacheDir ?? null} label="Cache folder" />
          </dd>
        </div>
        <div>
          <dt>App</dt>
          <dd>{v?.app || '—'}</dd>
        </div>
        <div>
          <dt>Engine package</dt>
          <dd>{v?.engine || '—'}</dd>
        </div>
        <div>
          <dt>Firefox</dt>
          <dd>{v?.firefox || '—'}</dd>
        </div>
      </dl>
      <p className="hint">About 240 MB, downloaded once and shared by every profile.</p>
    </>
  );
};
