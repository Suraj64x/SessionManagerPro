import type { HomeSummary } from './types';

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

export const homeApi = {
  summary: () => fetchJson<HomeSummary>('/api/home'),
};
