import React, { useMemo, useState } from 'react';
import { CalendarClock, Info, Loader2, Pencil, Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useApp } from '../../app-context';
import type { SessionRecord } from '../../types';
import { Empty, Modal, Picker, Stepper, ago, useUI } from '../../ui';
import { api } from './api';
import type { LibScript, Rule, Schedule, ScheduleDraft, ScheduleOptions, TargetKind, WarmupInput } from './types';
import { DwellInputs } from './warmup';
import { dwellError, useWarmupSets } from './model';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Monday first, the way most calendars here read.
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const WARMUP = 'builtin:warmup';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
/** ISO → the value a datetime-local input takes, in local time. */
const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${hhmm(d)}`;
};

/** "Today 14:00", "Tomorrow 09:00", "Mon 6 Oct 09:00". */
const when = (iso: string) => {
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(new Date())) / 86_400_000);
  if (diff === 0) return `Today ${hhmm(d)}`;
  if (diff === 1) return `Tomorrow ${hhmm(d)}`;
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${hhmm(d)}`;
};

const ruleText = (r: Rule) => {
  if (r.kind === 'every') {
    const m = r.minutes;
    return m % 1440 === 0 ? (m === 1440 ? 'Every day' : `Every ${m / 1440} days`) : m % 60 === 0 ? `Every ${m / 60} h` : `Every ${m} min`;
  }
  if (r.kind === 'daily') return `Daily at ${r.time}`;
  if (r.kind === 'weekly') return `${r.days.length === 7 ? 'Every day' : WEEK.filter((d) => r.days.includes(d)).map((d) => DAYS[d]).join(', ')} at ${r.time}`;
  return `Once, ${when(r.at)}`;
};

const targetText = (t: Schedule['targets']) => {
  if (t.kind === 'all') return 'All profiles';
  if (t.kind === 'ids') {
    const n = Array.isArray(t.value) ? t.value.length : 0;
    return `${n} profile${n === 1 ? '' : 's'}`;
  }
  return `${t.kind[0].toUpperCase() + t.kind.slice(1)}: ${t.value}`;
};

/** Same matching as the server's resolveTargets, for the "matches N now" hint. */
const matches = (sessions: SessionRecord[], kind: TargetKind, value: string | string[] | null) => {
  const lc = (v?: string | null) => String(v || '').toLowerCase();
  if (kind === 'all') return sessions.length;
  if (kind === 'ids') return sessions.filter((s) => Array.isArray(value) && value.includes(s.id)).length;
  if (kind === 'tag') return sessions.filter((s) => (s.tags || []).includes(lc(value as string))).length;
  if (kind === 'status') return sessions.filter((s) => lc(s.label) === lc(value as string)).length;
  return sessions.filter((s) => lc(s.folder) === lc(value as string)).length;
};

const LastChip: React.FC<{ s: Schedule }> = ({ s }) => {
  const l = s.lastRun;
  if (!l) return <span className="dim">—</span>;
  const title = `${new Date(l.at).toLocaleString()}${l.note ? ` · ${l.note}` : ''}`;
  const chip = !l.runId ? (
    <span className="badge warn">Skipped</span>
  ) : !l.done ? (
    <span className="badge live">
      <Loader2 size={11} className="spin" /> Running
    </span>
  ) : l.failed ? (
    <span className="badge error">
      {l.failed} failed{l.ok ? ` · ${l.ok} ok` : ''}
    </span>
  ) : (
    <span className="badge label">{l.ok} ok</span>
  );
  return (
    <span className="aut-last" title={title}>
      {chip}
      <span className="sub">{ago(l.at)}</span>
    </span>
  );
};

