import type { Run, Schedule, ScheduleDraft, WarmupRequest } from './types';

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
  warmup: (req: WarmupRequest) => post<Run>('/api/warmup', req),
  rerunFailed: (runId: string) => post<Run>(`/api/scripts/runs/${enc(runId)}/rerun-failed`),
  stopRun: (runId: string) => post<{ ok: boolean }>(`/api/scripts/runs/${enc(runId)}/stop`),

  schedules: () => fetchJson<Schedule[]>('/api/schedules'),
  createSchedule: (s: ScheduleDraft) => post<Schedule>('/api/schedules', s),
  updateSchedule: (id: string, s: Partial<ScheduleDraft>) => patch<Schedule>(`/api/schedules/${enc(id)}`, s),
  deleteSchedule: (id: string) => del<{ ok: boolean }>(`/api/schedules/${enc(id)}`),
  runSchedule: (id: string) => post<{ schedule: Schedule; run: Run }>(`/api/schedules/${enc(id)}/run`),
};
