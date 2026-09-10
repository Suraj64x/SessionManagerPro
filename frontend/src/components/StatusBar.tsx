import React from 'react';
import { Cookie, Fingerprint, Globe, Layers, Play, Wifi } from 'lucide-react';

interface Props {
  totalProfiles: number;
  activeCount: number;
  queuedCount: number;
  totalCookies: number;
  proxiesFree: number;
  proxiesTotal: number;
  fpFree: number;
  fpTotal: number;
}

export const StatusBar: React.FC<Props> = ({
  totalProfiles,
  activeCount,
  queuedCount,
  totalCookies,
  proxiesFree,
  proxiesTotal,
  fpFree,
  fpTotal,
}) => (
  <div className="stats-bar" role="status" aria-label="Dashboard statistics">
    <div className="stat-card">
      <Layers size={16} strokeWidth={1.75} />
      <div className="stat-content">
        <span className="stat-val">{totalProfiles}</span>
        <span className="stat-label">Profiles</span>
      </div>
    </div>

    <div className={`stat-card${activeCount > 0 ? ' accent' : ''}`}>
      <Play size={16} strokeWidth={1.75} />
      <div className="stat-content">
        <span className="stat-val">{activeCount}</span>
        <span className="stat-label">Active</span>
      </div>
    </div>

    {queuedCount > 0 && (
      <div className="stat-card">
        <Wifi size={16} strokeWidth={1.75} />
        <div className="stat-content">
          <span className="stat-val">{queuedCount}</span>
          <span className="stat-label">Queued</span>
        </div>
      </div>
    )}

    <div className="stat-card">
      <Cookie size={16} strokeWidth={1.75} />
      <div className="stat-content">
        <span className="stat-val">{totalCookies.toLocaleString()}</span>
        <span className="stat-label">Cookies</span>
      </div>
    </div>

    <div className="stat-card">
      <Globe size={16} strokeWidth={1.75} />
      <div className="stat-content">
        <span className="stat-val">{proxiesFree}/{proxiesTotal}</span>
        <span className="stat-label">Proxies Free</span>
      </div>
    </div>

    <div className="stat-card">
      <Fingerprint size={16} strokeWidth={1.75} />
      <div className="stat-content">
        <span className="stat-val">{fpFree}/{fpTotal}</span>
        <span className="stat-label">Prints Free</span>
      </div>
    </div>
  </div>
);
