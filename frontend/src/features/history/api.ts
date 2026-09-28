import type { HistoryResponse, Snapshot } from './types';

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

const enc = encodeURIComponent;
const base = (id: string) => `/api/sessions/${enc(id)}`;

export const historyApi = {
  history: (id: string) => fetchJson<HistoryResponse>(`${base(id)}/history`),
  snapshots: (id: string) => fetchJson<Snapshot[]>(`${base(id)}/snapshots`),
  restore: (id: string, file: string) =>
    fetchJson<{ count: number; applied: 'now' | 'next launch' }>(`${base(id)}/snapshots/${enc(file)}/restore`, { method: 'POST' }),
  /** A plain GET: the browser downloads it (Content-Disposition), no header needed. */
  downloadUrl: (id: string, file: string) => `${base(id)}/snapshots/${enc(file)}`,
};
