import React, { useState } from 'react';
import { ChevronDown, FolderOpen, Loader2, Pencil, Play, Plus, Save, Trash2 } from 'lucide-react';
import { useApp } from '../../app-context';
import { api as core } from '../../api';
import { Empty, Menu, Modal, Stepper, useStored, useUI } from '../../ui';
import { api } from './api';
import { DWELL_MAX, DWELL_MIN, MAX_SETS, MAX_SITES, dwellError, parseSites, useWarmupSets } from './model';
import type { Run, WarmupSet } from './types';

/** Saves the whole list; the server validates every URL and answers with the reason. */
async function saveSets(sets: WarmupSet[], toast: ReturnType<typeof useUI>['toast']) {
  try {
    await core.patchApp({ warmupSets: sets });
    return true;
  } catch (err: any) {
    toast('error', err.message);
    return false;
  }
}

const Switch: React.FC<{ checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode; title?: string }> = ({
  checked,
  onChange,
  children,
  title,
}) => (
  <label className="switch" title={title}>
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    {children}
  </label>
);

export const DwellInputs: React.FC<{ value: [number, number]; onChange: (v: [number, number]) => void; id: string }> = ({
  value,
  onChange,
  id,
}) => (
  <div className="inline aut-dwell">
    <input
      id={id}
      className="input num"
      type="number"
      min={DWELL_MIN}
      max={DWELL_MAX}
      value={Number.isNaN(value[0]) ? '' : value[0]}
      onChange={(e) => onChange([e.target.valueAsNumber, value[1]])}
      aria-label="Shortest stay, seconds"
    />
    <span className="dim">to</span>
    <input
      className="input num"
      type="number"
      min={DWELL_MIN}
      max={DWELL_MAX}
      value={Number.isNaN(value[1]) ? '' : value[1]}
      onChange={(e) => onChange([value[0], e.target.valueAsNumber])}
      aria-label="Longest stay, seconds"
    />
    <span className="dim">s</span>
  </div>
);

type Prefs = { dwell: [number, number]; scroll: boolean; links: number; shuffle: boolean; hidden: boolean; stopAfter: boolean };
const DEFAULTS: Prefs = { dwell: [20, 60], scroll: true, links: 1, shuffle: true, hidden: true, stopAfter: true };

