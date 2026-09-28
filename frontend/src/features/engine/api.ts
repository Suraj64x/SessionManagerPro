// Engine status and first-run download. Same helper as ../../api.ts: the X-SMP header on
// every request, the server's { error } as the thrown message.

export interface EngineVersions {
  app?: string;
  engine?: string;
  firefox?: string;
}

export interface EngineStatus {
  /** The Python that runs the worker, or null when the runtime is missing. */
  python: string | null;
  ready: boolean;
  detail: string;
  cacheDir: string | null;
  fetching: boolean;
  versions: EngineVersions;
}

/** A `engine` WebSocket message: one output line of the running download, or its outcome. */
export interface EngineEvent {
  state: 'running' | 'done' | 'error';
  line: string;
}

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

export const engineApi = {
  status: () => fetchJson<EngineStatus>('/api/engine'),
  fetch: () => fetchJson<{ ok: true }>('/api/engine/fetch', { method: 'POST' }),
};
