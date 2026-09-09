import React from 'react';
import { X, Fingerprint, Monitor, Cpu, HardDrive, Globe, Eye } from 'lucide-react';
import type { FingerprintSpec } from '../types';

interface FingerprintModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  fingerprint?: FingerprintSpec | any;
}

export const FingerprintModal: React.FC<FingerprintModalProps> = ({
  isOpen,
  onClose,
  title,
  fingerprint,
}) => {
  if (!isOpen || !fingerprint) return null;

  const vp = fingerprint.viewport || {};
  const gl = fingerprint.webgl || {};

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: '640px' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Fingerprint size={18} color="var(--violet)" />
            <div className="modal-title">{title}</div>
          </div>
          <button className="btn-icon" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-body" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
          <div className="form-group">
            <label className="form-label">User-Agent Header</label>
            <div
              className="mono"
              style={{
                background: 'rgba(0,0,0,0.3)',
                padding: '10px',
                borderRadius: 'var(--radius-sm)',
                fontSize: '11px',
                color: 'var(--cyan)',
                wordBreak: 'break-all',
              }}
            >
              {fingerprint.userAgent || 'Default'}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div className="form-group">
              <label className="form-label">Platform / OS</label>
              <div className="mono" style={{ fontSize: '12px', color: '#fff' }}>
                {fingerprint.platform || 'Win32'}
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Emulated Chrome Version</label>
              <div className="mono" style={{ fontSize: '12px', color: '#fff' }}>
                {fingerprint.chromeVersion || 'Latest'}
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Screen & Viewport</label>
              <div className="mono" style={{ fontSize: '12px', color: '#fff' }}>
                {typeof vp === 'string' ? vp : `${vp.width || 1920}x${vp.height || 1080}`}
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Timezone</label>
              <div className="mono" style={{ fontSize: '12px', color: '#fff' }}>
                {fingerprint.timezone || 'Auto'}
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">CPU Cores (Concurrency)</label>
              <div className="mono" style={{ fontSize: '12px', color: 'var(--cyan)' }}>
                {fingerprint.hardwareConcurrency || 8} logical cores
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Device Memory</label>
              <div className="mono" style={{ fontSize: '12px', color: 'var(--cyan)' }}>
                {fingerprint.deviceMemory || 8} GB
              </div>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">WebGL Unmasked Vendor</label>
            <div className="mono" style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
              {fingerprint.webglVendor || gl.vendor || 'Default Vendor'}
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">WebGL Unmasked GPU Renderer</label>
            <div
              className="mono"
              style={{
                fontSize: '11px',
                color: 'var(--violet)',
                background: 'rgba(0,0,0,0.3)',
                padding: '8px',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              {fingerprint.webglRenderer || gl.renderer || 'Default Renderer'}
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
