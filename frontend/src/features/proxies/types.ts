export type Scheme = 'http' | 'https' | 'socks4' | 'socks5';

export interface ProxyCheck {
  ok: boolean;
  ip: string | null;
  country: string | null;
  countryCode: string | null;
  city: string | null;
  timezone: string | null;
  latency: number | null;
  at: string;
  error: string | null;
}

/** A library entry as GET /api/proxies sends it: never the password. */
export interface LibProxy {
  id: string;
  name: string;
  scheme: Scheme;
  host: string;
  port: number;
  username: string;
  hasPassword: boolean;
  changeIpUrl: string;
  notes: string;
  createdAt: string;
  check: ProxyCheck | null;
  isAssigned: boolean;
  /** A profile id, or "<id> (trash)" for a trashed one. */
  assignedTo: string | null;
  /** scheme://user@host:port, without the password. */
  line: string;
}

export interface ParseRow {
  /** The pasted line with its password masked. */
  line: string;
  ok: boolean;
  /** Already in the library, or earlier in the same text. */
  duplicate?: boolean;
  proxy?: Pick<LibProxy, 'scheme' | 'host' | 'port' | 'username' | 'changeIpUrl' | 'name' | 'hasPassword'>;
  error?: string;
}

export interface AddResult {
  added: number;
  duplicates: number;
  errors: Array<{ line: string; error: string }>;
  proxies: LibProxy[];
}

export interface CheckSummary {
  checked: number;
  ok: number;
  failed: number;
  skipped: number;
}

export type AssignSource = 'unused' | 'unused-ok' | 'ids';

/** The value of the `proxy` bulk action. */
export interface AssignValue {
  source: AssignSource;
  ids?: string[];
  order: 'sequential' | 'random';
  checkFirst?: boolean;
  dryRun?: boolean;
}

export interface PlanRow {
  /** Profile id. */
  id: string;
  proxy?: LibProxy;
  error?: string;
}
