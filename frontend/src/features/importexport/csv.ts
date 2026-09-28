import type { Column, Field, ImportRow, PickedFile } from './types';

/* ---------------- delimited text ---------------- */

export const DELIMITERS = [
  [',', 'Comma'],
  [';', 'Semicolon'],
  ['\t', 'Tab'],
  ['|', 'Pipe'],
] as const;
export type Delimiter = (typeof DELIMITERS)[number][0];

/** The delimiter that splits the most lines into the same number of cells. */
export function detectDelimiter(text: string): Delimiter {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 30);
  let best: Delimiter = ',';
  let bestScore = 0;
  for (const [d] of DELIMITERS) {
    const counts = lines.map((l) => l.split(d).length - 1);
    const first = counts[0] || 0;
    if (!first) continue;
    const consistent = counts.filter((c) => c === first).length;
    const score = consistent * 1000 + counts.reduce((a, b) => a + b, 0);
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/** RFC 4180-style split: quotes wrap cells, "" is a literal quote, blank lines are dropped. */
export function parseDelimited(text: string, d: Delimiter): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const endRow = () => {
    row.push(cell);
    cell = '';
    if (row.some((c) => c.trim())) rows.push(row.map((c) => c.trim()));
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === d) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else cell += ch;
  }
  endRow();
  return rows;
}

/* ---------------- column guessing ---------------- */

export const FIELDS: Array<[Column, string]> = [
  ['name', 'Name / email'],
  ['proxy', 'Proxy'],
  ['cookies', 'Cookies'],
  ['tags', 'Tags'],
  ['status', 'Status'],
  ['folder', 'Folder'],
  ['notes', 'Notes'],
  ['startUrl', 'Start URL'],
  ['ignore', 'Ignore'],
];
export const fieldLabel = (c: Column) => FIELDS.find(([k]) => k === c)?.[1] ?? c;

const HEADER_HINTS: Array<[Field, RegExp]> = [
  ['name', /^(name|e-?mail|login|account|user(name)?|profile|id)$/i],
  ['proxy', /proxy|^ip$/i],
  ['cookies', /cookie/i],
  ['tags', /^tags?$/i],
  ['status', /^(status|label|state)$/i],
  ['folder', /^(folder|group|category)$/i],
  ['notes', /^(notes?|comments?|memo|description)$/i],
  ['startUrl', /url|start|home ?page|site|link/i],
];

export const guessFromHeader = (h: string): Column => HEADER_HINTS.find(([, re]) => re.test(h.trim()))?.[0] ?? 'ignore';

/** A header row names fields and holds no data-looking cells. */
export const looksLikeHeader = (row: string[]) =>
  row.some((c) => guessFromHeader(c) !== 'ignore') && !row.some((c) => c.includes('@') || /:\/\/|:\d{2,5}(:|$)/.test(c));

/** Without a header, the first non-empty value of a column says what it is. */
export function guessFromSample(cells: string[]): Column {
  const c = cells.find(Boolean) || '';
  if (!c) return 'ignore';
  if (/^[[{]/.test(c)) return 'cookies';
  if (/^https?:\/\//i.test(c)) return 'startUrl';
  if (/:\d{2,5}(:|$|@)/.test(c) && !proxyError(c)) return 'proxy';
  if (c.includes('@')) return 'name';
  return 'ignore';
}

/** One column per field; a later duplicate becomes Ignore, and something must be the name. */
export function assignUnique(guesses: Column[]): Column[] {
  const seen = new Set<Column>();
  const out = guesses.map((g) => (g === 'ignore' || seen.has(g) ? 'ignore' : (seen.add(g), g)));
  if (!seen.has('name') && out.length) out[Math.max(0, out.indexOf('ignore'))] = 'name';
  return out;
}

/* ---------------- validation (mirrors the server) ---------------- */

const BAD_PROXY = 'expected scheme://user:pass@host:port';
const hostOk = (h: string) => h.length > 0 && !/[\s/]/.test(h);
const portOk = (p: string | undefined) => /^\d{1,5}$/.test(p || '') && Number(p) >= 1 && Number(p) <= 65535;

/**
 * Mirrors manager.parseProxy: scheme://user:pass@host:port · user:pass@host:port ·
 * host:port:user:pass · host:port, with an optional trailing [change-ip url] and {name}.
 * Returns the reason, or null when the server would accept it.
 */
export function proxyError(raw: string): string | null {
  let body = raw.trim();
  for (let i = 0; i < 2; i++) {
    const m = body.match(/\s*(?:\[([^\]]*)\]|\{([^}]*)\})$/);
    if (!m) break;
    if (m[1] !== undefined && !/^https?:\/\/\S+$/i.test(m[1].trim())) return 'the change-IP URL must be http(s)';
    body = body.slice(0, -m[0].length);
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(body)) {
    let u: URL;
    try {
      u = new URL(body);
    } catch {
      return BAD_PROXY;
    }
    return hostOk(u.hostname) && portOk(u.port) ? null : BAD_PROXY;
  }
  if (body.includes('@')) {
    const [host, port, ...rest] = body.slice(body.lastIndexOf('@') + 1).split(':');
    return !rest.length && hostOk(host) && portOk(port) ? null : BAD_PROXY;
  }
  const [host, port, user, ...pw] = body.split(':');
  if (user !== undefined && !pw.length) return BAD_PROXY; // host:port:user without a password
  return hostOk(host) && portOk(port) ? null : BAD_PROXY;
}

/** The id the server derives from a name (manager.safeId). */
export const idOf = (raw: string) => raw.trim().replace(/[<>:"/\\|?*]/g, '_').slice(0, 120);

/** Mirrors manager.newId: the name becomes a folder on Windows. */
export function nameError(raw: string): string | null {
  const name = idOf(raw);
  if (!name) return 'name is empty';
  if (/^[. ]+$/.test(name)) return 'only dots or spaces';
  if (/[. ]$/.test(name)) return 'ends with a dot or a space';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)) return 'reserved on Windows';
  return null;
}

export const isWebUrl = (u: string) => u === 'about:blank' || /^https?:\/\/\S+$/i.test(u);

export const stripExt = (name: string) => name.replace(/\.[^.]+$/, '');

/** What a cookie file holds, from its first bytes; the server accepts exactly these two. */
export function cookieFormat(text: string): 'json' | 'netscape' | null {
  const t = text.trim();
  if (/^[[{]/.test(t)) return 'json';
  if (t.split(/\r?\n/).some((l) => l.split('\t').length >= 7)) return 'netscape';
  return null;
}

/* ---------------- files ---------------- */

/** Native picker; resolves [] when the user cancels. */
export const pickFiles = (accept: string, multiple = false) =>
  new Promise<File[]>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve([...(input.files || [])]);
    input.oncancel = () => resolve([]);
    input.click();
  });

export const readText = (files: File[]): Promise<PickedFile[]> =>
  Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text(), bytes: f.size })));

export const fmtBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;

/** Batches for the server: at most 500 rows and well under its 10 MB JSON limit. */
export function batches<T extends ImportRow | { name: string; text: string }>(items: T[], maxBytes = 6_000_000): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let bytes = 0;
  for (const it of items) {
    const size = JSON.stringify(it).length;
    if (cur.length && (cur.length >= 500 || bytes + size > maxBytes)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(it);
    bytes += size;
  }
  if (cur.length) out.push(cur);
  return out;
}

export const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
