import type {
  FingerprintResource,
  LogEntry,
  PoolStatus,
  ProxyProbe,
  ProxyResource,
  Script,
  ScriptDraft,
  ScriptRun,
  SessionRecord,
  TrashItem,
} from './types';

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      // The server refuses state-changing requests without this. A page on another
      // site can't send it without a preflight the server never approves.
      'X-SMP': '1',
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text);
      if (parsed.error) msg = parsed.error;
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
  return res.json();
}

const post = <T>(url: string, body?: unknown) =>
  fetchJson<T>(url, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const patch = <T>(url: string, body: unknown) => fetchJson<T>(url, { method: 'PATCH', body: JSON.stringify(body) });
const del = <T>(url: string) => fetchJson<T>(url, { method: 'DELETE' });
const enc = encodeURIComponent;

/** Parallel windows: no product cap; 999 only guards against a typo (server.js MAX_THREADS). */
export const MAX_THREADS = 999;

export type BulkAction = 'tag' | 'untag' | 'label' | 'stop' | 'trash' | 'status' | 'folder' | 'proxy' | 'browser';

/**
 * data/app.json. Each feature registers the keys it owns on the server (see
 * backend/src/features/README.md); unknown keys are refused, so add them here too.
 */
export interface AppSettings {
  /** What closing the dashboard window does: keep running in the tray, or quit everything. */
  closeBehavior: 'tray' | 'quit';
  /** Versions reported by the server, when the engine feature provides them. */
  versions?: { app?: string; engine?: string; firefox?: string };
  warmupSets?: Array<{ name: string; urls: string[] }>;
  /** Browser engine for new profiles (Settings → Browsers). */
  defaultBrowser?: string;
  [feature: string]: unknown;
}

export const api = {
  /* profiles */
  getSessions: () => fetchJson<SessionRecord[]>('/api/sessions'),
  createSession: (data: { name: string; proxyKey?: string; fingerprintFile?: string; browser?: string }) =>
    post<SessionRecord>('/api/sessions/create', data),
  autoGenerateSessions: (count: number, prefix: string) =>
    post<{ created: SessionRecord[]; existing: SessionRecord[] }>('/api/sessions/auto', { count, prefix }),
  importAccounts: (csvContent: string) =>
    post<{ ok: boolean; count: number; created: number; existing: number }>('/api/accounts/import', { csvContent }),
  patchSession: (id: string, body: Record<string, unknown>) => patch<SessionRecord>(`/api/sessions/${enc(id)}`, body),
  cloneSession: (id: string, name: string, withCookies: boolean) =>
    post<SessionRecord>(`/api/sessions/${enc(id)}/clone`, { name, withCookies }),
  trashSession: (id: string) => del<{ ok: boolean }>(`/api/sessions/${enc(id)}`),
  bulk: (ids: string[], action: BulkAction, value?: unknown) =>
    post<{ ok: number; failed: Array<{ id: string; error: string }> }>('/api/sessions/bulk', { ids, action, value }),

  /* running */
  launchSessions: (ids: string[], threads?: number, url?: string) =>
    post<{ ok: boolean; count: number }>('/api/sessions/launch', { ids, threads, url }),
  stopSession: (id: string) => post<{ ok: boolean }>('/api/sessions/stop', { id }),
  stopAllSessions: () => post<{ ok: boolean }>('/api/sessions/stop', { all: true }),
  getPool: () => fetchJson<PoolStatus>('/api/pool'),
  setThreadLimit: (threads: number) => post<PoolStatus>('/api/pool', { threads }),

  /* cookies */
  getCookies: (id: string) => fetchJson<unknown[]>(`/api/sessions/${enc(id)}/cookies`),
  importCookies: (id: string, cookies: string) =>
    post<{ count: number; total: number; applied: 'now' | 'next launch' }>(`/api/sessions/${enc(id)}/cookies`, { cookies }),

  /* trash */
  getTrash: () => fetchJson<TrashItem[]>('/api/trash'),
  restore: (id: string) => post<SessionRecord>(`/api/trash/${enc(id)}/restore`),
  purge: (id: string) => del<{ ok: boolean }>(`/api/trash/${enc(id)}`),
  emptyTrash: () => del<{ purged: string[] }>('/api/trash'),

  /* resources */
  getResources: () =>
    fetchJson<{ proxies: ProxyResource[]; fingerprints: FingerprintResource[] }>('/api/resources'),
  testProxy: (proxy: ProxyResource) => post<Omit<ProxyProbe, 'status'> & { ok: boolean }>('/api/proxies/test', proxy),

  /* scripts */
  getScripts: () => fetchJson<Script[]>('/api/scripts'),
  createScript: (s: ScriptDraft) => post<Script>('/api/scripts', s),
  updateScript: (id: string, s: Partial<ScriptDraft>) => patch<Script>(`/api/scripts/${enc(id)}`, s),
  deleteScript: (id: string) => del<{ ok: boolean }>(`/api/scripts/${enc(id)}`),
  runScript: (target: { scriptId: string } | { draft: ScriptDraft }, ids: string[]) =>
    post<ScriptRun>('/api/scripts/run', { ...target, ids }),
  stopRun: (runId: string) => post<{ ok: boolean }>(`/api/scripts/runs/${enc(runId)}/stop`),
  getRuns: () => fetchJson<ScriptRun[]>('/api/scripts/runs'),

  /* desktop app */
  getApp: () => fetchJson<AppSettings>('/api/app'),
  patchApp: (body: Partial<AppSettings>) => patch<AppSettings>('/api/app', body),
  quitApp: () => post<{ ok: boolean }>('/api/app/quit'),

  /* misc */
  getLogs: (limit = 150) => fetchJson<LogEntry[]>(`/api/logs?limit=${limit}`),
  syncSheet: () => post<{ updated: number; created: number }>('/api/sheet/sync'),
  openTerminal: () => post<{ ok: boolean }>('/api/terminal/open'),
};

/** Triggers a browser download of `data` as a JSON file. */
export function downloadJson(filename: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
