import React, { useState, useMemo } from 'react';
import {
  Fingerprint,
  Copy,
  Check,
  Search,
  CheckCircle2,
  RefreshCw,
  LayoutGrid,
  List,
  Eye,
  ChevronLeft,
  ChevronRight,
  ShieldCheck,
} from 'lucide-react';
import type { FingerprintResource } from '../types';

interface FingerprintPanelProps {
  fingerprints: FingerprintResource[];
  onSelectInspect: (fpt: FingerprintResource) => void;
  onRefresh: () => void;
}

const COUNTRY_FLAGS: Record<string, string> = {
  US: '🇺🇸',
  GB: '🇬🇧',
  DE: '🇩🇪',
  FR: '🇫🇷',
  CA: '🇨🇦',
  AU: '🇦🇺',
  BR: '🇧🇷',
  IN: '🇮🇳',
  JP: '🇯🇵',
  NL: '🇳🇱',
  RU: '🇷🇺',
  AW: '🇦🇼',
  IT: '🇮🇹',
  ES: '🇪🇸',
  SE: '🇸🇪',
  CH: '🇨🇭',
};

export const FingerprintPanel: React.FC<FingerprintPanelProps> = ({
  fingerprints,
  onSelectInspect,
  onRefresh,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'available' | 'assigned' | 'chrome' | 'firefox'>('all');
  const [viewMode, setViewMode] = useState<'table' | 'cards'>('table');
  const [copiedFile, setCopiedFile] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedFile(text);
    setTimeout(() => setCopiedFile(null), 1500);
  };

  // Helper to extract clean metadata from filename if not pre-populated
  const getFptMeta = (f: FingerprintResource) => {
    if (f.country && f.shortId && f.browserName) {
      return { country: f.country, shortId: f.shortId, browserName: f.browserName };
    }
    const clean = f.file.replace(/\.json(\.gz)?$/, '');
    const parts = clean.split('_');
    const hash = parts[0] || f.file;
    const country = parts[1] || 'GLOBAL';
    const browserCode = parts[2] || 'C';
    return {
      country,
      shortId: hash.slice(0, 8),
      browserName: browserCode === 'F' ? 'Firefox' : 'Chrome',
    };
  };

  // Filtered dataset
  const filtered = useMemo(() => {
    return fingerprints.filter((f) => {
      const meta = getFptMeta(f);
      const matchesSearch =
        !searchTerm.trim() ||
        f.file.toLowerCase().includes(searchTerm.toLowerCase()) ||
        meta.country.toLowerCase().includes(searchTerm.toLowerCase()) ||
        meta.browserName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (f.userAgent && f.userAgent.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (f.assignedTo && f.assignedTo.toLowerCase().includes(searchTerm.toLowerCase()));

      if (!matchesSearch) return false;

      if (filterType === 'available') return !f.isAssigned;
      if (filterType === 'assigned') return f.isAssigned;
      if (filterType === 'chrome') return meta.browserName === 'Chrome';
      if (filterType === 'firefox') return meta.browserName === 'Firefox';
      return true;
    });
  }, [fingerprints, searchTerm, filterType]);

  // Pagination calculation
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const validPage = Math.min(currentPage, totalPages);
  const startIndex = (validPage - 1) * pageSize;
  const paginated = filtered.slice(startIndex, startIndex + pageSize);

  const handlePageChange = (newPage: number) => {
    if (newPage >= 1 && newPage <= totalPages) {
      setCurrentPage(newPage);
    }
  };

  return (
    <div>
      {/* Top Toolbar */}
      <div className="toolbar">
        <div className="toolbar-left">
          <div>
            <h2 style={{ fontSize: '17px', fontWeight: 800, color: 'var(--text-main)' }}>
              Browser Fingerprint Pool
            </h2>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              {fingerprints.length} total fingerprints indexed in resources/fpts/ (instant cached)
            </span>
          </div>
        </div>

        <div className="toolbar-right">
          {/* Quick Filter Pills */}
          <div className="filter-group">
            <button
              className={`filter-btn ${filterType === 'all' ? 'active' : ''}`}
              onClick={() => { setFilterType('all'); setCurrentPage(1); }}
            >
              All ({fingerprints.length})
            </button>
            <button
              className={`filter-btn ${filterType === 'available' ? 'active' : ''}`}
              onClick={() => { setFilterType('available'); setCurrentPage(1); }}
            >
              Available ({fingerprints.filter((f) => !f.isAssigned).length})
            </button>
            <button
              className={`filter-btn ${filterType === 'chrome' ? 'active' : ''}`}
              onClick={() => { setFilterType('chrome'); setCurrentPage(1); }}
            >
              Chrome
            </button>
            <button
              className={`filter-btn ${filterType === 'firefox' ? 'active' : ''}`}
              onClick={() => { setFilterType('firefox'); setCurrentPage(1); }}
            >
              Firefox
            </button>
            <button
              className={`filter-btn ${filterType === 'assigned' ? 'active' : ''}`}
              onClick={() => { setFilterType('assigned'); setCurrentPage(1); }}
            >
              Assigned
            </button>
          </div>

          {/* Search Box */}
          <div className="search-wrapper">
            <Search size={14} className="search-icon" />
            <input
              type="search"
              className="search-input"
              placeholder="Search by ID, country (US, DE), browser..."
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setCurrentPage(1);
              }}
            />
          </div>

          {/* View Mode Toggle */}
          <div className="filter-group">
            <button
              className={`filter-btn ${viewMode === 'table' ? 'active' : ''}`}
              onClick={() => setViewMode('table')}
              title="Table View"
            >
              <List size={15} />
            </button>
            <button
              className={`filter-btn ${viewMode === 'cards' ? 'active' : ''}`}
              onClick={() => setViewMode('cards')}
              title="Card Grid View"
            >
              <LayoutGrid size={15} />
            </button>
          </div>

          <button className="btn btn-secondary btn-sm" onClick={onRefresh} title="Reload Fingerprints">
            <RefreshCw size={13} />
            Refresh
          </button>
        </div>
      </div>

      {fingerprints.length === 0 ? (
        <div
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-lg)',
            padding: '48px',
            textAlign: 'center',
          }}
        >
          <Fingerprint size={40} color="var(--text-muted)" style={{ marginBottom: '14px' }} />
          <h3 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-main)', marginBottom: '8px' }}>
            No Fingerprints Found
          </h3>
          <p style={{ fontSize: '13px', color: 'var(--text-dim)', maxWidth: '520px', margin: '0 auto 16px' }}>
            Place your exported browser dumps (.json or .json.gz) into <code>resources/fpts/</code>.
          </p>
          <button className="btn btn-secondary" onClick={onRefresh}>
            Scan Resources
          </button>
        </div>
      ) : viewMode === 'table' ? (
        /* Clean Compact Table View */
        <div className="table-card">
          <div className="table-responsive">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: '140px' }}>Short ID</th>
                  <th style={{ width: '100px' }}>Country</th>
                  <th style={{ width: '110px' }}>Browser</th>
                  <th>Platform / Viewport</th>
                  <th style={{ width: '100px' }}>Format</th>
                  <th style={{ width: '130px' }}>Status</th>
                  <th style={{ width: '90px', textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {paginated.map((f) => {
                  const meta = getFptMeta(f);
                  const flag = COUNTRY_FLAGS[meta.country.toUpperCase()] || '🌐';

                  return (
                    <tr key={f.file}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span className="mono" style={{ fontSize: '12px', fontWeight: 700, color: 'var(--mint)' }}>
                            #{meta.shortId}
                          </span>
                          <button
                            className="btn-icon"
                            style={{ padding: '3px', borderRadius: '4px' }}
                            onClick={() => copyToClipboard(f.file)}
                            title="Copy full filename"
                          >
                            {copiedFile === f.file ? <Check size={11} color="var(--mint)" /> : <Copy size={11} />}
                          </button>
                        </div>
                      </td>
                      <td>
                        <span className="pill-country">
                          <span>{flag}</span>
                          <span>{meta.country}</span>
                        </span>
                      </td>
                      <td>
                        <span className={`pill-browser ${meta.browserName.toLowerCase()}`}>
                          {meta.browserName} {f.chromeVersion ? `v${f.chromeVersion.split('.')[0]}` : ''}
                        </span>
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{ fontSize: '12px', color: 'var(--text-main)', fontWeight: 500 }}>
                            {f.platform || 'Win32'}
                          </span>
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>•</span>
                          <span className="mono" style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                            {f.viewport || '1920x1080'}
                          </span>
                        </div>
                      </td>
                      <td>
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono' }}>
                          {f.file.endsWith('.gz') ? '.json.gz' : '.json'}
                        </span>
                      </td>
                      <td>
                        {f.isAssigned ? (
                          <span className="badge badge-assigned" title={f.assignedTo || ''}>
                            <span className="badge-dot" />
                            Assigned
                          </span>
                        ) : (
                          <span className="badge badge-available">
                            <span className="badge-dot" />
                            Available
                          </span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          className="btn btn-secondary btn-sm"
                          style={{ padding: '3px 8px', fontSize: '11px' }}
                          onClick={() => onSelectInspect(f)}
                          title="Inspect Raw Attributes"
                        >
                          <Eye size={12} />
                          Inspect
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Clean Pagination Bar */}
          <div className="pagination-container">
            <div>
              Showing <strong style={{ color: 'var(--text-main)' }}>{filtered.length ? startIndex + 1 : 0}</strong> to{' '}
              <strong style={{ color: 'var(--text-main)' }}>{Math.min(startIndex + pageSize, filtered.length)}</strong> of{' '}
              <strong style={{ color: 'var(--text-main)' }}>{filtered.length}</strong> fingerprints
            </div>

            <div className="pagination-controls">
              <button
                className="page-btn"
                disabled={validPage <= 1}
                onClick={() => handlePageChange(validPage - 1)}
              >
                <ChevronLeft size={14} />
              </button>

              <span style={{ padding: '0 8px', fontWeight: 600, color: 'var(--text-main)' }}>
                Page {validPage} of {totalPages}
              </span>

              <button
                className="page-btn"
                disabled={validPage >= totalPages}
                onClick={() => handlePageChange(validPage + 1)}
              >
                <ChevronRight size={14} />
              </button>

              <select
                className="page-btn"
                style={{ marginLeft: '10px', background: '#090d0b' }}
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setCurrentPage(1);
                }}
              >
                <option value={25}>25 / page</option>
                <option value={50}>50 / page</option>
                <option value={100}>100 / page</option>
              </select>
            </div>
          </div>
        </div>
      ) : (
        /* Card Grid View (Paginated) */
        <div>
          <div className="resource-grid">
            {paginated.map((f) => {
              const meta = getFptMeta(f);
              const flag = COUNTRY_FLAGS[meta.country.toUpperCase()] || '🌐';

              return (
                <div key={f.file} className="resource-card">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span className="pill-country">
                        <span>{flag}</span>
                        <span>{meta.country}</span>
                      </span>
                      <span className={`pill-browser ${meta.browserName.toLowerCase()}`}>
                        {meta.browserName}
                      </span>
                    </div>
                    {f.isAssigned ? (
                      <span className="badge badge-assigned">Assigned</span>
                    ) : (
                      <span className="badge badge-available">Available</span>
                    )}
                  </div>

                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span className="mono" style={{ fontSize: '13px', fontWeight: 700, color: 'var(--mint)' }}>
                        #{meta.shortId}
                      </span>
                      <button
                        className="btn-icon"
                        style={{ padding: '3px', borderRadius: '4px' }}
                        onClick={() => copyToClipboard(f.file)}
                        title="Copy filename"
                      >
                        {copiedFile === f.file ? <Check size={11} color="var(--mint)" /> : <Copy size={11} />}
                      </button>
                    </div>
                    <div className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '3px' }}>
                      {f.file}
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid var(--border-subtle)', paddingTop: '10px', marginTop: '4px', fontSize: '12px' }}>
                    <span style={{ color: 'var(--text-dim)' }}>
                      {f.platform} • {f.viewport}
                    </span>
                    <button
                      className="btn btn-secondary btn-sm"
                      style={{ padding: '3px 8px', fontSize: '11px' }}
                      onClick={() => onSelectInspect(f)}
                    >
                      <Eye size={12} />
                      Inspect
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Pagination Bar for Grid */}
          <div className="pagination-container" style={{ marginTop: '16px', borderRadius: 'var(--radius-md)' }}>
            <div>
              Showing {filtered.length ? startIndex + 1 : 0} to {Math.min(startIndex + pageSize, filtered.length)} of {filtered.length}
            </div>
            <div className="pagination-controls">
              <button
                className="page-btn"
                disabled={validPage <= 1}
                onClick={() => handlePageChange(validPage - 1)}
              >
                <ChevronLeft size={14} />
              </button>
              <span style={{ padding: '0 8px', fontWeight: 600, color: 'var(--text-main)' }}>
                Page {validPage} of {totalPages}
              </span>
              <button
                className="page-btn"
                disabled={validPage >= totalPages}
                onClick={() => handlePageChange(validPage + 1)}
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
