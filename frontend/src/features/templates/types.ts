import type { SessionRecord } from '../../types';

export type ProxyStrategy = 'unused' | 'unused-ok' | 'specific';
export type FptStrategy = 'unused' | 'specific';

/** data/templates.json entry, as the server publishes it (proxy password shown as `***`). */
export interface Template {
  id: string;
  name: string;
  /** Profile name pattern: `{n}` counter, `{n:03}` zero-padded, `{date}` = YYYY-MM-DD. */
  pattern: string;
  folder: string;
  tags: string[];
  /** Becomes the profile's label. */
  status: string;
  startUrls: string[];
  notes: string;
  proxyStrategy: ProxyStrategy;
  /** Proxy URL, 'specific' only. */
  proxy: string;
  fptStrategy: FptStrategy;
  fingerprintFile: string;
  /** A browser id from GET /api/browsers; "" follows the default in Settings → Browsers. */
  browser: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export type TemplateDraft = Omit<Template, 'id' | 'createdAt' | 'updatedAt'>;

export interface CreateResult {
  created: SessionRecord[];
  skipped: Array<{ name: string; error: string }>;
}
