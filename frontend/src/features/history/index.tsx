import type { Contributions } from '../../contributions';
import { HistoryTab } from './HistoryTab';
import './history.css';

// Profile history and cookie snapshots, as a drawer tab. Keyed by id so switching
// profiles starts from a clean load instead of showing the last one's events.
export const contributions: Contributions = {
  drawerTabs: [{ id: 'history', label: 'History', render: (s) => <HistoryTab key={s.id} session={s} /> }],
};
