import React from 'react';
import { AppWindow, Fingerprint, Globe, RefreshCw, Settings, Table2 } from 'lucide-react';

export type Tab = 'sessions' | 'proxies' | 'fingerprints';

const NAV: Array<{ id: Tab; label: string; Icon: typeof AppWindow }> = [
  { id: 'sessions', label: 'Profiles', Icon: AppWindow },
  { id: 'proxies', label: 'Proxies', Icon: Globe },
  { id: 'fingerprints', label: 'Fingerprints', Icon: Fingerprint },
];

export const Rail: React.FC<{
  tab: Tab;
  onTab: (t: Tab) => void;
  liveCount: number;
  onRefresh: () => void;
  onSync: () => void;
  isSyncing: boolean;
  proxiesCount?: number;
  fpCount?: number;
}> = ({ tab, onTab, liveCount, onRefresh, onSync, isSyncing, proxiesCount, fpCount }) => {
  const counts: Record<Tab, number | undefined> = {
    sessions: undefined, // shown via live dot instead
    proxies: proxiesCount,
    fingerprints: fpCount,
  };

  return (
    <nav className="rail" aria-label="Sections">
      <div className="rail-mark" aria-hidden="true" title="SessionManager Pro">
        SM
      </div>

      {NAV.map(({ id, label, Icon }) => (
        <button
          key={id}
          className="rail-btn"
          aria-current={tab === id ? 'page' : undefined}
          aria-label={id === 'sessions' && liveCount > 0 ? `${label}, ${liveCount} live` : label}
          data-tip={label}
          onClick={() => onTab(id)}
        >
          <Icon size={17} strokeWidth={1.75} />
          {id === 'sessions' && liveCount > 0 && <span className="rail-dot" aria-hidden="true" />}
          {counts[id] !== undefined && counts[id]! > 0 && (
            <span className="rail-count" aria-hidden="true">
              {counts[id]! > 99 ? '99+' : counts[id]}
            </span>
          )}
        </button>
      ))}

      <span className="rail-spacer" />

      <button
        className="rail-btn"
        aria-label="Sync sheet"
        data-tip="Sync sheet"
        onClick={onSync}
        disabled={isSyncing}
      >
        <Table2 size={17} strokeWidth={1.75} className={isSyncing ? 'spin' : undefined} />
      </button>
      <button className="rail-btn" aria-label="Reload data" data-tip="Reload data" onClick={onRefresh}>
        <RefreshCw size={17} strokeWidth={1.75} />
      </button>
      <button className="rail-btn" aria-label="Settings" data-tip="Settings" disabled>
        <Settings size={17} strokeWidth={1.75} />
      </button>
    </nav>
  );
};
