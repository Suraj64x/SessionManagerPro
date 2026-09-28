import type { AddResult, AssignValue, CheckSummary, LibProxy, ParseRow, PlanRow, ProxyCheck } from './types';

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
const del = <T>(url: string) => fetchJson<T>(url, { method: 'DELETE' });
const enc = encodeURIComponent;

export type ProxyEdit = Partial<Pick<LibProxy, 'name' | 'notes' | 'changeIpUrl' | 'scheme' | 'username'>> & { password?: string };

export const api = {
  list: () => fetchJson<LibProxy[]>('/api/proxies'),
  /** Per-line preview; writes nothing. */
  parse: (text: string, defaultScheme: string, signal?: AbortSignal) =>
    fetchJson<ParseRow[]>('/api/proxies/parse', { method: 'POST', body: JSON.stringify({ text, defaultScheme }), signal }),
  add: (text: string, defaultScheme: string) => post<AddResult>('/api/proxies', { text, defaultScheme }),
  update: (id: string, body: ProxyEdit) => patch<LibProxy>(`/api/proxies/${enc(id)}`, body),
  /** `force` deletes a bound proxy; the profile keeps its own copy. */
  remove: (id: string, force = false) =>
    del<{ ok: boolean; keptBy: string | null; note?: string }>(`/api/proxies/${enc(id)}${force ? '?force=1' : ''}`),
  /** Resolves when every id is checked; each result also arrives as a `proxy` event. */
  check: (ids: string[]) => post<CheckSummary>('/api/proxies/check', { ids }),
  rotate: (id: string) => post<{ id: string; rotated: number; check: ProxyCheck | null }>(`/api/proxies/${enc(id)}/rotate`),
  /** The assignments the `proxy` bulk action would make, without writing. */
  plan: (profiles: string[], value: AssignValue, signal?: AbortSignal) =>
    fetchJson<{ plan: PlanRow[]; ok: number }>('/api/proxies/assign', {
      method: 'POST',
      body: JSON.stringify({ profiles, ...value, dryRun: true }),
      signal,
    }),
  /** The `proxy` bulk action itself: one free proxy per profile, fingerprint rebuilt. */
  assign: (profiles: string[], value: AssignValue) =>
    post<{ ok: number; failed: Array<{ id: string; error: string }> }>('/api/sessions/bulk', {
      ids: profiles,
      action: 'proxy',
      value,
    }),
};
