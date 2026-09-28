import { createContext, useContext, useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { AppSettings, BulkAction } from './api';
import type {
  FingerprintResource,
  LogEntry,
  PoolStatus,
  ProxyResource,
  Script,
  ScriptDraft,
  ScriptRun,
  SessionRecord,
  TrashItem,
} from './types';

export type Tab = 'home' | 'profiles' | 'automation' | 'proxies' | 'fingerprints' | 'api' | 'settings';

/**
 * Everything the panel knows, shared with every view and feature. State is loaded once in
 * App and kept fresh by the WebSocket; features never fetch what is already here.
 */
export interface AppState {
  tab: Tab;
  setTab: (tab: Tab) => void;

  sessions: SessionRecord[];
  trash: TrashItem[];
  pool: PoolStatus | null;
  proxies: ProxyResource[];
  fingerprints: FingerprintResource[];
  scripts: Script[];
  runs: ScriptRun[];
  logs: LogEntry[];
  app: AppSettings | null;
  connected: boolean;

  selectedIds: string[];
  setSelectedIds: Dispatch<SetStateAction<string[]>>;
  /** Profile open in the drawer. `openProfile(null)` closes it; resolves false if the user kept unsaved edits. */
  openId: string | null;
  openProfile: (id: string | null) => Promise<boolean>;
  /** Opens the New profile dialog. */
  openNew: () => void;

  refresh: {
    all: () => Promise<void>;
    sessions: () => Promise<void>;
    trash: () => Promise<void>;
    scripts: () => Promise<void>;
    resources: () => Promise<void>;
    app: () => Promise<void>;
  };

  launch: (ids: string[]) => Promise<void>;
  stop: (id: string) => Promise<void>;
  stopAll: () => Promise<void>;
  bulk: (ids: string[], action: BulkAction, value?: unknown) => Promise<void>;
  runScript: (target: { scriptId: string } | { draft: ScriptDraft }, ids: string[]) => Promise<ScriptRun | null>;
  changeApp: (patch: Partial<AppSettings>) => Promise<void>;

  /** Subscribes to a WebSocket message type (`proxy`, `schedule`, …). Returns the unsubscribe. */
  onEvent: (type: string, handler: (data: any) => void) => () => void;
}

export const AppCtx = createContext<AppState | null>(null);

export const useApp = (): AppState => {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error('useApp must be used inside <App>');
  return ctx;
};

/** Runs `handler` for every WebSocket message of `type`. The handler may change freely. */
export function useEvent(type: string, handler: (data: any) => void) {
  const { onEvent } = useApp();
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => onEvent(type, (d) => ref.current(d)), [type, onEvent]);
}
