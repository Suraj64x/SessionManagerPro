import { useMemo } from 'react';
import type { SessionRecord } from '../../types';
import { useApp } from '../../app-context';
import { useStored, useUI } from '../../ui';
import { organizeApi } from './api';
import { layoutRect } from '../../zoom';

/* ------------------------------------------------------------------ *
 * Statuses and folders (app settings "statuses" and "folders")
 * ------------------------------------------------------------------ */

export interface Status {
  name: string;
  color: string;
}

export const MAX_STATUSES = 30;
export const DEFAULT_STATUSES: Status[] = [
  { name: 'New', color: '#94a3b8' },
  { name: 'Warming', color: '#f5b544' },
  { name: 'Ready', color: '#22d3ee' },
  { name: 'Active', color: '#34d399' },
  { name: 'Banned', color: '#f43f5e' },
];

const isStatus = (x: unknown): x is Status =>
  typeof x === 'object' && x !== null && typeof (x as Status).name === 'string' && typeof (x as Status).color === 'string';

export const parseStatuses = (v: unknown): Status[] => (Array.isArray(v) && v.length && v.every(isStatus) ? v : DEFAULT_STATUSES);
export const parseFolders = (v: unknown): string[] => (Array.isArray(v) ? v.filter((f): f is string => typeof f === 'string') : []);

/** Labels written before the list existed may differ in case from the status they name. */
export const sameName = (a?: string, b?: string) => (a || '').toLowerCase() === (b || '').toLowerCase();
export const statusOf = (statuses: Status[], label?: string) => (label ? statuses.find((s) => sameName(s.name, label)) : undefined);
export const usedBy = (sessions: SessionRecord[], label: string) => sessions.filter((s) => sameName(s.label, label)).length;
export const inFolder = (sessions: SessionRecord[], folder: string) => sessions.filter((s) => (s.folder || '') === folder);

export function useOrganize() {
  const { app } = useApp();
  const statuses = app?.statuses;
  const folders = app?.folders;
  return useMemo(() => ({ statuses: parseStatuses(statuses), folders: parseFolders(folders) }), [statuses, folders]);
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Edits to the status list, plus the relabelling a rename or delete implies. */
export function useStatusOps() {
  const { sessions, refresh } = useApp();
  const { toast, confirm } = useUI();
  const { statuses } = useOrganize();

  const save = async (next: Status[]) => {
    try {
      await organizeApi.patchApp({ statuses: next });
      await refresh.app();
      return true;
    } catch (err) {
      toast('error', errMsg(err));
      return false;
    }
  };
  const relabel = async (from: string, to: string) => {
    const ids = sessions.filter((s) => sameName(s.label, from)).map((s) => s.id);
    if (!ids.length) return;
    try {
      const r = await organizeApi.bulk(ids, 'status', to);
      if (r.failed.length) toast('error', `${r.failed.length} failed: ${r.failed[0].error}`);
      await refresh.sessions();
    } catch (err) {
      toast('error', errMsg(err));
    }
  };
  const move = (i: number, d: 1 | -1) => {
    const next = [...statuses];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x);
    return save(next);
  };

  return {
    add: (st: Status) => save([...statuses, st]),
    recolor: (i: number, color: string) => save(statuses.map((s, j) => (j === i ? { ...s, color } : s))),
    move,
    rename: async (i: number, name: string) => {
      const old = statuses[i].name;
      if (await save(statuses.map((s, j) => (j === i ? { ...s, name } : s)))) await relabel(old, name);
    },
    remove: async (i: number) => {
      const st = statuses[i];
      const n = usedBy(sessions, st.name);
      const ok = await confirm({
        title: `Delete status “${st.name}”?`,
        body: n ? `${n} profile${n === 1 ? '' : 's'} use it and will have no status.` : 'No profile uses it.',
        confirmLabel: 'Delete',
        danger: true,
      });
      if (ok && (await save(statuses.filter((_, j) => j !== i)))) await relabel(st.name, '');
    },
  };
}

