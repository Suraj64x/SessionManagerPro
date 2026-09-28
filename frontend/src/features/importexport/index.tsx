import { Cookie, Download, FileArchive, FileSpreadsheet } from 'lucide-react';
import type { Contributions } from '../../contributions';
import { Dialogs } from './dialogs';
import { openDialog } from './store';
import './importexport.css';

// Import wizard, profiles from cookie files, portable .smp export/import.
export const contributions: Contributions = {
  createMenu: ({ close }) => (
    <>
      <hr />
      <button onClick={() => (close(), openDialog({ kind: 'wizard' }))}>
        <FileSpreadsheet size={12} /> Import profiles…
      </button>
      <button onClick={() => (close(), openDialog({ kind: 'cookies' }))}>
        <Cookie size={12} /> Import from cookie files…
      </button>
      <button onClick={() => (close(), openDialog({ kind: 'smp' }))}>
        <FileArchive size={12} /> Import .smp…
      </button>
    </>
  ),
  rowMenu: ({ session, close }) => (
    <button onClick={() => (close(), openDialog({ kind: 'export', ids: [session.id] }))}>
      <Download size={12} /> Export…
    </button>
  ),
  bulkBar: ({ ids }) => (
    <button className="btn xs" onClick={() => openDialog({ kind: 'export', ids })}>
      <Download size={12} /> Export…
    </button>
  ),
  // Menu items unmount on click, so the dialogs live here; see store.ts.
  profilesAbove: () => <Dialogs />,
};
