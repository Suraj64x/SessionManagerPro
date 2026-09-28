// Window control and broadcast. Same helper as ../../api.ts: the server refuses
// state-changing requests without X-SMP.
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

export type WindowAction = 'focus' | 'cascade' | 'tile' | 'minimize' | 'restore';
export type BroadcastOp = 'open_url' | 'reload' | 'close_other_tabs' | 'type' | 'press' | 'scroll';
export interface OpResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}
export type Results = Record<string, OpResult>;
export interface BroadcastRequest {
  op: BroadcastOp;
  args?: Record<string, unknown>;
  perProfile?: Record<string, { text: string }>;
}

export const windowsApi = {
  /** Per id: headless or stopped profiles come back as `{ ok: false, error }`. */
  window: (ids: string[], action: WindowAction) => post<{ results: Results }>('/api/sessions/window', { ids, action }),
  broadcast: (ids: string[], req: BroadcastRequest) => post<{ results: Results }>('/api/broadcast', { ids, ...req }),
};
