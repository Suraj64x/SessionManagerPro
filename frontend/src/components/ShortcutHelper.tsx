import React from 'react';
import { Modal } from '../ui';

/** Single source of truth: the helper overlay and Settings both render this list. */
export const SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: ['Shift', '1…7'], label: 'Switch section' },
  { keys: ['/'], label: 'Search' },
  { keys: ['Ctrl', 'K'], label: 'Search' },
  { keys: ['Ctrl', 'A'], label: 'Select all shown profiles' },
  { keys: ['Ctrl', 'Enter'], label: 'Launch selected · run script in editor' },
  { keys: ['Ctrl', 'S'], label: 'Save script' },
  { keys: ['Delete'], label: 'Move selected to trash' },
  { keys: ['Esc'], label: 'Clear selection · close panel' },
  { keys: ['?'], label: 'Show shortcuts' },
];

export const ShortcutList: React.FC = () => (
  <div className="keys">
    {SHORTCUTS.map((s) => (
      <React.Fragment key={s.label + s.keys.join()}>
        <span className="inline" style={{ gap: 4 }}>
          {s.keys.map((k) => (
            <kbd key={k}>{k}</kbd>
          ))}
        </span>
        <span>{s.label}</span>
      </React.Fragment>
    ))}
  </div>
);

export const ShortcutHelper: React.FC<{ onClose: () => void }> = ({ onClose }) => (
  <Modal title="Keyboard shortcuts" width={400} onClose={onClose}>
    <ShortcutList />
  </Modal>
);
