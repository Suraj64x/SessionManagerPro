import React, { useState } from 'react';
import { X, Layers, Hash, FileSpreadsheet, Plus, AlertCircle } from 'lucide-react';
import type { ProxyResource, FingerprintResource } from '../types';

interface NewSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreateSingle: (name: string, proxy?: string, fingerprintFile?: string) => Promise<void>;
  onCreateBatch: (count: number, prefix: string) => Promise<void>;
  onImportCsv: (csvText: string) => Promise<void>;
  availableProxies: ProxyResource[];
  availableFingerprints: FingerprintResource[];
}

export const NewSessionModal: React.FC<NewSessionModalProps> = ({
  isOpen,
  onClose,
  onCreateSingle,
  onCreateBatch,
  onImportCsv,
  availableProxies,
  availableFingerprints,
}) => {
  const [mode, setMode] = useState<'single' | 'batch' | 'csv'>('single');
  const [singleName, setSingleName] = useState('');
  const [selectedProxy, setSelectedProxy] = useState('');
  const [selectedFpt, setSelectedFpt] = useState('');
  const [batchCount, setBatchCount] = useState(3);
  const [batchPrefix, setBatchPrefix] = useState('session');
  const [csvText, setCsvText] = useState('Email\nuser1@example.com\nuser2@example.com');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === 'single') {
        if (!singleName.trim()) throw new Error('Session name is required');
        await onCreateSingle(
          singleName.trim(),
          selectedProxy || undefined,
          selectedFpt || undefined
        );
      } else if (mode === 'batch') {
        if (batchCount < 1) throw new Error('Count must be at least 1');
        await onCreateBatch(batchCount, batchPrefix.trim() || 'session');
      } else if (mode === 'csv') {
        if (!csvText.trim()) throw new Error('CSV content cannot be empty');
        await onImportCsv(csvText);
      }
      onClose();
    } catch (err: any) {
      setError(err.message || 'Operation failed');
    } finally {
      setLoading(false);
    }
  };

  const freeProxies = availableProxies.filter((p) => !p.isAssigned);
  const freeFingerprints = availableFingerprints.filter((f) => !f.isAssigned);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">Create Browser Sessions</div>
          <button className="btn-icon" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div style={{ display: 'flex', borderBottom: '1px solid var(--border-subtle)', background: 'rgba(0,0,0,0.2)' }}>
          <button
            className={`nav-tab ${mode === 'single' ? 'active' : ''}`}
            style={{ flex: 1, borderRadius: 0, justifyContent: 'center', padding: '10px' }}
            onClick={() => setMode('single')}
          >
            <Layers size={14} /> Single Profile
          </button>
          <button
            className={`nav-tab ${mode === 'batch' ? 'active' : ''}`}
            style={{ flex: 1, borderRadius: 0, justifyContent: 'center', padding: '10px' }}
            onClick={() => setMode('batch')}
          >
            <Hash size={14} /> Auto Batch
          </button>
          <button
            className={`nav-tab ${mode === 'csv' ? 'active' : ''}`}
            style={{ flex: 1, borderRadius: 0, justifyContent: 'center', padding: '10px' }}
            onClick={() => setMode('csv')}
          >
            <FileSpreadsheet size={14} /> Import CSV
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {error && (
              <div
                style={{
                  background: 'var(--rose-dim)',
                  border: '1px solid rgba(244,63,94,0.3)',
                  color: 'var(--rose)',
                  padding: '10px 14px',
                  borderRadius: 'var(--radius-md)',
                  fontSize: '13px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                }}
              >
                <AlertCircle size={15} />
                {error}
              </div>
            )}

            {mode === 'single' && (
              <>
                <div className="form-group">
                  <label className="form-label">Profile Name / Email *</label>
                  <input
                    type="text"
                    className="form-control"
                    placeholder="e.g. store-manager-01 or account@outlook.com"
                    value={singleName}
                    onChange={(e) => setSingleName(e.target.value)}
                    required
                    autoFocus
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">
                    Sticky Proxy (Optional - leaves blank for auto-pick from pool)
                  </label>
                  <select
                    className="form-control"
                    value={selectedProxy}
                    onChange={(e) => setSelectedProxy(e.target.value)}
                  >
                    <option value="">Auto-assign next unused proxy ({freeProxies.length} available)</option>
                    {freeProxies.map((p) => (
                      <option key={p.key} value={p.url}>
                        {p.host}:{p.port} {p.username ? `(${p.username})` : ''}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label">
                    Sticky Fingerprint (Optional - leaves blank for auto-pick from pool)
                  </label>
                  <select
                    className="form-control"
                    value={selectedFpt}
                    onChange={(e) => setSelectedFpt(e.target.value)}
                  >
                    <option value="">Auto-assign next unused fingerprint ({freeFingerprints.length} available)</option>
                    {freeFingerprints.map((f) => (
                      <option key={f.file} value={f.file}>
                        {f.file} ({f.platform}, Chrome {f.chromeVersion})
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}

            {mode === 'batch' && (
              <>
                <div className="form-group">
                  <label className="form-label">Profile Prefix</label>
                  <input
                    type="text"
                    className="form-control"
                    placeholder="e.g. session, buyer, seller"
                    value={batchPrefix}
                    onChange={(e) => setBatchPrefix(e.target.value)}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">How Many Profiles to Generate?</label>
                  <input
                    type="number"
                    min="1"
                    max="50"
                    className="form-control"
                    value={batchCount}
                    onChange={(e) => setBatchCount(Number(e.target.value))}
                    required
                  />
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    Each profile will automatically receive a unique sticky proxy and hardware fingerprint from resources.
                  </span>
                </div>
              </>
            )}

            {mode === 'csv' && (
              <div className="form-group">
                <label className="form-label">Paste CSV Content (Requires "Email" Column)</label>
                <textarea
                  className="form-control mono"
                  rows={6}
                  value={csvText}
                  onChange={(e) => setCsvText(e.target.value)}
                  placeholder="Email&#10;user1@domain.com&#10;user2@domain.com"
                  required
                />
              </div>
            )}
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              <Plus size={14} />
              {loading ? 'Processing...' : 'Create Sessions'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
