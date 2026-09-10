import React from 'react';
import {
  Cookie,
  Clock,
  Fingerprint,
  Globe,
  Play,
  SlidersHorizontal,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import type { SessionRecord } from '../types';
import { CopyButton, useElapsed } from '../ui';
import { fptShort } from './FingerprintPanel';

const AVATAR_COLORS = [
  '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
  '#ec4899', '#f43f5e', '#ef4444', '#f97316',
  '#f59e0b', '#84cc16', '#22c55e', '#14b8a6',
  '#06b6d4', '#3b82f6', '#2563eb', '#7c3aed',
];

function avatarColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

function initials(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '??';
}

const ago = (iso?: string) => {
  if (!iso) return '—';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
};

interface Props {
  session: SessionRecord;
  onClose: () => void;
  onLaunch: () => void;
  onStop: () => void;
  onEdit: () => void;
  onDelete: () => void;
  launching: boolean;
}

export const ProfileDrawer: React.FC<Props> = ({
  session: s,
  onClose,
  onLaunch,
  onStop,
  onEdit,
  onDelete,
  launching,
}) => {
  const live = s.status === 'live';
  const uptime = useElapsed(live ? s.liveInfo?.startedAt : null);
  const bg = s.color || avatarColor(s.id);

  return (
    <>
      <div className="drawer-scrim" onMouseDown={onClose} />
      <aside className="drawer" role="complementary" aria-label={`Profile details: ${s.id}`}>
        <div className="drawer-head">
          <div className="avatar" style={{ background: bg }}>
            {initials(s.id)}
          </div>
          <h2 title={s.id}>{s.id}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close drawer">
            <X size={15} />
          </button>
        </div>

        <div className="drawer-body">
          {/* Status */}
          <div className="drawer-section">
            <span className="drawer-section-title">Status</span>
            {live ? (
              <span className="badge live">
                <span className="dot" />
                {uptime || 'Live'}
              </span>
            ) : s.status === 'queued' ? (
              <span className="badge queued">
                <span className="dot" />
                Queued
              </span>
            ) : s.status === 'error' ? (
              <span className="badge error">{s.lastResult?.reason || 'Error'}</span>
            ) : (
              <span className="badge">
                <span className="dot" />
                {s.status === 'completed' ? 'Done' : 'Ready'}
              </span>
            )}
          </div>

          {/* Tags */}
          {s.tags && s.tags.length > 0 && (
            <div className="drawer-section">
              <span className="drawer-section-title">Tags</span>
              <div className="chips">
                {s.tags.map((t) => (
                  <span
                    key={t}
                    className="chip"
                    style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--txt-2)' }}
                  >
                    <span>{t}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Proxy */}
          <div className="drawer-section">
            <span className="drawer-section-title">Proxy</span>
            {s.proxy?.host ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span className="tag">
                  <Globe size={11} strokeWidth={1.75} />
                  <span>
                    {s.proxy.host}:{s.proxy.port}
                  </span>
                </span>
                <CopyButton
                  value={`${s.proxy.host}:${s.proxy.port}`}
                  label="Copy proxy"
                  size={12}
                />
              </div>
            ) : (
              <span className="dim">Direct connection</span>
            )}
          </div>

          {/* Fingerprint */}
          <div className="drawer-section">
            <span className="drawer-section-title">Fingerprint</span>
            {s.fingerprintFile ? (
              <span className="tag" title={s.fingerprintFile}>
                <Fingerprint size={11} strokeWidth={1.75} />
                <span>{fptShort(s.fingerprintFile)}</span>
              </span>
            ) : (
              <span className="dim">Default</span>
            )}
            {s.fingerprint && (
              <div className="code-block" style={{ fontSize: 10.5, lineHeight: 1.6 }}>
                {s.fingerprint.platform} · {s.fingerprint.chromeVersion || 'Chrome'}
                {'\n'}
                {typeof s.fingerprint.viewport === 'string'
                  ? s.fingerprint.viewport
                  : s.fingerprint.viewport
                    ? `${s.fingerprint.viewport.width}×${s.fingerprint.viewport.height}`
                    : '—'}
                {' · '}
                {s.fingerprint.timezone || '—'}
              </div>
            )}
          </div>

          {/* Details */}
          <div className="drawer-section">
            <span className="drawer-section-title">Details</span>
            <dl className="kv-grid">
              <div className="kv">
                <dt>
                  <Cookie size={11} style={{ verticalAlign: -1, marginRight: 4, opacity: 0.6 }} />
                  Cookies
                </dt>
                <dd>{s.cookieCount}</dd>
              </div>
              <div className="kv">
                <dt>
                  <Clock size={11} style={{ verticalAlign: -1, marginRight: 4, opacity: 0.6 }} />
                  Last opened
                </dt>
                <dd>{ago(s.lastOpenedAt)}</dd>
              </div>
            </dl>
          </div>

          {/* Notes */}
          {s.notes && (
            <div className="drawer-section">
              <span className="drawer-section-title">Notes</span>
              <p style={{ fontSize: 12.5, color: 'var(--txt-2)', lineHeight: 1.5 }}>{s.notes}</p>
            </div>
          )}
        </div>

        <div className="drawer-actions">
          {live ? (
            <button className="btn danger" onClick={onStop}>
              <Square size={12} strokeWidth={2.25} />
              Stop
            </button>
          ) : (
            <button className="btn primary" onClick={onLaunch} disabled={launching}>
              <Play size={12} strokeWidth={2.25} />
              Launch
            </button>
          )}
          <button className="btn" onClick={onEdit}>
            <SlidersHorizontal size={13} strokeWidth={1.75} />
            Configure
          </button>
          <button className="btn danger" onClick={onDelete}>
            <Trash2 size={13} strokeWidth={1.75} />
          </button>
        </div>
      </aside>
    </>
  );
};