export const SchedulesView: React.FC<{
  tabs: React.ReactNode;
  schedules: Schedule[] | null;
  loadError: string | null;
  onReload: () => void;
  onChange: (list: Schedule[]) => void;
}> = ({ tabs, schedules, loadError, onReload, onChange }) => {
  const { scripts } = useApp();
  const { toast, confirm } = useUI();
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const list = schedules || [];

  const act = async (id: string, fn: () => Promise<void>) => {
    setBusyId(id);
    try {
      await fn();
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setBusyId(null);
    }
  };

  const toggle = (s: Schedule) =>
    act(s.id, async () => {
      const next = await api.updateSchedule(s.id, { enabled: !s.enabled });
      onChange(list.map((x) => (x.id === s.id ? next : x)));
    });

  const runNow = (s: Schedule) =>
    act(s.id, async () => {
      const { run } = await api.runSchedule(s.id);
      const n = Object.keys(run.results).length;
      toast('info', `Started “${s.name}” on ${n} profile${n === 1 ? '' : 's'}`);
    });

  const remove = async (s: Schedule) => {
    if (!(await confirm({ title: `Delete “${s.name}”?`, body: 'It stops running. Past runs stay in Runs.', confirmLabel: 'Delete', danger: true }))) return;
    act(s.id, async () => {
      await api.deleteSchedule(s.id);
      onChange(list.filter((x) => x.id !== s.id));
      toast('success', 'Deleted');
    });
  };

  const scriptText = (s: Schedule) => {
    if ('builtin' in s.script) return `Warm-up · ${plural(s.script.input.sites.length, 'site')}`;
    const id = s.script.scriptId;
    return scripts.find((x) => x.id === id)?.name ?? null;
  };

  return (
    <>
      <header className="section-head">
        <h1>Automation</h1>
        {tabs}
        <span className="grow" />
        <button className="btn primary" onClick={() => setEditing('new')} disabled={!schedules}>
          <Plus size={14} /> New schedule
        </button>
      </header>
      <div className="view">
        <p className="aut-note">
          <Info size={13} /> Schedules run only while SessionManagerPro is running (tray). Missed times are skipped.
        </p>
        {loadError ? (
          <Empty
            icon={<CalendarClock size={22} />}
            text="Couldn’t load schedules"
            hint={loadError}
            action={
              <button className="btn" onClick={onReload}>
                <RefreshCw size={13} /> Retry
              </button>
            }
          />
        ) : !schedules ? (
          <p className="hint aut-loading">
            <Loader2 size={13} className="spin" /> Loading schedules…
          </p>
        ) : !list.length ? (
          <Empty
            icon={<CalendarClock size={22} />}
            text="No schedules yet"
            hint="Run a script or a warm-up on a timetable."
            action={
              <button className="btn primary" onClick={() => setEditing('new')}>
                <Plus size={13} /> New schedule
              </button>
            }
          />
        ) : (
          <div className="table-wrap">
            <div className="table-scroll">
              <table className="tbl aut-sched">
                <thead>
                  <tr>
                    <th className="tight">
                      <span className="sr-only">Enabled</span>
                    </th>
                    <th>Name</th>
                    <th>Targets</th>
                    <th>When</th>
                    <th>Next run</th>
                    <th>Last run</th>
                    <th className="tight">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((s) => {
                    const script = scriptText(s);
                    return (
                      <tr key={s.id} data-off={!s.enabled || undefined}>
                        <td className="tight">
                          <label className="switch" title={s.enabled ? 'On' : 'Off'}>
                            <input type="checkbox" checked={s.enabled} disabled={busyId === s.id} onChange={() => toggle(s)} aria-label={`${s.name} enabled`} />
                          </label>
                        </td>
                        <td>
                          <span className="name">{s.name}</span>
                          <span className={`sub${script ? '' : ' aut-missing'}`}>{script ?? 'Script deleted'}</span>
                        </td>
                        <td>{targetText(s.targets)}</td>
                        <td>{ruleText(s.rule)}</td>
                        <td>{s.enabled && s.nextRun ? when(s.nextRun) : <span className="dim">—</span>}</td>
                        <td>
                          <LastChip s={s} />
                        </td>
                        <td className="tight">
                          <span className="inline">
                            <button className="icon-btn" onClick={() => runNow(s)} disabled={busyId === s.id} aria-label={`Run ${s.name} now`} title="Run now">
                              {busyId === s.id ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
                            </button>
                            <button className="icon-btn" onClick={() => setEditing(s)} aria-label={`Edit ${s.name}`} title="Edit">
                              <Pencil size={14} />
                            </button>
                            <button className="icon-btn danger" onClick={() => remove(s)} disabled={busyId === s.id} aria-label={`Delete ${s.name}`} title="Delete">
                              <Trash2 size={14} />
                            </button>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
      {editing && (
        <ScheduleEditor
          schedule={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            onChange(list.some((x) => x.id === saved.id) ? list.map((x) => (x.id === saved.id ? saved : x)) : [...list, saved]);
            setEditing(null);
          }}
        />
      )}
    </>
  );
};

/* ---------------- editor ---------------- */

const CUSTOM = '__saved';

const ScheduleEditor: React.FC<{ schedule: Schedule | null; onClose: () => void; onSaved: (s: Schedule) => void }> = ({
  schedule,
  onClose,
  onSaved,
}) => {
  const { scripts, sessions, selectedIds, app } = useApp();
  const { toast } = useUI();
  const sets = useWarmupSets();
  const saved = (scripts as LibScript[]).filter((s) => !s.builtin);
  const s0 = schedule;

  const [name, setName] = useState(s0?.name ?? '');
  const [scriptKey, setScriptKey] = useState(() => (!s0 ? WARMUP : 'builtin' in s0.script ? WARMUP : s0.script.scriptId));
  const input0: WarmupInput | null = s0 && 'builtin' in s0.script ? s0.script.input : null;
  const [siteSource, setSiteSource] = useState(input0 ? CUSTOM : sets[0]?.name ?? '');
  const [dwell, setDwell] = useState<[number, number]>(input0?.dwell ?? [20, 60]);
  const [links, setLinks] = useState(input0?.links ?? 1);

  const [kind, setKind] = useState<TargetKind>(s0?.targets.kind ?? (selectedIds.length ? 'ids' : 'all'));
  const [value, setValue] = useState<string>(typeof s0?.targets.value === 'string' ? s0.targets.value : '');
  const [ids, setIds] = useState<string[]>(Array.isArray(s0?.targets.value) ? s0.targets.value : selectedIds);

  const [rule, setRule] = useState<Rule>(s0?.rule ?? { kind: 'daily', time: '09:00' });
  const [opts, setOpts] = useState<ScheduleOptions>(s0?.options ?? { launch: true, stopAfter: true, hidden: true, skipIfRunning: true });
  const [busy, setBusy] = useState(false);
  // Fixed per dialog: 'in the future' is checked again by the server on save.
  const [now] = useState(() => Date.now());

  const isWarmup = scriptKey === WARMUP;
  const launch = isWarmup || opts.launch;

  const choices = useMemo(() => {
    const uniq = (xs: Array<string | undefined>) => [...new Set(xs.filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b));
    const statuses = Array.isArray(app?.statuses) ? (app.statuses as Array<{ name: string }>).map((x) => x.name) : [];
    const folders = Array.isArray(app?.folders) ? (app.folders as string[]) : [];
    return {
      tag: uniq(sessions.flatMap((s) => s.tags || [])),
      status: uniq([...statuses, ...sessions.map((s) => s.label)]),
      folder: uniq([...folders, ...sessions.map((s) => s.folder)]),
    };
  }, [sessions, app]);

  const targetValue = kind === 'ids' ? ids : kind === 'all' ? null : value;
  const matched = matches(sessions, kind, targetValue);
  const sites = siteSource === CUSTOM ? input0?.sites ?? [] : sets.find((x) => x.name === siteSource)?.urls ?? [];

  const error = (() => {
    if (!name.trim()) return 'Give the schedule a name';
    if (!scriptKey) return 'Pick a script';
    if (isWarmup && !sites.length) return 'Pick a site set';
    if (isWarmup) {
      const d = dwellError(dwell[0], dwell[1]);
      if (d) return d;
    }
    if (kind !== 'all' && kind !== 'ids' && !value) return `Pick a ${kind}`;
    if (kind === 'ids' && !ids.length) return 'Select profiles on the Profiles tab first';
    if (rule.kind === 'every' && (!Number.isInteger(rule.minutes) || rule.minutes < 5 || rule.minutes > 10080)) return 'Every 5 min to 7 days';
    if (rule.kind === 'weekly' && !rule.days.length) return 'Pick at least one day';
    if ((rule.kind === 'daily' || rule.kind === 'weekly') && !/^\d\d:\d\d$/.test(rule.time)) return 'Pick a time';
    if (rule.kind === 'once' && !(Date.parse(rule.at) > now)) return 'Pick a time in the future';
    return null;
  })();

  const setRuleKind = (k: Rule['kind']) => {
    const time = 'time' in rule ? rule.time : '09:00';
    if (k === 'every') setRule({ kind: 'every', minutes: 60 });
    else if (k === 'daily') setRule({ kind: 'daily', time });
    else if (k === 'weekly') setRule({ kind: 'weekly', days: [1, 2, 3, 4, 5], time });
    else setRule({ kind: 'once', at: new Date(now + 3600_000).toISOString() });
  };

  const save = async () => {
    if (error || busy) return;
    const draft: ScheduleDraft = {
      name: name.trim(),
      enabled: s0?.enabled ?? true,
      script: isWarmup ? { builtin: 'warmup', input: { sites, dwell, scroll: true, links, shuffle: true } } : { scriptId: scriptKey },
      targets: { kind, value: targetValue },
      rule,
      options: { ...opts, launch },
    };
    setBusy(true);
    try {
      const out = s0 ? await api.updateSchedule(s0.id, draft) : await api.createSchedule(draft);
      toast('success', s0 ? 'Saved' : `Created “${out.name}”`);
      onSaved(out);
    } catch (err: any) {
      toast('error', err.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={s0 ? 'Edit schedule' : 'New schedule'}
      width={580}
      onClose={() => !busy && onClose()}
      footer={
        <>
          <span className="hint grow aut-foot">{error}</span>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy || !!error}>
            {busy && <Loader2 size={13} className="spin" />} {s0 ? 'Save' : 'Create'}
          </button>
        </>
      }
    >
      <div className="aut-grid">
        <div className="row">
          <label htmlFor="sc-name">Name</label>
          <input id="sc-name" className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning warm-up" />
        </div>
        <div className="row">
          <label htmlFor="sc-script">Script</label>
          <Picker
            id="sc-script"
            block
            label="Script"
            value={scriptKey}
            onChange={setScriptKey}
            options={[
              { value: WARMUP, label: 'Warm-up', hint: 'built-in' },
              ...saved.map((s) => ({ value: s.id, label: s.name })),
              ...(!isWarmup && !saved.some((s) => s.id === scriptKey) ? [{ value: scriptKey, label: 'Deleted script' }] : []),
            ]}
          />
        </div>
      </div>

      {isWarmup && (
        <div className="aut-grid aut-sub">
          <div className="row">
            <label htmlFor="sc-sites">Sites</label>
            <Picker
              id="sc-sites"
              block
              label="Sites"
              value={siteSource}
              onChange={setSiteSource}
              options={[
                ...(!sets.length && !input0 ? [{ value: '', label: 'No site sets', hint: 'add one in Settings' }] : []),
                ...(input0 ? [{ value: CUSTOM, label: 'As saved', hint: plural(input0.sites.length, 'site') }] : []),
                ...sets.map((x) => ({ value: x.name, label: x.name, hint: String(x.urls.length) })),
              ]}
            />
          </div>
          <div className="row">
            <label htmlFor="sc-dwell">Time on each site</label>
            <DwellInputs id="sc-dwell" value={dwell} onChange={setDwell} />
          </div>
          <div className="row aut-row">
            <span className="row-label">Follow links per site</span>
            <Stepper value={links} min={0} max={3} label="Links per site" onStep={(d) => setLinks((n) => Math.min(3, Math.max(0, n + d)))} />
          </div>
        </div>
      )}

      <div className="row">
        <span className="row-label">Profiles</span>
        <div className="inline aut-wrap">
          <span className="aut-kind">
            <Picker
              block
              label="Which profiles"
              value={kind}
              onChange={(v) => (setKind(v as TargetKind), setValue(''))}
              options={[
                { value: 'all', label: 'All profiles' },
                { value: 'tag', label: 'With tag' },
                { value: 'status', label: 'With status' },
                { value: 'folder', label: 'In folder' },
                { value: 'ids', label: 'Chosen profiles' },
              ]}
            />
          </span>
          {(kind === 'tag' || kind === 'status' || kind === 'folder') && (
            <span className="aut-kind">
              <Picker
                block
                label={`Pick a ${kind}`}
                value={value}
                onChange={setValue}
                options={[
                  { value: '', label: `Pick a ${kind}…` },
                  ...choices[kind].map((c) => ({ value: c, label: c })),
                  ...(value && !choices[kind].includes(value) ? [{ value, label: value }] : []),
                ]}
              />
            </span>
          )}
          {kind === 'ids' && (
            <button className="btn" onClick={() => setIds(selectedIds)} disabled={!selectedIds.length} title="The profiles selected on the Profiles tab">
              Use selection ({selectedIds.length})
            </button>
          )}
          <span className="hint">
            {kind === 'ids' ? `${ids.length} chosen · ` : ''}matches {matched} now
          </span>
        </div>
      </div>

      <div className="row aut-row">
        <span className="row-label">When</span>
        <div className="seg" role="group" aria-label="Repeat">
          {(['every', 'daily', 'weekly', 'once'] as const).map((k) => (
            <button key={k} aria-pressed={rule.kind === k} onClick={() => setRuleKind(k)}>
              {k === 'every' ? 'Interval' : k[0].toUpperCase() + k.slice(1)}
            </button>
          ))}
        </div>
        <div className="inline aut-wrap">
          {rule.kind === 'every' && (
            <>
              <span className="dim">Every</span>
              <input
                className="input num"
                type="number"
                min={5}
                max={10080}
                value={Number.isNaN(rule.minutes) ? '' : rule.minutes}
                onChange={(e) => setRule({ kind: 'every', minutes: e.target.valueAsNumber })}
                aria-label="Minutes between runs"
              />
              <span className="dim">minutes</span>
            </>
          )}
          {rule.kind === 'weekly' && (
            <div className="seg" role="group" aria-label="Days">
              {WEEK.map((d) => (
                <button
                  key={d}
                  aria-pressed={rule.days.includes(d)}
                  onClick={() => setRule({ ...rule, days: rule.days.includes(d) ? rule.days.filter((x) => x !== d) : [...rule.days, d] })}
                >
                  {DAYS[d]}
                </button>
              ))}
            </div>
          )}
          {(rule.kind === 'daily' || rule.kind === 'weekly') && (
            <>
              <span className="dim">at</span>
              <input className="input aut-time" type="time" value={rule.time} onChange={(e) => setRule({ ...rule, time: e.target.value })} aria-label="Time" />
            </>
          )}
          {rule.kind === 'once' && (
            <input
              className="input aut-datetime"
              type="datetime-local"
              value={toLocalInput(rule.at)}
              onChange={(e) => {
                const t = new Date(e.target.value).getTime();
                if (Number.isFinite(t)) setRule({ kind: 'once', at: new Date(t).toISOString() });
              }}
              aria-label="Date and time"
            />
          )}
        </div>
      </div>

      <div className="aut-grid">
        <label className="switch" title={isWarmup ? 'A warm-up always opens the profiles it needs' : undefined}>
          <input type="checkbox" checked={launch} disabled={isWarmup} onChange={(e) => setOpts({ ...opts, launch: e.target.checked })} />
          Open profiles that aren’t running
        </label>
        <label className="switch">
          <input type="checkbox" checked={opts.hidden} disabled={!launch} onChange={(e) => setOpts({ ...opts, hidden: e.target.checked })} />
          Hidden window
        </label>
        <label className="switch">
          <input type="checkbox" checked={opts.stopAfter} onChange={(e) => setOpts({ ...opts, stopAfter: e.target.checked })} />
          Stop profile when done
        </label>
        <label className="switch" title="Leaves windows you are using alone">
          <input type="checkbox" checked={opts.skipIfRunning} disabled={!launch} onChange={(e) => setOpts({ ...opts, skipIfRunning: e.target.checked })} />
          Skip profiles already running
        </label>
      </div>
      {!launch && <p className="hint">Only profiles that are running at that time take part.</p>}
    </Modal>
  );
};
