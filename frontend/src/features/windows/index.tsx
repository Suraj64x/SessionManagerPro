import type { Contributions } from '../../contributions';
import { ArrangeMenu, BroadcastButton, FocusButton, FocusItem } from './parts';
import './windows.css';

// Browser window control (focus, arrange) and broadcast to running profiles.
export const contributions: Contributions = {
  rowMenu: ({ session, close }) => <FocusItem session={session} close={close} />,
  liveActions: ({ session }) => <FocusButton session={session} />,
  bulkBar: ({ live }) => (
    <>
      <ArrangeMenu live={live} />
      <BroadcastButton live={live} />
    </>
  ),
};
