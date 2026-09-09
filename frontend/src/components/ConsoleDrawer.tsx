import React, { useState, useEffect, useRef } from 'react';
import { Terminal, Trash2, ArrowDown, Filter } from 'lucide-react';
import type { LogEntry } from '../types';

interface ConsoleDrawerProps {
  logs: LogEntry[];
  onClear: () => void;
}

export const ConsoleDrawer: React.FC<ConsoleDrawerProps> = ({ logs, onClear }) => {
  const [selectedCat, setSelectedCat] = useState<string>('ALL');
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const logContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const filtered = logs.filter((l) =>
    selectedCat === 'ALL' ? true : l.category === selectedCat
  );

  return (
    <div className="console-card">
      <div className="console-header">
        <div className="console-title">
          <Terminal size={16} color="var(--mint)" />
          Live Audit Log Stream & Verification
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            ({filtered.length} entries)
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{ display: 'flex', gap: '4px' }}>
            {['ALL', 'PROXY', 'FINGERPRINT', 'BROWSER', 'SESSION', 'QUEUE'].map((cat) => (
              <button
                key={cat}
                className={`nav-tab ${selectedCat === cat ? 'active' : ''}`}
                style={{ padding: '3px 8px', fontSize: '10px' }}
                onClick={() => setSelectedCat(cat)}
              >
                {cat}
              </button>
            ))}
          </div>

          <button
            className={`btn-icon ${autoScroll ? 'active' : ''}`}
            onClick={() => setAutoScroll(!autoScroll)}
            title="Auto-scroll to bottom"
          >
            <ArrowDown size={14} color={autoScroll ? 'var(--mint)' : 'var(--text-muted)'} />
          </button>

          <button className="btn-icon" onClick={onClear} title="Clear Log Window">
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <div className="console-body" ref={logContainerRef}>
        {filtered.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '24px 0' }}>
            No log events in buffer. Logs stream here automatically during session launch and browser operations.
          </div>
        ) : (
          filtered.map((l) => (
            <div key={l.id} className="log-line">
              <span className="log-time">
                {new Date(l.timestamp).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })}
              </span>

              <span className={`log-cat ${l.category}`}>{l.category}</span>

              {l.sessionId && (
                <span
                  style={{
                    color: 'var(--text-dim)',
                    fontSize: '11px',
                    fontWeight: 600,
                  }}
                >
                  [{l.sessionId}]
                </span>
              )}

              <span className={`log-msg ${l.level}`}>{l.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