export const WarmupDialog: React.FC<{ ids: string[]; onClose: () => void; onStarted: (run: Run) => void }> = ({
  ids,
  onClose,
  onStarted,
}) => {
  const { app, sessions } = useApp();
  const { toast, confirm } = useUI();
  const sets = useWarmupSets();
  const [sitesText, setSitesText] = useState(() => (sets[0]?.urls || []).join('\n'));
  // The last choices are remembered; the sites come from the first set every time.
  const [prefs, setPrefs] = useStored<Prefs>('automation.warmup', DEFAULTS);
  const p = { ...DEFAULTS, ...prefs };
  const set = (patch: Partial<Prefs>) => setPrefs({ ...p, ...patch });
  const [saveTraffic, setSaveTraffic] = useState(Boolean(app?.trafficSaver));
  const [setName, setSetName] = useState('');
  const [busy, setBusy] = useState(false);

  const sites = parseSites(sitesText);
  const live = sessions.filter((s) => ids.includes(s.id) && s.status === 'live').length;
  const dErr = dwellError(p.dwell[0], p.dwell[1]);
  const error = !sites.length ? 'Add at least one site' : sites.length > MAX_SITES ? `At most ${MAX_SITES} sites` : dErr;
  const minutes = Math.max(1, Math.round((sites.length * (p.dwell[0] + p.dwell[1])) / 2 / 60));

  const saveAs = async (close: () => void) => {
    const name = setName.trim().slice(0, 40);
    if (!name || !sites.length) return;
    const exists = sets.some((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!exists && sets.length >= MAX_SETS) return toast('error', `At most ${MAX_SETS} sets`);
    close();
    if (exists && !(await confirm({ title: `Replace “${name}”?`, body: `Its sites become these ${sites.length}.`, confirmLabel: 'Replace' }))) return;
    const next = exists
      ? sets.map((s) => (s.name.toLowerCase() === name.toLowerCase() ? { name: s.name, urls: sites } : s))
      : [...sets, { name, urls: sites }];
    if (await saveSets(next, toast)) {
      toast('success', `Saved “${name}”`);
      setSetName('');
    }
  };

  const start = async () => {
    if (error || busy) return;
    setBusy(true);
    try {
      const run = await api.warmup({
        ids,
        urls: sites,
        dwell: p.dwell,
        scroll: p.scroll,
        links: p.links,
        shuffle: p.shuffle,
        hidden: p.hidden,
        saveTraffic,
        stopAfter: p.stopAfter,
      });
      toast('info', `Warming up ${ids.length} profile${ids.length > 1 ? 's' : ''}`);
      onStarted(run);
    } catch (err: any) {
      toast('error', err.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Warm-up"
      width={560}
      onClose={() => !busy && onClose()}
      footer={
        <>
          <span className="hint grow aut-foot">{error || `About ${minutes} min per profile`}</span>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={start} disabled={busy || !!error}>
            {busy ? <Loader2 size={13} className="spin" /> : <Play size={12} />} Start
          </button>
        </>
      }
    >
      <p className="hint">
        {ids.length} profile{ids.length > 1 ? 's' : ''}
        {live ? ` · ${live} already running` : ''}. Profiles that aren’t running open for the run.
      </p>

      <div className="row">
        <div className="inline">
          <label htmlFor="wu-sites" className="row-label grow">
            Sites <span className="dim">· {sites.length}</span>
          </label>
          <Menu
            trigger={(t) => (
              <button className="btn xs ghost" {...t}>
                <FolderOpen size={12} /> Load set <ChevronDown size={12} />
              </button>
            )}
          >
            {(close) =>
              sets.length ? (
                sets.map((s) => (
                  <button key={s.name} onClick={() => (close(), setSitesText(s.urls.join('\n')))}>
                    <span className="grow">{s.name}</span>
                    <span className="dim">{s.urls.length}</span>
                  </button>
                ))
              ) : (
                <div className="menu-head">No saved sets</div>
              )
            }
          </Menu>
          <Menu
            trigger={(t) => (
              <button className="btn xs ghost" {...t} disabled={!sites.length}>
                <Save size={12} /> Save set…
              </button>
            )}
          >
            {(close) => (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  saveAs(close);
                }}
              >
                <input
                  className="input"
                  autoFocus
                  placeholder="Set name"
                  maxLength={40}
                  value={setName}
                  onChange={(e) => setSetName(e.target.value)}
                  aria-label="Set name"
                />
                <button type="submit" disabled={!setName.trim()}>
                  <Save size={12} /> Save {sites.length} site{sites.length === 1 ? '' : 's'}
                </button>
              </form>
            )}
          </Menu>
        </div>
        <textarea
          id="wu-sites"
          className="input mono aut-sites"
          rows={7}
          spellCheck={false}
          value={sitesText}
          onChange={(e) => setSitesText(e.target.value)}
          placeholder={'google.com\nen.wikipedia.org'}
        />
        <span className="hint">One per line. Each profile visits them, scrolls and follows a few links.</span>
      </div>

      <div className="aut-grid">
        <div className="row">
          <label htmlFor="wu-dwell">Time on each site</label>
          <DwellInputs id="wu-dwell" value={p.dwell} onChange={(dwell) => set({ dwell })} />
        </div>
        <div className="row aut-row">
          <span className="row-label">Follow links per site</span>
          <Stepper value={p.links} min={0} max={3} label="Links per site" onStep={(d) => set({ links: Math.min(3, Math.max(0, p.links + d)) })} />
        </div>
      </div>

      <div className="aut-grid">
        <Switch checked={p.scroll} onChange={(scroll) => set({ scroll })}>
          Scroll
        </Switch>
        <Switch checked={p.shuffle} onChange={(shuffle) => set({ shuffle })}>
          Shuffle order
        </Switch>
        <Switch checked={p.hidden} onChange={(hidden) => set({ hidden })} title="Only for profiles this run opens">
          Hidden window
        </Switch>
        <Switch checked={saveTraffic} onChange={setSaveTraffic} title="Skips images and autoplay in windows this run opens">
          Save traffic
        </Switch>
        <Switch checked={p.stopAfter} onChange={(stopAfter) => set({ stopAfter })}>
          Stop profile when done
        </Switch>
      </div>
    </Modal>
  );
};

/* ---------------- Settings: Warm-up site sets ---------------- */

const SetEditor: React.FC<{ set: WarmupSet | null; taken: string[]; onClose: () => void; onSave: (s: WarmupSet) => Promise<boolean> }> = ({
  set,
  taken,
  onClose,
  onSave,
}) => {
  const [name, setName] = useState(set?.name || '');
  const [text, setText] = useState((set?.urls || []).join('\n'));
  const [busy, setBusy] = useState(false);
  const urls = parseSites(text);
  const clash = taken.some((t) => t.toLowerCase() === name.trim().toLowerCase());
  const error = !name.trim()
    ? 'Give the set a name'
    : clash
      ? 'Another set has that name'
      : !urls.length
        ? 'Add at least one site'
        : urls.length > MAX_SITES
          ? `At most ${MAX_SITES} sites`
          : null;
  const save = async () => {
    if (error) return;
    setBusy(true);
    if (await onSave({ name: name.trim(), urls })) onClose();
    else setBusy(false);
  };
  return (
    <Modal
      title={set ? 'Edit site set' : 'New site set'}
      width={520}
      onClose={() => !busy && onClose()}
      footer={
        <>
          <span className="hint grow aut-foot">{error || `${urls.length} site${urls.length === 1 ? '' : 's'}`}</span>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy || !!error}>
            {busy && <Loader2 size={13} className="spin" />} Save
          </button>
        </>
      }
    >
      <div className="row">
        <label htmlFor="ws-name">Name</label>
        <input id="ws-name" className="input" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="row">
        <label htmlFor="ws-urls">Sites, one per line</label>
        <textarea id="ws-urls" className="input mono aut-sites" rows={9} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
      </div>
    </Modal>
  );
};

