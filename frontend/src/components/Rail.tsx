import React from 'react';
import {
  Braces,
  ChevronsLeft,
  ChevronsRight,
  Earth,
  Fingerprint,
  House,
  Plug,
  RefreshCw,
  ScrollText,
  Settings2,
  UsersRound,
} from 'lucide-react';
import { FaceSvg, faceOf } from '../faces';
import type { Tab } from '../app-context';

export type { Tab };

type Item = { id: Tab; label: string; Icon: typeof UsersRound };
const MAIN: Item[] = [
  { id: 'home', label: 'Home', Icon: House },
  { id: 'profiles', label: 'Profiles', Icon: UsersRound },
  { id: 'automation', label: 'Automation', Icon: Braces },
  { id: 'proxies', label: 'Proxies', Icon: Earth },
  { id: 'fingerprints', label: 'Fingerprints', Icon: Fingerprint },
];
const BOTTOM: Item[] = [
  { id: 'api', label: 'API', Icon: Plug },
  { id: 'settings', label: 'Settings', Icon: Settings2 },
];
/** Shift+1…7 switches sections in this order. */
export const TAB_ORDER: Tab[] = [...MAIN, ...BOTTOM].map((i) => i.id);

// The brand mark is one of the faces, in the accent colour.
const MARK = faceOf('smp-mark', 'var(--accent)', { style: 'plain', eyes: 'happy', mouth: 'grin', dx: 0, dy: 1, tilt: -6 });

/** Logo + name, at the left of the app bar above the sidebar. */
export const Brand: React.FC = () => (
  <div className="brand">
    <FaceSvg face={MARK} size={34} />
    <span className="brand-name">SessionManagerPro</span>
  </div>
);

/** The sidebar: sections with labels, or icons only when collapsed. */
export const Rail: React.FC<{
  tab: Tab;
  onTab: (t: Tab) => void;
  liveCount: number;
  connected: boolean;
  logOpen: boolean;
  onToggleLog: () => void;
  onRefresh: () => void;
  collapsed: boolean;
  onCollapse: (collapsed: boolean) => void;
}> = ({ tab, onTab, liveCount, connected, logOpen, onToggleLog, onRefresh, collapsed, onCollapse }) => {
  const item = ({ id, label, Icon }: Item, index: number) => (
    <button
      key={id}
      className="rail-btn"
      aria-current={tab === id ? 'page' : undefined}
      aria-label={id === 'profiles' && liveCount ? `${label}, ${liveCount} running` : label}
      aria-keyshortcuts={`Shift+${index + 1}`}
      data-tip={collapsed ? label : undefined}
      onClick={() => onTab(id)}
    >
      <Icon size={18} strokeWidth={1.7} />
      {!collapsed && <span className="rail-label">{label}</span>}
      {id === 'profiles' && liveCount > 0 && (collapsed ? <span className="rail-dot" aria-hidden="true" /> : <span className="rail-count">{liveCount}</span>)}
    </button>
  );

  return (
    <nav className={`rail${collapsed ? ' collapsed' : ''}`} aria-label="Sections">
      {MAIN.map((it, i) => item(it, i))}
      <span className="rail-sep" />
      {BOTTOM.map((it, i) => item(it, MAIN.length + i))}
      <span className="rail-gap" />
      <button
        className="rail-btn"
        aria-pressed={logOpen}
        aria-label={connected ? 'Log' : 'Log, connection lost'}
        data-tip={collapsed ? (connected ? 'Log' : 'Log · reconnecting…') : undefined}
        onClick={onToggleLog}
      >
        <ScrollText size={18} strokeWidth={1.7} />
        {!collapsed && <span className="rail-label">Log</span>}
        {!connected && <span className="rail-dot offline" aria-hidden="true" />}
      </button>
      <button className="rail-btn" aria-label="Reload data" data-tip={collapsed ? 'Reload' : undefined} onClick={onRefresh}>
        <RefreshCw size={17} strokeWidth={1.7} />
        {!collapsed && <span className="rail-label">Reload</span>}
      </button>
      <button
        className="rail-btn"
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        data-tip={collapsed ? 'Expand' : undefined}
        onClick={() => onCollapse(!collapsed)}
      >
        {collapsed ? <ChevronsRight size={17} strokeWidth={1.7} /> : <ChevronsLeft size={17} strokeWidth={1.7} />}
        {!collapsed && <span className="rail-label">Collapse</span>}
      </button>
    </nav>
  );
};
