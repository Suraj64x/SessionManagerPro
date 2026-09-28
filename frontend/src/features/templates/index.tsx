import type { Contributions } from '../../contributions';
import { QuickProfile, TemplatesSection } from './parts';
import './templates.css';

// Profile templates: the Quick profile split button on Profiles and the Templates settings section.
export const contributions: Contributions = {
  profilesPrimary: ({ onNew }) => <QuickProfile onNew={onNew} />,
  settingsSections: [{ id: 'templates', title: 'Templates', render: () => <TemplatesSection /> }],
};
