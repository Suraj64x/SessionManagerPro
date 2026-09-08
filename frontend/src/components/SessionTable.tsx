import React, { useState } from 'react';
import {
  Play,
  Square,
  Trash2,
  Search,
  Plus,
  Fingerprint,
  Globe,
  Cookie,
  ExternalLink,
  CheckSquare,
  Square as SquareOutline,
  AlertCircle,
  Copy,
  Check,
  Eye,
} from 'lucide-react';
import type { SessionRecord } from '../types';

interface SessionTableProps {
  sessions: SessionRecord[];
  selectedIds: string[];
  onToggleSelect: (id: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onLaunchOne: (id: string) => void;
  onStopOne: (id: string) => void;
  onDeleteOne: (id: string) => void;
  onInspectFingerprint: (session: SessionRecord) => void;
  onOpenNewModal: () => void;
}

export const SessionTable: React.FC<SessionTableProps> = ({
  sessions,
  selectedIds,
  onToggleSelect,
  onSelectAll,
  onClearSelection,
  onLaunchOne,
  onStopOne,
  onDeleteOne,
  onInspectFingerprint,
  onOpenNewModal,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'live' | 'queued' | 'ready' | 'error'>('all');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  const filteredSessions = sessions.filter((s) => {
    const matchesSearch =
      s.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
      s.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (s.proxy?.host && s.proxy.host.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (s.fingerprintFile && s.fingerprintFile.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (s.notes && s.notes.toLowerCase().includes(searchTerm.toLowerCase()));

    if (!matchesSearch) return false;

    if (statusFilter === 'all') return true;
    if (statusFilter === 'live') return s.status === 'live';
    if (statusFilter === 'queued') return s.status === 'queued';
    if (statusFilter === 'ready') return s.status === 'ready' || s.status === 'completed';
    if (statusFilter === 'error') return s.status === 'error';
    return true;
  });

  const allFilteredSelected =
    filteredSessions.length > 0 &&
    filteredSessions.every((s) => selectedIds.includes(s.id));

  return (
    <div>
      <div className="toolbar">
        <div className="toolbar-left">
          <div className="search-wrapper">
            <Search size={15} className="search-icon" />
            <input
              type="search"
              className="search-input"
              placeholder="Search by profile, proxy, fingerprint..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>

          <div style={{ display: 'flex', gap: '4px', background: 'rgba(0,0,0,0.2)', padding: '2px', borderRadius: '8px' }}>
            {(['all', 'live', 'queued', 'ready', 'error'] as const).map((tab) => (
              <button
                key={tab}
                className={`nav-tab ${statusFilter === tab ? 'active' : ''}`}
                style={{ padding: '4px 10px', fontSize: '12px' }}
                onClick={() => setStatusFilter(tab)}
              >
                {tab.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        <div className="toolbar-right">
          <button className="btn btn-primary" onClick={onOpenNewModal}>
            <Plus size={15} />
            New Profile
          </button>
        </div>
      </div>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ width: '40px' }}>
                <button
                  className="btn-icon"
                  style={{ padding: 0 }}
                  onClick={allFilteredSelected ? onClearSelection : onSelectAll}
                  title="Select all"
                >
                  {allFilteredSelected ? (
                    <CheckSquare size={16} color="var(--mint)" />
                  ) : (
                    <SquareOutline size={16} />
                  )}
                </button>
              </th>
              <th>Profile / Name</th>
              <th>Status</th>
              <th>Sticky Proxy</th>
              <th>Sticky Fingerprint</th>
              <th>Cookies</th>
              <th>Last Opened</th>
              <th style={{ textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredSessions.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ textAlign: 'center', padding: '48px', color: 'var(--text-muted)' }}>
                  {sessions.length === 0 ? (
                    <div>
                      <div style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-dim)', marginBottom: '6px' }}>
                        No profiles configured yet
                      </div>
                      <div style={{ fontSize: '13px', marginBottom: '16px' }}>
                        Click "New Profile" to create custom sessions or auto-generate numbered profiles.
                      </div>
                      <button className="btn btn-primary" onClick={onOpenNewModal}>
                        <Plus size={14} /> Create First Profile
                      </button>
                    </div>
                  ) : (
                    'No sessions match the selected filter.'
                  )}
                </td>
              </tr>
            ) : (
              filteredSessions.map((s) => {
                const isSelected = selectedIds.includes(s.id);
                const isLive = s.status === 'live';
                const isQueued = s.status === 'queued';
                const isError = s.status === 'error';

                return (
                  <tr key={s.id} className={isSelected ? 'selected' : ''}>
                    <td>
                      <button
                        className="btn-icon"
                        style={{ padding: 0 }}
                        onClick={() => onToggleSelect(s.id)}
                      >
                        {isSelected ? (
                          <CheckSquare size={16} color="var(--mint)" />
                        ) : (
                          <SquareOutline size={16} />
                        )}
                      </button>
                    </td>

                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <span style={{ fontWeight: 700, color: '#fff', fontSize: '13px' }}>
                          {s.id}
                        </span>
                        {s.notes && (
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                            {s.notes}
                          </span>
                        )}
                      </div>
                    </td>

                    <td>
                      {isLive && (
                        <span className="badge badge-live">
                          <span className="badge-dot" />
                          Running
                        </span>
                      )}
                      {isQueued && (
                        <span className="badge badge-queued">
                          <span className="badge-dot" />
                          Queued
                        </span>
                      )}
                      {isError && (
                        <span
                          className="badge badge-error"
                          title={s.lastResult?.reason || 'Error'}
                        >
                          <AlertCircle size={10} />
                          Error
                        </span>
                      )}
                      {!isLive && !isQueued && !isError && (
                        <span className="badge badge-ready">
                          <span className="badge-dot" />
                          {s.status === 'completed' ? 'Completed' : 'Ready'}
                        </span>
                      )}
                    </td>

                    <td>
                      {s.proxy?.host ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span className="proxy-tag">
                            <Globe size={11} color="var(--mint)" />
                            {s.proxy.host}:{s.proxy.port}
                          </span>
                          <button
                            className="btn-icon"
                            style={{ padding: '2px' }}
                            onClick={() =>
                              copyToClipboard(
                                `${s.proxy?.host}:${s.proxy?.port}`,
                                `proxy-${s.id}`
                              )
                            }
                            title="Copy Proxy"
                          >
                            {copiedKey === `proxy-${s.id}` ? (
                              <Check size={12} color="var(--mint)" />
                            ) : (
                              <Copy size={12} />
                            )}
                          </button>
                        </div>
                      ) : (
                        <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                          Direct
                        </span>
                      )}
                    </td>

                    <td>
                      {s.fingerprintFile ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span className="fpt-tag">
                            <Fingerprint size={11} color="var(--mint)" />
                            <span>
                              #{s.fingerprintFile.slice(0, 8)}
                              {s.fingerprintFile.includes('_') ? ` (${s.fingerprintFile.split('_')[1]})` : ''}
                            </span>
                          </span>
                          <button
                            className="btn-icon"
                            style={{ padding: '2px' }}
                            onClick={() => onInspectFingerprint(s)}
                            title="Inspect Fingerprint"
                          >
                            <Eye size={12} color="var(--mint)" />
                          </button>
                        </div>
                      ) : (
                        <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                          Default
                        </span>
                      )}
                    </td>

                    <td>
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                          color: s.cookieCount > 0 ? 'var(--emerald)' : 'var(--text-muted)',
                          fontSize: '12px',
                          fontWeight: 600,
                        }}
                      >
                        <Cookie size={12} />
                        {s.cookieCount}
                      </span>
                    </td>

                    <td style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                      {s.lastOpenedAt
                        ? new Date(s.lastOpenedAt).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : '—'}
                    </td>

                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: '6px' }}>
                        {isLive ? (
                          <button
                            className="btn btn-danger"
                            style={{ padding: '4px 8px', fontSize: '12px' }}
                            onClick={() => onStopOne(s.id)}
                            title="Close Window & Save Cookies"
                          >
                            <Square size={12} /> Stop
                          </button>
                        ) : (
                          <button
                            className="btn btn-success"
                            style={{ padding: '4px 8px', fontSize: '12px' }}
                            onClick={() => onLaunchOne(s.id)}
                            title="Launch Isolated Browser"
                          >
                            <Play size={12} /> Launch
                          </button>
                        )}
                        <button
                          className="btn-icon danger"
                          onClick={() => onDeleteOne(s.id)}
                          title="Delete Profile & Cookies"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
