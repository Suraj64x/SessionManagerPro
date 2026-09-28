import type { CreateResult, Template, TemplateDraft } from './types';

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

export const api = {
  list: () => fetchJson<Template[]>('/api/templates'),
  create: (t: Partial<TemplateDraft>) => post<Template>('/api/templates', t),
  update: (id: string, t: Partial<TemplateDraft>) => patch<Template>(`/api/templates/${enc(id)}`, t),
  remove: (id: string) => del<{ ok: boolean; default: string }>(`/api/templates/${enc(id)}`),
  duplicate: (id: string) => post<Template>(`/api/templates/${enc(id)}/duplicate`),
  /** Creates `count` profiles from the template; `folder` overrides the template's. */
  createProfiles: (id: string, count = 1, folder?: string) =>
    post<CreateResult>(`/api/templates/${enc(id)}/create`, { count, folder }),
};
