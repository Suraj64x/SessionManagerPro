import type { Contributions } from '../../contributions';
import { FoldersSection, StatusesSection } from './sections';
import './organize.css';

// Statuses and folders: the lists live in app settings, edited in Settings; the Profiles
// table (components/ProfilesView.tsx) and the drawer read them through useOrganize().

export const contributions: Contributions = {
  settingsSections: [
    { id: 'statuses', title: 'Statuses', render: () => <StatusesSection /> },
    { id: 'folders', title: 'Folders', render: () => <FoldersSection /> },
  ],
};
