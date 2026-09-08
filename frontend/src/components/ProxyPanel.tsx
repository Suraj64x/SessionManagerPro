import React, { useState, useMemo } from 'react';
import {
  Globe,
  Loader2,
  Copy,
  Check,
  Zap,
  Search,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  ShieldCheck,
} from 'lucide-react';
import type { ProxyResource } from '../types';
import { api } from '../api';

interface ProxyPanelProps {
  proxies: ProxyResource[];
  onRefresh: () => void;
}

export const ProxyPanel: React.FC<ProxyPanelProps> = ({ proxies, onRefresh }) => {
  const [testResults, setTestResults] = useState<
    Record<string, { status: 'testing' | 'success' | 'failed'; latency?: number; ip?: string; error?: string }>
  >({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [testingAll, setTestingAll] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'available' | 'assigned'>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  const testOne = async (p: ProxyResource) => {
    setTestResults((prev) => ({
      ...prev,
      [p.key]: { status: 'testing' },
    }));

    try {
      const res = await api.testProxy(p);
      if (res.ok) {
        setTestResults((prev) => ({
          ...prev,
          [p.key]: { status: 'success', latency: res.latency, ip: res.ip },
        }));
      } else {
        setTestResults((prev) => ({
          ...prev,
          [p.key]: { status: 'failed', error: res.error || 'Connection failed' },
        }));
      }
    } catch (err: any) {
      setTestResults((prev) => ({
        ...prev,
        [p.key]: { status: 'failed', error: err.message },
      }));
    }
  };

  const testAll = async () => {
    setTestingAll(true);
    for (const p of paginated) {
      await testOne(p);
    }
    setTestingAll(false);
  };

  // Filtered
  const filtered = useMemo(() => {
    return proxies.filter((p) => {
      const matchesSearch =
        !searchTerm.trim() ||
        p.host.toLowerCase().includes(searchTerm.toLowerCase()) ||
        String(p.port).includes(searchTerm) ||
        (p.username && p.username.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (p.assignedTo && p.assignedTo.toLowerCase().includes(searchTerm.toLowerCase()));

      if (!matchesSearch) return false;

      if (filterStatus === 'available') return !p.isAssigned;
      if (filterStatus === 'assigned') return p.isAssigned;
      return true;
    });
  }, [proxies, searchTerm, filterStatus]);

  // Pagination
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
              Proxy Pool & Health Auditor
            </h2>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              {proxies.length} proxies loaded from resources/proxies/
            </span>
          </div>
        </div>

        <div className="toolbar-right">
          {/* Quick Filter Pills */}
          <div className="filter-group">
            <button
              className={`filter-btn ${filterStatus === 'all' ? 'active' : ''}`}
              onClick={() => { setFilterStatus('all'); setCurrentPage(1); }}
            >
              All ({proxies.length})
            </button>
            <button
              className={`filter-btn ${filterStatus === 'available' ? 'active' : ''}`}
              onClick={() => { setFilterStatus('available'); setCurrentPage(1); }}
            >
              Available ({proxies.filter((p) => !p.isAssigned).length})
            </button>
            <button
              className={`filter-btn ${filterStatus === 'assigned' ? 'active' : ''}`}
              onClick={() => { setFilterStatus('assigned'); setCurrentPage(1); }}
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
              placeholder="Filter by IP, port, or user..."
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setCurrentPage(1);
              }}
            />
          </div>

          <button
            className="btn btn-secondary btn-sm"
            onClick={testAll}
            disabled={testingAll || proxies.length === 0}
          >
            {testingAll ? <Loader2 size={13} className="spin" /> : <Zap size={13} color="var(--mint)" />}
            {testingAll ? 'Testing Page...' : 'Test Visible'}
          </button>

          <button className="btn btn-secondary btn-sm" onClick={onRefresh} title="Reload Proxies">
            <RefreshCw size={13} />
            Refresh
          </button>
        </div>
      </div>

      {proxies.length === 0 ? (
        <div
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-lg)',
            padding: '48px',
            textAlign: 'center',
          }}
        >
          <Globe size={40} color="var(--text-muted)" style={{ marginBottom: '14px' }} />
          <h3 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-main)', marginBottom: '8px' }}>
            No Proxies Found
          </h3>
          <p style={{ fontSize: '13px', color: 'var(--text-dim)', maxWidth: '480px', margin: '0 auto 16px' }}>
            Place your proxy list in <code>resources/proxies/proxies.txt</code> with one proxy per line.
          </p>
          <button className="btn btn-secondary" onClick={onRefresh}>
            Scan Resources
          </button>
        </div>
      ) : (
        <div>
          <div className="resource-grid">
            {paginated.map((p) => {
              const result = testResults[p.key];

              return (
                <div key={p.key} className="resource-card">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div
                        style={{
                          width: '30px',
                          height: '30px',
                          borderRadius: 'var(--radius-md)',
                          background: 'rgba(34, 197, 94, 0.1)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: 'var(--mint)',
                          border: '1px solid rgba(34, 197, 94, 0.2)',
                        }}
                      >
                        <Globe size={16} />
                      </div>
                      <div>
                        <div className="mono" style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-main)' }}>
                          {p.host}:{p.port}
                        </div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          {p.username ? `Auth: ${p.username}` : 'Direct'}
                        </div>
                      </div>
                    </div>

                    {p.isAssigned ? (
                      <span className="badge badge-assigned" title={p.assignedTo || ''}>
                        <span className="badge-dot" />
                        Bound
                      </span>
                    ) : (
                      <span className="badge badge-available">
                        <span className="badge-dot" />
                        Free
                      </span>
                    )}
                  </div>

                  <div
                    style={{
                      background: 'rgba(0,0,0,0.2)',
                      padding: '10px 12px',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: '12px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '4px',
                      border: '1px solid var(--border-subtle)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--text-muted)' }}>IP:</span>
                      <strong className="mono" style={{ color: result?.ip ? 'var(--mint)' : 'var(--text-dim)' }}>
                        {result?.ip || 'Untested'}
                      </strong>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--text-muted)' }}>Latency:</span>
                      <strong style={{ color: result?.latency ? 'var(--mint)' : 'var(--text-dim)' }}>
                        {result?.latency ? `${result.latency} ms` : '—'}
                      </strong>
                    </div>

                    {result?.error && (
                      <div style={{ color: 'var(--rose)', fontSize: '11px', marginTop: '2px' }}>
                        Error: {result.error}
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'auto', paddingTop: '4px' }}>
                    <button
                      className="btn btn-secondary btn-sm"
                      style={{ padding: '3px 8px', fontSize: '11px' }}
                      onClick={() => copyToClipboard(p.url, p.key)}
                      title="Copy full proxy URL"
                    >
                      {copiedKey === p.key ? <Check size={11} color="var(--mint)" /> : <Copy size={11} />}
                      {copiedKey === p.key ? 'Copied' : 'Copy'}
                    </button>

                    <button
                      className="btn btn-secondary btn-sm"
                      style={{ padding: '3px 10px', fontSize: '11px' }}
                      onClick={() => testOne(p)}
                      disabled={result?.status === 'testing'}
                    >
                      {result?.status === 'testing' ? (
                        <>
                          <Loader2 size={11} className="spin" />
                          Testing
                        </>
                      ) : (
                        'Ping Test'
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Clean Pagination Bar */}
          <div className="pagination-container" style={{ marginTop: '16px', borderRadius: 'var(--radius-md)' }}>
            <div>
              Showing <strong style={{ color: 'var(--text-main)' }}>{filtered.length ? startIndex + 1 : 0}</strong> to{' '}
              <strong style={{ color: 'var(--text-main)' }}>{Math.min(startIndex + pageSize, filtered.length)}</strong> of{' '}
              <strong style={{ color: 'var(--text-main)' }}>{filtered.length}</strong> proxies
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
      )}
    </div>
  );
};
