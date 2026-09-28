import { useSyncExternalStore } from 'react';

/* The browser engines a profile can run on (GET /api/browsers), shared by Settings, the drawer
   and the New profile dialog. Fetched once and refreshed after a change. */

export interface BrowserEntry {
  id: string;
  name: string;
  family: 'chromium' | 'firefox';
  /** Picks the worker: the stealth engine, a Chromium driven over CDP, or a manual-only Firefox. */
  kind: 'stealth' | 'chromium' | 'firefox-manual' | 'camoufox' | string;
  path?: string;
  version?: string | null;
  automation: boolean;
  installed: boolean;
  /** Fingerprint dump types (fingerprint browserName) this engine applies. */
  fingerprintBrowsers: string[];
  note?: string;
  /** Runs, but with a known problem that `note` explains (e.g. a Bablosoft build outside its host). */
  limited?: boolean;
  builtin?: boolean;
  custom?: boolean;
  engineFolder?: boolean;
  versions?: string[];
}

export interface BrowserList {
  default: string;
  browsers: BrowserEntry[];
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-SMP': '1', ...options?.headers },
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      msg = (await res.json()).error || msg;
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
  return res.json();
}

export const browsersApi = {
  list: () => fetchJson<BrowserList>('/api/browsers'),
  addCustom: (path: string, name?: string) =>
    fetchJson<BrowserEntry>('/api/browsers/custom', { method: 'POST', body: JSON.stringify({ path, name }) }),
  removeCustom: (id: string) => fetchJson<{ ok: boolean }>(`/api/browsers/custom/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

let state: { data: BrowserList | null; error: string | null } = { data: null, error: null };
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const refreshBrowsers = (): Promise<void> => {
  loading = browsersApi.list().then(
    (data) => {
      state = { data, error: null };
      emit();
    },
    (err) => {
      state = { ...state, error: err.message };
      emit();
    }
  );
  return loading;
};

export const getBrowsers = () => {
  if (!state.data && !loading) refreshBrowsers();
  return state;
};
export const subscribeBrowsers = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** A profile record without `browser` runs on the original engine. */
export const DEFAULT_ENGINE = 'stealth-firefox';

export const kindLabel = (b: BrowserEntry) =>
  b.kind === 'stealth' ? 'Stealth' : b.kind === 'firefox-manual' ? 'Manual only' : b.kind === 'camoufox' ? 'Camoufox' : 'Chromium';

/** Whether a fingerprint dump suits the engine (a Chrome dump on a Firefox engine is a tell). */
export const fitsEngine = (engine: BrowserEntry | undefined, fingerprintBrowser: string | undefined) => {
  if (!engine) return true;
  if (!engine.fingerprintBrowsers.length) return false;
  if (!fingerprintBrowser) return true;
  return engine.fingerprintBrowsers.some((b) => b.toLowerCase() === fingerprintBrowser.toLowerCase());
};

/** The engine list, loading on first use; `data` is null until it arrives. */
export const useBrowsers = () => useSyncExternalStore(subscribeBrowsers, getBrowsers);
