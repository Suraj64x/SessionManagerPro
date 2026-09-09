import React, { useState, useEffect, useCallback } from 'react';
import { Header } from './components/Header';
import { ThreadCard } from './components/ThreadCard';
import { SessionTable } from './components/SessionTable';
import { ProxyPanel } from './components/ProxyPanel';
import { FingerprintPanel } from './components/FingerprintPanel';
import { ConsoleDrawer } from './components/ConsoleDrawer';
import { NewSessionModal } from './components/NewSessionModal';
import { FingerprintModal } from './components/FingerprintModal';
import { NeonCyberCursor } from './components/NeonCyberCursor';
import { api } from './api';
import type {
  SessionRecord,
  SystemStats,
  PoolStatus,
  ProxyResource,
  FingerprintResource,
  LogEntry,
} from './types';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'sessions' | 'proxies' | 'fingerprints' | 'logs'>('sessions');
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [pool, setPool] = useState<PoolStatus | null>(null);
  const [proxies, setProxies] = useState<ProxyResource[]>([]);
  const [fingerprints, setFingerprints] = useState<FingerprintResource[]>([]);
  const [accounts, setAccounts] = useState<string[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [threadLimit, setThreadLimit] = useState<number>(5);
  const [launchUrl, setLaunchUrl] = useState<string>('');
  const [isLaunching, setIsLaunching] = useState<boolean>(false);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);

  const [isNewModalOpen, setIsNewModalOpen] = useState<boolean>(false);
  const [inspectModal, setInspectModal] = useState<{
    isOpen: boolean;
    title: string;
    data?: any;
  }>({ isOpen: false, title: '' });

  // Initial load
  const loadAll = useCallback(async () => {
    try {
      const [sessionsData, statsData, poolData, resData, logsData] = await Promise.all([
        api.getSessions().catch(() => []),
        api.getStats().catch(() => null),
        api.getPool().catch(() => null),
        api.getResources().catch(() => ({ proxies: [], fingerprints: [], accounts: [] })),
        api.getLogs(60).catch(() => []),
      ]);

      setSessions(sessionsData);
      setStats(statsData);
      if (poolData) {
        setPool(poolData);
        setThreadLimit(poolData.threadLimit || 5);
      }
      setProxies(resData.proxies || []);
      setFingerprints(resData.fingerprints || []);
      setAccounts(resData.accounts || []);
      setLogs(logsData);
    } catch (err) {
      console.error('Failed to load initial data:', err);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // WebSocket for real-time live events and pool sync
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/ws`;

    let ws: WebSocket | null = null;
    let reconnectTimer: any = null;

    const connect = () => {
      try {
        ws = new WebSocket(wsUrl);

        ws.onmessage = (event) => {
          try {
            const { type, data } = JSON.parse(event.data);
            if (type === 'pool') {
              setPool(data);
              // Also refresh sessions to reflect live states
              api.getSessions().then(setSessions).catch(() => {});
            } else if (type === 'log') {
              setLogs((prev) => [...prev.slice(-499), data]);
            } else if (type === 'session') {
              api.getSessions().then(setSessions).catch(() => {});
              api.getStats().then(setStats).catch(() => {});
            }
          } catch (e) {}
        };

        ws.onclose = () => {
          reconnectTimer = setTimeout(connect, 3000);
        };
      } catch (err) {
        reconnectTimer = setTimeout(connect, 3000);
      }
    };

    connect();

    return () => {
      if (ws) ws.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, []);

  // Selection handlers
  const handleToggleSelect = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const handleSelectAll = () => {
    setSelectedIds(sessions.map((s) => s.id));
  };

  const handleClearSelection = () => {
    setSelectedIds([]);
  };

  // Launch handlers
  const handleLaunchOne = async (id: string) => {
    setIsLaunching(true);
    try {
      await api.launchSessions([id], threadLimit, launchUrl);
    } catch (err: any) {
      alert(`Launch error: ${err.message}`);
    } finally {
      setIsLaunching(false);
    }
  };

  const handleLaunchSelected = async () => {
    if (!selectedIds.length) return;
    setIsLaunching(true);
    try {
      await api.launchSessions(selectedIds, threadLimit, launchUrl);
      setSelectedIds([]);
    } catch (err: any) {
      alert(`Launch error: ${err.message}`);
    } finally {
      setIsLaunching(false);
    }
  };

  const handleStopOne = async (id: string) => {
    try {
      await api.stopSession(id);
    } catch (err: any) {
      alert(`Stop error: ${err.message}`);
    }
  };

  const handleStopAll = async () => {
    try {
      await api.stopAllSessions();
    } catch (err: any) {
      alert(`Stop all error: ${err.message}`);
    }
  };

  const handleDeleteOne = async (id: string) => {
    if (!confirm(`Delete profile and cookies for ${id}?`)) return;
    try {
      await api.deleteSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setSelectedIds((prev) => prev.filter((item) => item !== id));
      loadAll();
    } catch (err: any) {
      alert(`Delete error: ${err.message}`);
    }
  };

  // Creation handlers
  const handleCreateSingle = async (name: string, proxy?: string, fingerprintFile?: string) => {
    await api.createSession({ name, proxy, fingerprintFile });
    await loadAll();
  };

  const handleCreateBatch = async (count: number, prefix: string) => {
    await api.autoGenerateSessions(count, prefix);
    await loadAll();
  };

  const handleImportCsv = async (csvText: string) => {
    await api.importAccounts(csvText);
    await loadAll();
  };

  const handleSyncSheet = async () => {
    setIsSyncing(true);
    try {
      const res = await api.syncSheet();
      alert(`Synced with CSV! +${res.created} created, ~${res.updated} updated.`);
      await loadAll();
    } catch (err: any) {
      alert(`Sync error: ${err.message}`);
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <div className="app-container">
      <NeonCyberCursor />
      <Header
        stats={stats}
        pool={pool}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        onRefresh={loadAll}
        onSyncSheet={handleSyncSheet}
        isSyncing={isSyncing}
      />

      <main className="main-content">
        <ThreadCard
          pool={pool}
          threadLimit={threadLimit}
          setThreadLimit={setThreadLimit}
          launchUrl={launchUrl}
          setLaunchUrl={setLaunchUrl}
          onStopAll={handleStopAll}
          onLaunchSelected={handleLaunchSelected}
          selectedCount={selectedIds.length}
          isLaunching={isLaunching}
        />

        {activeTab === 'sessions' && (
          <SessionTable
            sessions={sessions}
            selectedIds={selectedIds}
            onToggleSelect={handleToggleSelect}
            onSelectAll={handleSelectAll}
            onClearSelection={handleClearSelection}
            onLaunchOne={handleLaunchOne}
            onStopOne={handleStopOne}
            onDeleteOne={handleDeleteOne}
            onInspectFingerprint={(s) =>
              setInspectModal({
                isOpen: true,
                title: `Fingerprint Specs: ${s.email || s.id}`,
                data: s.fingerprint,
              })
            }
            onOpenNewModal={() => setIsNewModalOpen(true)}
          />
        )}

        {activeTab === 'proxies' && (
          <ProxyPanel proxies={proxies} onRefresh={loadAll} />
        )}

        {activeTab === 'fingerprints' && (
          <FingerprintPanel
            fingerprints={fingerprints}
            onRefresh={loadAll}
            onSelectInspect={(f) =>
              setInspectModal({
                isOpen: true,
                title: `Fingerprint: ${f.file}`,
                data: f,
              })
            }
          />
        )}

        {activeTab === 'logs' && (
          <ConsoleDrawer logs={logs} onClear={() => setLogs([])} />
        )}

        {/* Live log footer console if on Sessions tab */}
        {activeTab === 'sessions' && (
          <ConsoleDrawer logs={logs} onClear={() => setLogs([])} />
        )}
      </main>

      <NewSessionModal
        isOpen={isNewModalOpen}
        onClose={() => setIsNewModalOpen(false)}
        onCreateSingle={handleCreateSingle}
        onCreateBatch={handleCreateBatch}
        onImportCsv={handleImportCsv}
        availableProxies={proxies}
        availableFingerprints={fingerprints}
      />

      <FingerprintModal
        isOpen={inspectModal.isOpen}
        onClose={() => setInspectModal({ isOpen: false, title: '' })}
        title={inspectModal.title}
        fingerprint={inspectModal.data}
      />
    </div>
  );
};

export default App;
