import React from 'react';
import type { SessionRecord } from './types';
import { contributions as engine } from './features/engine';
import { contributions as home } from './features/home';
import { contributions as proxies } from './features/proxies';
import { contributions as organize } from './features/organize';
import { contributions as templates } from './features/templates';
import { contributions as automation } from './features/automation';
import { contributions as windows } from './features/windows';
import { contributions as history } from './features/history';
import { contributions as apidocs } from './features/apidocs';
import { contributions as importexport } from './features/importexport';
import { contributions as engines } from './features/engines';

/**
 * How a feature adds to views it does not own. Each feature exports one `contributions`
 * object from its index; the views render every feature's part in a fixed order.
 */
export interface RowMenuCtx {
  session: SessionRecord;
  /** Closes the menu; call it before acting. */
  close: () => void;
}
export interface BulkCtx {
  ids: string[];
  sessions: SessionRecord[];
  /** The selected profiles that are running right now. */
  live: SessionRecord[];
  clear: () => void;
}
export interface CreateMenuCtx {
  close: () => void;
}

export interface Contributions {
  /** Extra items in a profile row's "…" menu: plain `<button>`s, the menu styles them. */
  rowMenu?: (ctx: RowMenuCtx) => React.ReactNode;
  /** Extra buttons in the floating bulk-action bar (`className="btn"`). */
  bulkBar?: (ctx: BulkCtx) => React.ReactNode;
  /** Small actions next to a running profile (Home's running list, drawer header). */
  liveActions?: (ctx: { session: SessionRecord }) => React.ReactNode;
  /** Replaces the Profiles header's primary "New" button. Only one feature may provide it. */
  profilesPrimary?: (ctx: { onNew: () => void }) => React.ReactNode;
  /** Items appended to the create menu that `profilesPrimary` renders. */
  createMenu?: (ctx: CreateMenuCtx) => React.ReactNode;
  /** Rendered between the Profiles header and the table (folder strip, banners). */
  profilesAbove?: () => React.ReactNode;
  /** Extra tabs in the profile drawer, after "Profile". */
  drawerTabs?: Array<{ id: string; label: string; render: (session: SessionRecord) => React.ReactNode }>;
  /** Extra sections on the Settings page, in this order, after "Data". */
  settingsSections?: Array<{ id: string; title: string; render: () => React.ReactNode }>;
  /** Extra items in the bottom status bar. */
  statusItems?: () => React.ReactNode;
  /** Extra cards on Home, below Home's own. */
  homeSections?: () => React.ReactNode;
}

const FEATURES: Array<[string, Contributions]> = [
  ['engine', engine],
  ['home', home],
  ['proxies', proxies],
  ['organize', organize],
  ['templates', templates],
  ['automation', automation],
  ['windows', windows],
  ['history', history],
  ['apidocs', apidocs],
  ['importexport', importexport],
  ['engines', engines],
];

type RenderKind = 'rowMenu' | 'bulkBar' | 'liveActions' | 'createMenu' | 'profilesAbove' | 'statusItems' | 'homeSections';
type ListKind = 'drawerTabs' | 'settingsSections';

/** Every feature's output for a render slot, in feature order. */
export function renderSlot<K extends RenderKind>(kind: K, ...args: Parameters<NonNullable<Contributions[K]>>): React.ReactNode {
  return FEATURES.map(([name, c]) => {
    const fn = c[kind] as ((...a: unknown[]) => React.ReactNode) | undefined;
    const out = fn ? fn(...args) : null;
    return out ? <React.Fragment key={name}>{out}</React.Fragment> : null;
  });
}

/** Every feature's entries for a list slot, flattened, in feature order. */
export function listSlot<K extends ListKind>(kind: K): NonNullable<Contributions[K]> {
  const out: unknown[] = [];
  for (const [, c] of FEATURES) out.push(...((c[kind] || []) as unknown[]));
  return out as NonNullable<Contributions[K]>;
}

/** The one feature that provides a single-owner slot, if any. */
export function singleSlot<K extends 'profilesPrimary'>(kind: K): Contributions[K] | undefined {
  return FEATURES.map(([, c]) => c[kind]).find(Boolean);
}
