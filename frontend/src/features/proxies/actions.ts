import { useCallback } from 'react';
import { useApp } from '../../app-context';
import { useUI } from '../../ui';
import { api } from './api';
import { patchCheck, reload, setBusy } from './store';
import type { LibProxy } from './types';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const labelOf = (p: LibProxy) => p.name || `${p.host}:${p.port}`;

/** Check, change IP, copy and delete, shared by the rows and the bulk bar. */
export function useProxyActions() {
  const { toast, confirm } = useUI();
  const { refresh } = useApp();

  /** Resolves when all are checked; rows update one by one through the `proxy` event. */
  const check = useCallback(
    async (ids: string[]) => {
      if (!ids.length) return;
      setBusy(ids, true);
      try {
        const s = await api.check(ids);
        // One row speaks for itself; a batch gets a summary.
        if (ids.length > 1) toast(s.failed ? 'info' : 'success', `Checked ${s.checked}: ${s.ok} ok · ${s.failed} failed`);
      } catch (err: any) {
        toast('error', err.message);
      } finally {
        setBusy(ids, false);
        // Events for rows the list did not have yet are lost; the stored results are not.
        void reload();
      }
    },
    [toast]
  );

  const rotate = useCallback(
    async (p: LibProxy) => {
      setBusy([p.id], true);
      try {
        const r = await api.rotate(p.id);
        patchCheck(p.id, r.check);
        if (!r.check?.ok) toast('error', `IP change sent, but the check failed: ${r.check?.error || 'unreachable'}`);
        else if (p.check?.ip && r.check.ip === p.check.ip) toast('info', `Same exit IP as before: ${r.check.ip}`);
        else toast('success', `New exit IP ${r.check.ip || ''}`.trim());
      } catch (err: any) {
        toast('error', err.message);
      } finally {
        setBusy([p.id], false);
      }
    },
    [toast]
  );

  const copyLines = useCallback(
    async (list: LibProxy[]) => {
      try {
        await navigator.clipboard.writeText(list.map((p) => p.line).join('\n'));
        toast('success', `Copied ${plural(list.length, 'line')}, without passwords`);
      } catch {
        toast('error', 'Clipboard unavailable');
      }
    },
    [toast]
  );

  /** Bound proxies go too: their profiles keep their own copy. */
  const remove = useCallback(
    async (list: LibProxy[]) => {
      if (!list.length) return false;
      const bound = list.filter((p) => p.isAssigned);
      const one = list.length === 1;
      const ok = await confirm({
        title: one ? `Delete ${labelOf(list[0])}?` : `Delete ${list.length} proxies?`,
        body: bound.length
          ? one
            ? `${bound[0].assignedTo} uses it and keeps its own copy. Only the library entry is removed.`
            : bound.length === 1
              ? `${bound[0].assignedTo} uses one of them and keeps its own copy. Only the library entries are removed.`
              : `${bound.length} are in use. Those profiles keep their own copies; only the library entries are removed.`
          : `${one ? 'It is' : 'They are'} removed from the library.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return false;
      const results = await Promise.allSettled(list.map((p) => api.remove(p.id, p.isAssigned)));
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed.length) toast('error', `${failed.length} not deleted: ${failed[0].reason?.message || failed[0].reason}`);
      else toast('success', `Deleted ${plural(list.length, 'proxy', 'proxies')}`);
      await reload();
      void refresh.resources();
      return true;
    },
    [confirm, toast, refresh]
  );

  return { check, rotate, copyLines, remove };
}