export const WarmupSetsSection: React.FC = () => {
  const { app } = useApp();
  const { toast, confirm } = useUI();
  const sets = useWarmupSets();
  const [editing, setEditing] = useState<WarmupSet | 'new' | null>(null);

  const remove = async (s: WarmupSet) => {
    const ok = await confirm({ title: `Delete “${s.name}”?`, body: `Its ${s.urls.length} sites are removed. Schedules keep their own copy.`, confirmLabel: 'Delete', danger: true });
    if (ok && (await saveSets(sets.filter((x) => x !== s), toast))) toast('success', 'Deleted');
  };

  const current = editing === 'new' ? null : editing;
  return (
    <>
      <p className="hint">The sites a warm-up visits. The first set fills the Warm-up dialog.</p>
      {!app ? (
        <p className="hint">Loading…</p>
      ) : !sets.length ? (
        <Empty
          icon={<FolderOpen size={22} />}
          text="No site sets"
          action={
            <button className="btn" onClick={() => setEditing('new')}>
              <Plus size={13} /> New set
            </button>
          }
        />
      ) : (
        <>
          {sets.map((s) => (
            <div key={s.name} className="setting">
              <div style={{ minWidth: 0 }}>
                <div className="row-label">{s.name}</div>
                <div className="hint aut-ellipsis" title={s.urls.join('\n')}>
                  {s.urls.length} site{s.urls.length === 1 ? '' : 's'} · {s.urls.map((u) => u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')).join(', ')}
                </div>
              </div>
              <div className="inline">
                <button className="icon-btn" onClick={() => setEditing(s)} aria-label={`Edit ${s.name}`} title="Edit">
                  <Pencil size={14} />
                </button>
                <button className="icon-btn danger" onClick={() => remove(s)} aria-label={`Delete ${s.name}`} title="Delete">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
          <div>
            <button className="btn" onClick={() => setEditing('new')} disabled={sets.length >= MAX_SETS} title={sets.length >= MAX_SETS ? `At most ${MAX_SETS} sets` : undefined}>
              <Plus size={13} /> New set
            </button>
          </div>
        </>
      )}
      {editing && (
        <SetEditor
          set={current}
          taken={sets.filter((s) => s !== current).map((s) => s.name)}
          onClose={() => setEditing(null)}
          onSave={async (s) => {
            const next = current ? sets.map((x) => (x === current ? s : x)) : [...sets, s];
            const ok = await saveSets(next, toast);
            if (ok) toast('success', `Saved “${s.name}”`);
            return ok;
          }}
        />
      )}
    </>
  );
};
