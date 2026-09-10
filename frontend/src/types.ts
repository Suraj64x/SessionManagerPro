export interface ProxyConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface FingerprintSpec {
  file: string;
  format?: string;
  userAgent: string;
  chromeVersion: string;
  platform: string;
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
  };
  timezone: string;
  locale: string;
  languages?: string[];
  webgl: {
    vendor: string;
    renderer: string;
  };
  hardwareConcurrency: number;
  deviceMemory: number;
  maxTouchPoints?: number;
}

export interface SessionRecord {
  id: string;
  email: string;
  proxy?: ProxyConfig;
  fingerprintFile?: string;
  fingerprint?: FingerprintSpec;
  userDataDir: string;
  tabs: string[];
  cookieCount: number;
  notes?: string;
  tags?: string[];
  color?: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
  status: 'ready' | 'live' | 'queued' | 'error' | 'completed';
  lastResult?: {
    status: string;
    reason: string;
    at: string;
  };
  liveInfo?: {
    id: string;
    startedAt: string;
    url: string;
  } | null;
}

export interface ProxyResource {
  key: string;
  host: string;
  port: number;
  username: string;
  isAssigned: boolean;
  assignedTo: string | null;
  url: string;
  latency?: number;
  testStatus?: 'untested' | 'testing' | 'success' | 'failed';
  testedIp?: string;
  testError?: string;
}

export interface FingerprintResource {
  file: string;
  shortId?: string;
  country?: string;
  browserName?: string;
  format: string;
  userAgent: string;
  chromeVersion: string;
  platform: string;
  viewport: string;
  webglVendor: string;
  webglRenderer: string;
  hardwareConcurrency: number;
  deviceMemory: number;
  lang: string;
  isAssigned: boolean;
  assignedTo: string | null;
  error?: string;
}

export interface LogEntry {
  id: number;
  timestamp: string;
  level: 'info' | 'success' | 'warn' | 'error';
  category: 'SESSION' | 'PROXY' | 'FINGERPRINT' | 'BROWSER' | 'QUEUE' | 'COOKIE';
  message: string;
  sessionId?: string | null;
}

export interface SystemStats {
  sessionsTotal: number;
  proxiesTotal: number;
  proxiesFree: number;
  fingerprintsTotal: number;
  fingerprintsFree: number;
  accountsTotal: number;
  totalCookies: number;
  activeThreads: number;
  threadLimit: number;
  queuedCount: number;
}

export interface PoolStatus {
  live: Array<{
    id: string;
    startedAt: string;
    url: string;
    proxy?: ProxyConfig;
    fingerprintFile?: string;
  }>;
  queued: string[];
  threadLimit: number;
  defaultUrl: string;
  activeCount: number;
  queuedCount: number;
  isFilling?: boolean;
}
