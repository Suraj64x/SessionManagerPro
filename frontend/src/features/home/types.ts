import type { LogEntry, ScriptMode } from '../../types';

export interface HomeRun {
  id: string;
  scriptName: string;
  mode: ScriptMode;
  startedAt: string;
  cancelled: boolean;
  targets: number;
  ok: number;
  error: number;
  stopped: number;
  /** Pending or running targets. */
  pending: number;
  /** Wall time to the last result; null while a target is still going or when no result carries timing. */
  ms: number | null;
}

export interface HomeSummary {
  profiles: { total: number; live: number; queued: number; errors: number; trash: number };
  proxies: { total: number; assigned: number; ok: number; failed: number; unchecked: number };
  fingerprints: { total: number; free: number };
  /** Newest first, at most 8. */
  recentRuns: HomeRun[];
  /** Chronological: the last 10 warn/error lines of the server log. */
  problems: LogEntry[];
}
