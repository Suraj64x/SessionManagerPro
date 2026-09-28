/** One line of data/history/<id>.jsonl. Details depend on `type`. */
export interface HistoryEvent {
  at: string;
  type: string;
  headless?: boolean;
  exitIp?: string;
  country?: string;
  status?: string;
  reason?: string;
  durationMs?: number;
  closedByUser?: boolean;
  count?: number;
  total?: number;
  applied?: string;
  from?: string;
  to?: string;
  via?: string;
  script?: string;
  ms?: number;
  message?: string;
}

export interface HistoryStats {
  launchCount: number;
  workSeconds: number;
  lastExitIp: string | null;
  lastCountry: string | null;
  createdAt?: string;
}

export interface HistoryResponse {
  events: HistoryEvent[];
  stats: HistoryStats;
}

export interface Snapshot {
  file: string;
  at: string;
  count: number;
  bytes: number;
}
