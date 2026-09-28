import React, { useState } from 'react';
import { Earth } from 'lucide-react';
import type { Contributions } from '../../contributions';
import { useEvent } from '../../app-context';
import { AssignDialog } from './parts';
import { ProxiesView } from './ProxiesView';
import { patchCheck } from './store';
import type { ProxyCheck } from './types';
import './proxies.css';

export { ProxiesView };

/** Nothing to look at: it keeps the library in step with checks that finish on another tab. */
const ProxySync: React.FC = () => {
  useEvent('proxy', (d: { id: string; check: ProxyCheck | null }) => patchCheck(d.id, d.check));
  return null;
};

/** "Proxy…" in the profiles bulk bar. */
const AssignButton: React.FC<{ ids: string[] }> = ({ ids }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn xs" onClick={() => setOpen(true)}>
        <Earth size={12} /> Proxy…
      </button>
      {open && <AssignDialog profileIds={ids} onClose={() => setOpen(false)} />}
    </>
  );
};

export const contributions: Contributions = {
  statusItems: () => <ProxySync />,
  bulkBar: (ctx) => <AssignButton ids={ctx.ids} />,
};
