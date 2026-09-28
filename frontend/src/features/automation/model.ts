import { useApp } from '../../app-context';
import type { WarmupSet } from './types';

export const MAX_SITES = 50;
export const MAX_SETS = 20;
export const DWELL_MIN = 5;
export const DWELL_MAX = 300;

/** One site per line (spaces and commas also split); blank lines dropped. */
export const parseSites = (text: string) => text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

export const useWarmupSets = (): WarmupSet[] => {
  const { app } = useApp();
  return Array.isArray(app?.warmupSets) ? (app.warmupSets as WarmupSet[]) : [];
};

/** Dwell range: two whole numbers of seconds. Returns the error text, or null. */
export const dwellError = (min: number, max: number) =>
  !Number.isInteger(min) || !Number.isInteger(max) || min < DWELL_MIN || max > DWELL_MAX
    ? `Use ${DWELL_MIN}–${DWELL_MAX} seconds`
    : min > max
      ? 'The first number is the shortest stay'
      : null;
