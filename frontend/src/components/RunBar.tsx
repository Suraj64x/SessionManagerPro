import React from 'react';
import { Globe, Loader2, Play, Square } from 'lucide-react';
import type { PoolStatus } from '../types';
import { Stepper } from '../ui';

interface Props {
  pool: PoolStatus | null;
  threadLimit: number;
  onThreadStep: (delta: 1 | -1) => void;
  url: string;
  onUrl: (v: string) => void;
  selectedCount: number;
  isLaunching: boolean;
  onLaunch: () => void;
  onStopAll: () => void;
}

export const RunBar: React.FC<Props> = ({
  pool,
  threadLimit,
  onThreadStep,
  url,
  onUrl,
  selectedCount,
  isLaunching,
  onLaunch,
  onStopAll,
}) => {
  const active = pool?.activeCount ?? 0;
  const queued = pool?.queuedCount ?? 0;
  const slots = Math.max(threadLimit, active);

  return (
    <div className="runbar">
      <div
        className="meter"
        data-tip="Concurrent browser windows"
        role="status"
        aria-label={`${active} of ${threadLimit} browser windows running${queued ? `, ${queued} queued` : ''}`}
      >
        <div className="meter-slots" aria-hidden="true">
          {Array.from({ length: slots }, (_, i) => (
            <span
              key={i}
              className={`meter-slot${i < active ? ' on' : i < active + queued ? ' queued' : ''}`}
            />
          ))}
        </div>
        <span className="meter-label">
          <b>{active}</b>/{threadLimit}
          {queued > 0 && <> · {queued} queued</>}
        </span>
      </div>

      <Stepper value={threadLimit} min={1} max={20} onStep={onThreadStep} label="Thread cap" />

      <div className="field grow" style={{ maxWidth: 340, flex: 1 }}>
        <Globe size={14} />
        <input
          className="input"
          placeholder="Start URL"
          value={url}
          onChange={(e) => onUrl(e.target.value)}
          aria-label="Start URL"
        />
      </div>

      <button
        className="btn primary"
        onClick={onLaunch}
        disabled={!selectedCount || isLaunching}
        data-tip={selectedCount ? 'Ctrl+Enter' : 'Select profiles first'}
      >
        {isLaunching ? (
          <Loader2 size={14} strokeWidth={2} className="spin" />
        ) : (
          <Play size={13} strokeWidth={2.25} />
        )}
        Launch{selectedCount ? ` ${selectedCount}` : ''}
      </button>

      {active > 0 && (
        <button className="btn danger" onClick={onStopAll}>
          <Square size={12} strokeWidth={2.25} />
          Stop all
        </button>
      )}
    </div>
  );
};
