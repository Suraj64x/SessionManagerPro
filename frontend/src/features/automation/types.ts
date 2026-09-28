import type { Script, ScriptRun } from '../../types';

/** The Warm-up script's settings, as the run and a schedule carry them. */
export interface WarmupInput {
  sites: string[];
  /** Seconds on each site, [min, max]. */
  dwell: [number, number];
  scroll: boolean;
  /** Same-site links followed per site, 0–3. */
  links: number;
  shuffle: boolean;
}

export interface WarmupSet {
  name: string;
  urls: string[];
}

/** What POST /api/warmup takes. */
export interface WarmupRequest {
  ids: string[];
  urls: string[];
  dwell: [number, number];
  scroll: boolean;
  links: number;
  shuffle: boolean;
  hidden: boolean;
  saveTraffic: boolean;
  stopAfter: boolean;
}

export interface RunOptions {
  launch: boolean;
  stopAfter: boolean;
  headless: boolean;
  saveTraffic: boolean;
  limitMs: number;
  input?: WarmupInput;
}

/** A run as the server sends it; the shared type predates options and schedules. */
export type Run = ScriptRun & { options?: RunOptions; scheduleId?: string | null };

/** The shared Script plus the flag the server sets on the read-only Warm-up. */
export type LibScript = Script & { builtin?: boolean };

export type TargetKind = 'all' | 'tag' | 'status' | 'folder' | 'ids';

export type Rule =
  | { kind: 'every'; minutes: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; days: number[]; time: string }
  | { kind: 'once'; at: string };

export interface ScheduleOptions {
  launch: boolean;
  stopAfter: boolean;
  hidden: boolean;
  skipIfRunning: boolean;
}

export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  script: { scriptId: string } | { builtin: 'warmup'; input: WarmupInput };
  targets: { kind: TargetKind; value: string | string[] | null };
  rule: Rule;
  options: ScheduleOptions;
  lastRun: { at: string; runId: string | null; ok: number; failed: number; done?: boolean; note?: string } | null;
  nextRun: string | null;
}

export type ScheduleDraft = Pick<Schedule, 'name' | 'enabled' | 'script' | 'targets' | 'rule' | 'options'>;
