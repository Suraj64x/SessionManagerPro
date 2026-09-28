import { useSyncExternalStore } from 'react';

/**
 * Which of this feature's dialogs is open. Menu items unmount with their menu the moment
 * they are clicked, so they cannot hold the modal; `Dialogs` (mounted through the
 * `profilesAbove` slot) renders whatever is set here.
 */
export type Dialog = { kind: 'wizard' } | { kind: 'cookies' } | { kind: 'smp' } | { kind: 'export'; ids: string[] };

let current: Dialog | null = null;
const subs = new Set<() => void>();

export const openDialog = (d: Dialog | null) => {
  current = d;
  subs.forEach((f) => f());
};

export const useOpenDialog = () =>
  useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => {
        subs.delete(f);
      };
    },
    () => current
  );
