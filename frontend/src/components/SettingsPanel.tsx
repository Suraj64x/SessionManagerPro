import React from 'react';
import {
  Database,
  Download,
  Flame,
  Folder,
  FolderSync,
  Globe,
  Keyboard,
  LayoutTemplate,
  Palette,
  Power,
  RefreshCw,
  Rocket,
  ShieldCheck,
  SlidersHorizontal,
  Tag,
  Terminal,
} from 'lucide-react';
import type { Theme } from '../types';
import { ACCENTS } from '../types';
import { api, downloadJson, type AppSettings } from '../api';
import { Toolbar, useUI } from '../ui';
import { ShortcutList } from './ShortcutHelper';
import { listSlot } from '../contributions';

/** One icon per section, and the order they read best in. A section with neither still works. */
const SECTION_ICON: Record<string, React.FC<{ size?: number }>> = {
  app: SlidersHorizontal,
  look: Palette,
  engine: Rocket,
  browsers: Globe,
  statuses: Tag,
  folders: Folder,
  templates: LayoutTemplate,
  'warmup-sets': Flame,
  'check-pages': ShieldCheck,
  browser: Globe,
  data: Database,
  keys: Keyboard,
};
const SECTION_ORDER = ['engine', 'browsers', 'statuses', 'folders', 'templates', 'warmup-sets', 'browser', 'check-pages'];
const rank = (id: string) => {
  const i = SECTION_ORDER.indexOf(id);
  return i < 0 ? SECTION_ORDER.length : i;
};

/** A settings card: an icon and title over a hairline, then whatever the section renders. */
const Section: React.FC<{ id: string; title: string; children: React.ReactNode }> = ({ id, title, children }) => {
  const Icon = SECTION_ICON[id];
  return (
    <section className="section" data-id={id} aria-labelledby={`s-${id}`}>
      <h2 id={`s-${id}`}>
        {Icon && <Icon size={14} />}
        {title}
      </h2>
      {children}
    </section>
  );
};

export const SettingsPanel: React.FC<{
  theme: Theme;
  onTheme: (t: Theme) => void;
  accent: string;
  onAccent: (id: string) => void;
  app: AppSettings | null;
  onApp: (patch: Partial<AppSettings>) => void;
  onQuit: () => void;
  onRefresh: () => void;
  onSync: () => void;
  isSyncing: boolean;
}> = ({ theme, onTheme, accent, onAccent, app, onApp, onQuit, onRefresh, onSync, isSyncing }) => {
  const { toast } = useUI();

  const exportAll = async () => {
    try {
      const sessions = await api.getSessions();
      // Proxy passwords stay out of an export that is easy to share by accident.
      const safe = sessions.map(({ proxy, ...s }) => ({ ...s, proxy: proxy ? { host: proxy.host, port: proxy.port } : null }));
      downloadJson(`profiles-${new Date().toISOString().slice(0, 10)}.json`, safe);
    } catch (err: any) {
      toast('error', err.message);
    }
  };

  return (
    <>
      <Toolbar title="Settings" />
      <div className="view">
        <div className="settings">
          <Section id="app" title="App">
            <div className="setting">
              <div>
                <div className="row-label">When I close the window</div>
                <div className="hint">
                  {app?.closeBehavior === 'tray'
                    ? 'The app stays in the tray and profiles keep running. Open it again from the tray icon or the app shortcut.'
                    : 'The app quits. If profiles are running, it asks first: keep them running in the tray, stop them and quit, or cancel.'}
                </div>
              </div>
              <div className="seg" role="group" aria-label="When I close the window">
                <button aria-pressed={app?.closeBehavior !== 'tray'} onClick={() => onApp({ closeBehavior: 'quit' })}>
                  Quit app
                </button>
                <button aria-pressed={app?.closeBehavior === 'tray'} onClick={() => onApp({ closeBehavior: 'tray' })}>
                  Keep in tray
                </button>
              </div>
            </div>
            <div className="setting">
              <div>
                <div className="row-label">Quit SessionManagerPro</div>
                <div className="hint">Closes every browser (cookies are saved first) and exits.</div>
              </div>
              <button className="btn danger" onClick={onQuit}>
                <Power size={14} /> Quit
              </button>
            </div>
          </Section>

          <Section id="look" title="Appearance">
            <div className="setting">
              <span className="row-label">Theme</span>
              <div className="seg" role="group" aria-label="Theme">
                {(['dark', 'light', 'system'] as Theme[]).map((t) => (
                  <button key={t} aria-pressed={theme === t} onClick={() => onTheme(t)}>
                    {t[0].toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <div className="setting">
              <span className="row-label">Accent</span>
              <div className="accents" role="group" aria-label="Accent colour">
                {ACCENTS.map((a) => (
                  <button
                    key={a.id}
                    className="accent-swatch"
                    style={{ background: a.color }}
                    aria-pressed={accent === a.id}
                    aria-label={a.label}
                    title={a.label}
                    onClick={() => onAccent(a.id)}
                  />
                ))}
              </div>
            </div>
          </Section>

          {/* Everything a feature adds, in a fixed order rather than the order they loaded. */}
          {[...listSlot('settingsSections')].sort((a, b) => rank(a.id) - rank(b.id)).map((s) => (
            <Section key={s.id} id={s.id} title={s.title}>
              {s.render()}
            </Section>
          ))}

          <Section id="data" title="Data">
            <div className="setting">
              <span className="row-label">Rescan proxies and fingerprints from resources/</span>
              <button className="btn" onClick={onRefresh}>
                <RefreshCw size={14} /> Rescan
              </button>
            </div>
            <div className="setting">
              <span className="row-label">Two-way sync with updates/sessions.csv</span>
              <button className="btn" onClick={onSync} disabled={isSyncing}>
                <FolderSync size={14} className={isSyncing ? 'spin' : undefined} /> Sync sheet
              </button>
            </div>
            <div className="setting">
              <span className="row-label">Export every profile as JSON (without proxy passwords)</span>
              <button className="btn" onClick={exportAll}>
                <Download size={14} /> Export
              </button>
            </div>
            <div className="setting">
              <span className="row-label">Open the live log in a separate console window</span>
              <button className="btn" onClick={() => api.openTerminal().catch((e) => toast('error', e.message))}>
                <Terminal size={14} /> Open console
              </button>
            </div>
            <p className="hint">
              The panel only accepts requests from this computer. Automation scripts run with the same access as the app.
            </p>
          </Section>

          <Section id="keys" title="Keyboard">
            <ShortcutList />
          </Section>
        </div>
      </div>
    </>
  );
};