/** Edits to the folder list, and moving profiles between folders. */
export function useFolderOps() {
  const { sessions, refresh } = useApp();
  const { toast, confirm } = useUI();
  const { folders } = useOrganize();

  const save = async (next: string[]) => {
    try {
      await organizeApi.patchApp({ folders: next });
      await refresh.app();
      return true;
    } catch (err) {
      toast('error', errMsg(err));
      return false;
    }
  };
  const move = async (ids: string[], folder: string) => {
    if (!ids.length) return;
    try {
      const r = await organizeApi.bulk(ids, 'folder', folder);
      if (r.failed.length) toast('error', `${r.failed.length} failed: ${r.failed[0].error}`);
      else toast('success', folder ? `Moved ${r.ok} to ${folder}` : `Unfiled ${r.ok}`);
      await refresh.sessions();
    } catch (err) {
      toast('error', errMsg(err));
    }
  };

  return {
    move,
    create: (name: string) => {
      if (folders.some((f) => sameName(f, name))) {
        toast('error', `A folder named ${name} already exists`);
        return Promise.resolve(false);
      }
      return save([...folders, name]);
    },
    reorder: (i: number, d: 1 | -1) => {
      const next = [...folders];
      const [x] = next.splice(i, 1);
      next.splice(i + d, 0, x);
      return save(next);
    },
    rename: async (old: string, name: string) => {
      if (folders.some((f) => f !== old && sameName(f, name))) {
        toast('error', `A folder named ${name} already exists`);
        return false;
      }
      if (!(await save(folders.map((f) => (f === old ? name : f))))) return false;
      await move(inFolder(sessions, old).map((s) => s.id), name);
      return true;
    },
    remove: async (name: string) => {
      const n = inFolder(sessions, name).length;
      const ok = await confirm({
        title: `Delete folder “${name}”?`,
        body: n ? `${n} profile${n === 1 ? '' : 's'} in it are kept, just unfiled.` : 'It is empty.',
        confirmLabel: 'Delete folder',
        danger: true,
      });
      if (!ok) return false;
      await move(inFolder(sessions, name).map((s) => s.id), '');
      return save(folders.filter((f) => f !== name));
    },
  };
}

/** Viewport point to anchor a popover at: a pointer, or an element's rect (`h` drops it below). */
export type Anchor = { x: number; y: number; h?: number };
export const anchorOf = (el: Element): Anchor => {
  const r = layoutRect(el); // the panel's own pixels, whatever the zoom
  return { x: r.left, y: r.top, h: r.height };
};

/* ------------------------------------------------------------------ *
 * Table columns, sorting, filters
 * ------------------------------------------------------------------ */

export type SortKey = 'name' | 'status' | 'lastOpened' | 'created' | 'launches' | 'cookies';
export type ColumnId =
  | 'name'
  | 'status'
  | 'tags'
  | 'notes'
  | 'proxy'
  | 'browser'
  | 'leak'
  | 'exitIp'
  | 'fingerprint'
  | 'cookies'
  | 'folder'
  | 'launches'
  | 'workTime'
  | 'lastOpened'
  | 'created';

export const COLUMNS: Array<{ id: ColumnId; label: string; sort?: SortKey; num?: boolean }> = [
  { id: 'name', label: 'Name', sort: 'name' },
  { id: 'status', label: 'Status', sort: 'status' },
  { id: 'tags', label: 'Tags' },
  { id: 'notes', label: 'Notes' },
  { id: 'proxy', label: 'Proxy' },
  { id: 'browser', label: 'Browser' },
  { id: 'leak', label: 'Leak check' },
  { id: 'exitIp', label: 'Exit IP' },
  { id: 'fingerprint', label: 'Fingerprint' },
  { id: 'cookies', label: 'Cookies', sort: 'cookies', num: true },
  { id: 'folder', label: 'Folder' },
  { id: 'launches', label: 'Launches', sort: 'launches', num: true },
  { id: 'workTime', label: 'Work time', num: true },
  { id: 'lastOpened', label: 'Last opened', sort: 'lastOpened' },
  { id: 'created', label: 'Created', sort: 'created' },
];
// Notes stay off by default: they show under the name, and the defaults must fit 1280 px with the rail open.
export const DEFAULT_COLUMNS: ColumnId[] = ['name', 'status', 'tags', 'proxy', 'cookies', 'lastOpened'];

export function useColumns() {
  const [cols, setCols] = useStored<ColumnId[]>('profiles.cols', DEFAULT_COLUMNS);
  const [compact, setCompact] = useStored<boolean>('profiles.compact', false);
  // Name stays first; ids from an older build are dropped.
  const visible = useMemo(
    () => ['name' as ColumnId, ...cols.filter((c) => c !== 'name' && COLUMNS.some((k) => k.id === c))],
    [cols]
  );
  return { visible, setCols, compact, setCompact };
}

export interface Filters {
  statuses: string[];
  noStatus: boolean;
  tags: string[];
  tagMode: 'any' | 'all';
  noTags: boolean;
}
export const NO_FILTERS: Filters = { statuses: [], noStatus: false, tags: [], tagMode: 'any', noTags: false };
export const filterCount = (f: Filters) => f.statuses.length + Number(f.noStatus) + f.tags.length + Number(f.noTags);

export function matchesFilters(s: SessionRecord, f: Filters): boolean {
  if (f.noStatus || f.statuses.length) {
    const hit = (f.noStatus && !s.label) || f.statuses.some((n) => sameName(n, s.label));
    if (!hit) return false;
  }
  const tags = s.tags || [];
  if (f.noTags && tags.length) return false;
  if (f.tags.length) {
    const has = (t: string) => tags.includes(t);
    if (f.tagMode === 'all' ? !f.tags.every(has) : !f.tags.some(has)) return false;
  }
  return true;
}

/** Toggles `value` in `list`. */
export const toggleIn = (list: string[], value: string) =>
  list.includes(value) ? list.filter((x) => x !== value) : [...list, value];

export const fmtWork = (secs?: number) => {
  if (!secs) return '—';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m` : '<1m';
};
