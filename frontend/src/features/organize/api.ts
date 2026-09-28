import type { SessionRecord } from '../../types';
import type { AppSettings } from '../../api';

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-SMP': '1', ...options?.headers },
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
const enc = encodeURIComponent;

/** `status` sets the label, `folder` the folder; both are registered by backend/src/features/organize.js. */
export type OrganizeBulk = 'status' | 'folder' | 'label' | 'tag' | 'untag';

export const organizeApi = {
  patchSession: (id: string, body: Record<string, unknown>) => patch<SessionRecord>(`/api/sessions/${enc(id)}`, body),
  bulk: (ids: string[], action: OrganizeBulk, value?: unknown) =>
    post<{ ok: number; failed: Array<{ id: string; error: string }> }>('/api/sessions/bulk', { ids, action, value }),
  patchApp: (body: Partial<AppSettings>) => patch<AppSettings>('/api/app', body),
};
