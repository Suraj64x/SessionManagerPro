export interface ProxyConfig {
  scheme?: string;
  host: string;
  port: number;
  username?: string;
  /** The server never sends the password, only whether there is one. */
  hasPassword?: boolean;
}

export interface FingerprintSpec {
  file: string;
  format?: string;
  userAgent: string;
  chromeVersion: string;
  platform: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  timezone: string;
  locale: string;
  languages?: string[];
  webgl: { vendor: string; renderer: string };
  hardwareConcurrency: number;
  deviceMemory: number;
  maxTouchPoints?: number;
}

export type RunState = 'ready' | 'live' | 'queued' | 'error' | 'completed';

export interface SessionRecord {
  id: string;
  email: string;
  proxy?: ProxyConfig;
  fingerprintFile?: string;
  fingerprint?: FingerprintSpec;
  userDataDir: string;
  tabs: string[];
  startUrls?: string[];
  cookieCount: number;
  notes?: string;
  tags?: string[];
  /** Operator-defined workflow status, e.g. "warming", "active", "banned". */
  label?: string;
  color?: string;
  /** At most one folder per profile; '' or missing = no folder. */
  folder?: string;
  /** Pinned rows sort to the top. */
  pinned?: boolean;
  /** Browser engine id (GET /api/browsers); missing = Stealth Firefox. */
  browser?: string;
  /** Geolocation API: blocked (default) or spoofed to the proxy's location. */
  geolocation?: 'block' | 'spoof';
  /** 'masked' (default): sites see the proxy's IP, no STUN request leaves this computer. 'off': no WebRTC outside the proxy at all. */
  webrtc?: 'masked' | 'off';
  /** Last leak check: verdict and the rows that failed. */
  leakCheck?: { at: string; verdict: 'clean' | 'check' | 'leak'; failed: string[] };
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
  /* Usage counters kept by the orchestrator. */
  launchCount?: number;
  workSeconds?: number;
  lastExitIp?: string;
  lastCountry?: string;
  status: RunState;
  lastResult?: { status: string; reason: string; at: string };
  /** `slot`: the thread number, also on Stealth Firefox's taskbar icon. */
  liveInfo?: { id: string; startedAt: string; url: string; headless?: boolean; exitIp?: string; slot?: number } | null;
}

export interface TrashItem {
  id: string;
  email: string;
  notes: string;
  tags: string[];
  label: string;
  cookieCount: number;
  proxy: { host: string; port: number } | null;
  fingerprintFile?: string;
  deletedAt: string;
  purgeAt: string;
}

export interface ProxyResource {
  key: string;
  host: string;
  port: number;
  username: string;
  isAssigned: boolean;
  assignedTo: string | null;
  url: string;
}

export interface ProxyProbe {
  status: 'testing' | 'ok' | 'fail';
  latency?: number;
  ip?: string | null;
  country?: string;
  countryCode?: string;
  city?: string;
  timezone?: string;
  isp?: string;
  error?: string;
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

export type LogCategory = 'SESSION' | 'PROXY' | 'FINGERPRINT' | 'BROWSER' | 'QUEUE' | 'COOKIE' | 'SCRIPT';

export interface LogEntry {
  id: number;
  timestamp: string;
  level: 'info' | 'success' | 'warn' | 'error';
  category: LogCategory;
  message: string;
  sessionId?: string | null;
}

export interface PoolStatus {
  live: Array<{ id: string; startedAt: string; url: string; headless?: boolean; exitIp?: string; slot?: number }>;
  queued: string[];
  threadLimit: number;
  defaultUrl: string;
  activeCount: number;
  queuedCount: number;
  isFilling?: boolean;
}

/* ---------------- scripts ---------------- */

export type ScriptMode = 'page' | 'automation';

export interface Script {
  id: string;
  name: string;
  mode: ScriptMode;
  code: string;
  /** Page scripts only: injected into every page at launch. */
  autoRun: boolean;
  /** URL glob for auto-run, e.g. *://*.example.com/*. Empty = every page. */
  match: string;
  /** Auto-run only on profiles carrying one of these tags. Empty = all profiles. */
  tags: string[];
  /** The read-only built-in Warm-up. */
  builtin?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ScriptDraft = Pick<Script, 'name' | 'mode' | 'code' | 'autoRun' | 'match' | 'tags'>;

export type RunResultState = 'pending' | 'running' | 'ok' | 'error' | 'stopped';

export interface RunResult {
  state: RunResultState;
  value?: string | null;
  error?: string;
  ms?: number;
  logs?: string[];
  startedAt?: string;
}

export interface ScriptRun {
  id: string;
  scriptId: string | null;
  scriptName: string;
  mode: ScriptMode;
  startedAt: string;
  cancelled: boolean;
  /** Set when a schedule started the run. */
  scheduleId?: string | null;
  results: Record<string, RunResult>;
}

/* ---------------- appearance ---------------- */

export type Theme = 'dark' | 'light' | 'system';

export interface AccentOption {
  id: string;
  label: string;
  color: string;
  /** Text colour on a solid accent fill; picked per colour for contrast. */
  ink: string;
}

export const ACCENTS: AccentOption[] = [
  { id: 'emerald', label: 'Emerald', color: '#34d399', ink: '#04150d' },
  // Deep enough that white text on a primary button clears 4.5:1.
  { id: 'blue', label: 'Blue', color: '#2563eb', ink: '#ffffff' },
  { id: 'violet', label: 'Violet', color: '#7c3aed', ink: '#ffffff' },
  { id: 'amber', label: 'Amber', color: '#f5b544', ink: '#1f1400' },
  { id: 'rose', label: 'Rose', color: '#e11d48', ink: '#ffffff' },
  { id: 'cyan', label: 'Cyan', color: '#22d3ee', ink: '#03171b' },
  { id: 'slate', label: 'Slate', color: '#94a3b8', ink: '#0b0f14' },
];

/** Profile colour swatches. */
export const SWATCHES = ['#34d399', '#3b82f6', '#8b5cf6', '#f5b544', '#f43f5e', '#22d3ee', '#f97316', '#a3a3a3'];
