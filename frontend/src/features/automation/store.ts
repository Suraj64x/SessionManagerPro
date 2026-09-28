import { useSyncExternalStore } from 'react';

/**
 * The profiles the Warm-up dialog is open for, or null. Row menus and the bulk bar unmount
 * the moment they are clicked, so the dialog lives in AutomationView (always mounted) and
 * is opened through here.
 */
let warmupIds: string[] | null = null;
const subs = new Set<() => void>();

export const openWarmup = (ids: string[] | null) => {
  warmupIds = ids;
  subs.forEach((f) => f());
};

export const useWarmupIds = () =>
  useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => {
        subs.delete(f);
      };
    },
    () => warmupIds
  );
