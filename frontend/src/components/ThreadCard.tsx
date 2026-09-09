import React from 'react';
import { Cpu, Globe, StopCircle, Play } from 'lucide-react';
import type { PoolStatus } from '../types';

interface ThreadCardProps {
  pool: PoolStatus | null;
  threadLimit: number;
  setThreadLimit: (val: number) => void;
  launchUrl: string;
  setLaunchUrl: (val: string) => void;
  onStopAll: () => void;
  onLaunchSelected: () => void;
  selectedCount: number;
  isLaunching: boolean;
}

export const ThreadCard: React.FC<ThreadCardProps> = ({
  pool,
  threadLimit,
  setThreadLimit,
  launchUrl,
  setLaunchUrl,
  onStopAll,
  onLaunchSelected,
  selectedCount,
  isLaunching,
}) => {
  const activeCount = pool?.activeCount || 0;
  const queuedCount = pool?.queuedCount || 0;
  const currentLimit = pool?.threadLimit || threadLimit;
  const percentage = Math.min(100, Math.round((activeCount / Math.max(1, currentLimit)) * 100));

  return (
    <div className="thread-card">
      <div className="thread-info">
        <div className="thread-title">
          <Cpu size={16} color="var(--mint)" />
          Thread Concurrency Orchestrator
          {queuedCount > 0 && (
            <span className="badge badge-queued" style={{ fontSize: '10px' }}>
              {queuedCount} queued
            </span>
          )}
        </div>
        <div className="thread-desc">
          Automated FIFO slot allocation. When an active browser window closes, the next queued session starts immediately.
        </div>
      </div>

      <div className="thread-meter-wrap">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
            <span style={{ color: 'var(--text-dim)' }}>Active Pool:</span>
            <strong style={{ color: 'var(--mint)' }}>
              {activeCount} / {currentLimit} max ({percentage}%)
            </strong>
          </div>
          <div className="thread-meter-bar">
            <div className="thread-meter-fill" style={{ width: `${percentage}%` }} />
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Cap:</span>
          <input
            type="range"
            min="1"
            max="15"
            className="thread-slider"
            value={threadLimit}
            onChange={(e) => setThreadLimit(Number(e.target.value))}
            title={`Max threads: ${threadLimit}`}
          />
          <span className="mono" style={{ fontSize: '13px', fontWeight: 700, minWidth: '20px' }}>
            {threadLimit}
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <Globe size={14} style={{ position: 'absolute', left: '10px', color: 'var(--text-muted)' }} />
          <input
            type="text"
            className="form-control"
            style={{ paddingLeft: '32px', width: '220px', padding: '6px 12px 6px 32px', fontSize: '12px' }}
            placeholder="Start URL (blank = tabs)"
            value={launchUrl}
            onChange={(e) => setLaunchUrl(e.target.value)}
          />
        </div>

        {selectedCount > 0 ? (
          <button
            className="btn btn-primary"
            onClick={onLaunchSelected}
            disabled={isLaunching}
          >
            <Play size={14} />
            Launch Selected ({selectedCount})
          </button>
        ) : null}

        {activeCount > 0 && (
          <button className="btn btn-danger" onClick={onStopAll} title="Save cookies and close all running windows">
            <StopCircle size={14} />
            Stop All ({activeCount})
          </button>
        )}
      </div>
    </div>
  );
};
