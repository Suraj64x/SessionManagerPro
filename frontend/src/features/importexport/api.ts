import type { ExportResult, ImportResult, ImportRow, SmpResult } from './types';

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

const post = <T>(url: string, body: unknown) => fetchJson<T>(url, { method: 'POST', body: JSON.stringify(body) });

export const api = {
  importProfiles: (rows: ImportRow[]) => post<ImportResult>('/api/import/profiles', { rows }),
  importCookieFiles: (files: Array<{ name: string; text: string }>) => post<ImportResult>('/api/import/cookie-files', { files }),
  exportSessions: (ids: string[], opts: { includeBrowserData: boolean; includeProxyPassword: boolean }) =>
    post<ExportResult>('/api/sessions/export', { ids, ...opts }),
  /** The .smp goes up as the raw zip body; that route has its own parser. */
  importSmp: (file: Blob) =>
    fetchJson<SmpResult>('/api/sessions/import', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file }),
};
