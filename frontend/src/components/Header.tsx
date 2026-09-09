import React from 'react';
import {
  Layers,
  Activity,
  Globe,
  Fingerprint,
  Cookie,
  RefreshCw,
  FileSpreadsheet,
  Terminal,
  ShieldCheck,
} from 'lucide-react';
import type { SystemStats, PoolStatus } from '../types';

interface HeaderProps {
  stats: SystemStats | null;
  pool: PoolStatus | null;
  activeTab: 'sessions' | 'proxies' | 'fingerprints' | 'logs';
  setActiveTab: (tab: 'sessions' | 'proxies' | 'fingerprints' | 'logs') => void;
  onRefresh: () => void;
  onSyncSheet: () => void;
  isSyncing: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  stats,
  pool,
  activeTab,
  setActiveTab,
  onRefresh,
  onSyncSheet,
  isSyncing,
}) => {
  return (
    <header className="header">
      <div className="brand">
        <div className="brand-logo">
          <ShieldCheck size={22} />
        </div>
        <div>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <span className="brand-name">SessionManagerPro</span>
            <span className="brand-tag">v1.0 Pro</span>
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            Anti-Detect Chromium Orchestrator
          </div>
        </div>
      </div>

      <div className="nav-tabs">
        <button
          className={`nav-tab ${activeTab === 'sessions' ? 'active' : ''}`}
          onClick={() => setActiveTab('sessions')}
        >
          <Layers size={15} />
          Sessions
        </button>
        <button
          className={`nav-tab ${activeTab === 'proxies' ? 'active' : ''}`}
          onClick={() => setActiveTab('proxies')}
        >
          <Globe size={15} />
          Proxies {stats ? `(${stats.proxiesTotal})` : ''}
        </button>
        <button
          className={`nav-tab ${activeTab === 'fingerprints' ? 'active' : ''}`}
          onClick={() => setActiveTab('fingerprints')}
        >
          <Fingerprint size={15} />
          Fingerprints {stats ? `(${stats.fingerprintsTotal})` : ''}
        </button>
        <button
          className={`nav-tab ${activeTab === 'logs' ? 'active' : ''}`}
          onClick={() => setActiveTab('logs')}
        >
          <Terminal size={15} />
          Live Audit Logs
        </button>
      </div>

      <div className="header-stats">
        <div className="stat-pill threads">
          <Activity size={14} color="var(--mint)" />
          <span>Live Threads:</span>
          <strong>
            {pool ? `${pool.activeCount} / ${pool.threadLimit}` : '0 / 5'}
          </strong>
        </div>

        <div className="stat-pill">
          <Cookie size={14} color="var(--emerald-main)" />
          <span>Cookies:</span>
          <strong>{stats?.totalCookies ?? 0}</strong>
        </div>

        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            className="btn btn-secondary"
            style={{ padding: '6px 12px' }}
            onClick={onSyncSheet}
            disabled={isSyncing}
            title="Sync with sessions.csv / HTML sheet"
          >
            <FileSpreadsheet size={14} />
            {isSyncing ? 'Syncing...' : 'Sync Sheet'}
          </button>
          <button
            className="btn btn-icon"
            onClick={onRefresh}
            title="Refresh All Data"
          >
            <RefreshCw size={15} />
          </button>
        </div>
      </div>
    </header>
  );
};
