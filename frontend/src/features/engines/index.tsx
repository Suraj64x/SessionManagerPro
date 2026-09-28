import type { Contributions } from '../../contributions';
import { BulkBrowser, EnginesSection } from './parts';
import './engines.css';

// Browser engines: which browser each profile runs on (Stealth Firefox, Chromium builds, …).
export { EngineSelect } from './parts';

export const contributions: Contributions = {
  settingsSections: [{ id: 'browsers', title: 'Browsers', render: () => <EnginesSection /> }],
  bulkBar: ({ ids, live }) => <BulkBrowser ids={ids} running={live.length} />,
};
