import { useEffect, useSyncExternalStore } from 'react';
import { api } from './api';
import type { LibProxy, ProxyCheck } from './types';

// One copy of the library for the view and the status bar, so a check started on the
// Proxies page keeps updating after the user leaves it.
interface State {
  list: LibProxy[] | null;
  error: string | null;
  /** Ids with a check or an IP change in flight. */
  busy: ReadonlySet<string>;
}

let state: State = { list: null, error: null, busy: new Set() };
const subs = new Set<() => void>();
const emit = (next: Partial<State>) => {
  state = { ...state, ...next };
  subs.forEach((f) => f());
};
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};

let inflight: Promise<void> | null = null;
let again = false;
/** Refetches the library; calls during a fetch collapse into one more fetch after it. */
export function reload(): Promise<void> {
  if (inflight) {
    again = true;
    return inflight;
  }
  inflight = api
    .list()
    .then(
      (list) => emit({ list, error: null }),
      (err: Error) => emit({ error: err.message })
    )
    .finally(() => {
      inflight = null;
      if (again) {
        again = false;
        void reload();
      }
    });
  return inflight;
}

export function patchCheck(id: string, check: ProxyCheck | null) {
  const busy = new Set(state.busy);
  busy.delete(id);
  emit({ busy, list: state.list && state.list.map((p) => (p.id === id ? { ...p, check } : p)) });
}

export function setBusy(ids: string[], on: boolean) {
  const busy = new Set(state.busy);
  for (const id of ids) {
    if (on) busy.add(id);
    else busy.delete(id);
  }
  emit({ busy });
}

export function useLibrary(): State {
  const s = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    if (!state.list) void reload();
  }, []);
  return s;
}

/* ---------------- presentation helpers ---------------- */

const STALE_MS = 30 * 60_000;

export type Health = 'ok' | 'failed' | 'stale' | 'unchecked';
export const healthOf = (c: ProxyCheck | null): Health =>
  !c ? 'unchecked' : Date.now() - Date.parse(c.at) > STALE_MS ? 'stale' : c.ok ? 'ok' : 'failed';

export const flag = (cc?: string | null) =>
  cc && /^[A-Z]{2}$/i.test(cc) ? String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '';

/** "(trash)"-suffixed bindings are not openable. */
export const liveOwner = (assignedTo: string | null) => (assignedTo && !assignedTo.endsWith(' (trash)') ? assignedTo : null);
