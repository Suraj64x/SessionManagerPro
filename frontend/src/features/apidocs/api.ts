// The apidocs feature's own calls. Same helper as ../../api.ts: the server refuses
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
const enc = encodeURIComponent;

/** One row of the leak check: pass = as wanted, fail = a leak, warn = couldn't confirm. */
export interface LeakRow {
  key: 'ipv4' | 'ipv6' | 'webrtc' | 'local' | 'dns' | 'geo' | 'tz' | 'lang';
  label: string;
  value: string;
  status: 'pass' | 'fail' | 'warn';
  note: string;
}
export interface LeakResult {
  at: string;
  verdict: 'clean' | 'check' | 'leak';
  rows: LeakRow[];
  engine: string;
}

export const apidocsApi = {
  /** Checks a running profile for IP, IPv6, WebRTC, local IP and DNS leaks, geolocation, timezone and language. */
  leakCheck: (id: string) => post<LeakResult>(`/api/sessions/${enc(id)}/leakcheck`),
  /** One Playwright op on a running profile; the server 404s when it is not running. */
  runOp: (id: string, body: { op: string } & Record<string, unknown>) =>
    post<{ ok: true; value: unknown }>(`/api/sessions/${enc(id)}/op`, body),
  /** Launch one profile straight onto `url` (bypasses the panel's remembered start URL). */
  launchAt: (id: string, url: string) => post<{ ok: boolean; count: number }>('/api/sessions/launch', { ids: [id], url }),
};
