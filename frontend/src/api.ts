import type {
  SessionRecord,
  SystemStats,
  ProxyResource,
  FingerprintResource,
  LogEntry,
  PoolStatus,
} from './types';

const BASE = '';

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(BASE + url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = `HTTP error ${res.status}`;
    try {
      const parsed = JSON.parse(text);
      if (parsed.error) msg = parsed.error;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

export const api = {
  getStats: () => fetchJson<SystemStats>('/api/stats'),
  getSessions: () => fetchJson<SessionRecord[]>('/api/sessions'),
  createSession: (data: { name: string; proxy?: any; fingerprintFile?: string }) =>
    fetchJson<SessionRecord>('/api/sessions/create', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  autoGenerateSessions: (count: number, prefix: string) =>
    fetchJson<{ created: SessionRecord[]; existing: SessionRecord[] }>('/api/sessions/auto', {
      method: 'POST',
      body: JSON.stringify({ count, prefix }),
    }),
  launchSessions: (ids: string[], threads?: number, url?: string) =>
    fetchJson<{ ok: boolean; count: number }>('/api/sessions/launch', {
      method: 'POST',
      body: JSON.stringify({ ids, threads, url }),
    }),
  stopSession: (id: string) =>
    fetchJson<{ ok: boolean; id: string }>('/api/sessions/stop', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),
  stopAllSessions: () =>
    fetchJson<{ ok: boolean; stopped: string }>('/api/sessions/stop', {
      method: 'POST',
      body: JSON.stringify({ all: true }),
    }),
  deleteSession: (id: string) =>
    fetchJson<{ ok: boolean; id: string }>(`/api/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  patchSession: (id: string, patch: any) =>
    fetchJson<SessionRecord>(`/api/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  getResources: () =>
    fetchJson<{
      proxies: ProxyResource[];
      fingerprints: FingerprintResource[];
      accounts: string[];
    }>('/api/resources'),
  testProxy: (proxy: any) =>
    fetchJson<{ ok: boolean; latency?: number; ip?: string; error?: string }>('/api/proxies/test', {
      method: 'POST',
      body: JSON.stringify(proxy),
    }),
  importAccounts: (csvContent: string) =>
    fetchJson<{ ok: boolean; count: number; accounts: string[] }>('/api/accounts/import', {
      method: 'POST',
      body: JSON.stringify({ csvContent }),
    }),
  syncSheet: () => fetchJson<{ updated: number; created: number }>('/api/sheet/sync', { method: 'POST' }),
  getLogs: (limit = 100) => fetchJson<LogEntry[]>(`/api/logs?limit=${limit}`),
  getPool: () => fetchJson<PoolStatus>('/api/pool'),
  setThreadLimit: (threads: number) =>
    fetchJson<PoolStatus>('/api/pool', {
      method: 'POST',
      body: JSON.stringify({ threads }),
    }),
};
