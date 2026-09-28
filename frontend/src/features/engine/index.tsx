import type { Contributions } from '../../contributions';
import { Banner, EngineSettings } from './parts';
import './engine.css';

// Engine status, first-run download and versions (owned by the packaging team).
export const contributions: Contributions = {
  profilesAbove: () => <Banner />,
  settingsSections: [{ id: 'engine', title: 'Browser engine', render: () => <EngineSettings /> }],
};
