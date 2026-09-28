import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Ban,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleX,
  FileCode2,
  Flame,
  Loader2,
  Lock,
  MousePointerClick,
  Play,
  Plus,
  Save,
  Square,
  Trash2,
} from 'lucide-react';
import type { RunResult, Script, ScriptDraft, ScriptMode, ScriptRun, SessionRecord } from '../../types';
import { api } from '../../api';
import { Empty, Menu, TagInput, useUI } from '../../ui';
import { CodeEditor } from './CodeEditor';
import { FaceHuddle } from '../../faces';
import type { LibScript } from './types';

const TEMPLATES: Record<ScriptMode, string> = {
  page: [
    '// Runs inside the current tab, like the DevTools console.',
    '// `return` a value to see it below. log(), sleep() and random() work here too.',
    'return { title: document.title, url: location.href };',
  ].join('\n'),
  automation: [
    '// Drives the current tab across page loads.',
    '// In scope: page, cursor, profile, log, sleep, random',
    "await page.goto('https://example.com');",
    'await sleep(random(800, 1600));',
    "log('title:', await page.title());",
    'return page.url();',
  ].join('\n'),
};

const API_REF = `page.goto(url)              page.click(selector)
page.fill(selector, text)   page.type(selector, text, { delay })
page.press(key)             page.press(selector, key)
page.waitFor(selector)      page.scroll(dy)
page.evaluate(fn, arg)      page.newTab(url)
page.screenshot()           page.url()  page.title()  page.cookies()

Human input (curved paths, eased wheel, WPM typing; real events):
cursor.moveTo(x, y)         cursor.moveTo(selector)
cursor.click(selector)      cursor.clickAt(x, y)
cursor.type(text, { selector, credentialField, noTypos })
cursor.scroll(notches)      cursor.scrollPx(px)   cursor.scrollTo(selector)
cursor.wander(true)         cursor.scrollBurst(true)   (false: only sometimes)

profile.id  .email  .notes  .tags  .proxy
log(...values)   sleep(ms)   random(min, max)

Every page.* call accepts { timeout } in ms (default 30000).
Scripts stop after 10 minutes, or when you press Stop.
The built-in Warm-up also reads input: its dialog's settings.`;

const blank = (mode: ScriptMode): ScriptDraft => ({
  name: mode === 'page' ? 'New page script' : 'New automation',
  mode,
  code: TEMPLATES[mode],
  autoRun: false,
  match: '',
  tags: [],
});

const toDraft = (s: Script): ScriptDraft => ({
  name: s.name,
  mode: s.mode,
  code: s.code,
  autoRun: s.autoRun,
  match: s.match,
  tags: s.tags || [],
});

const sameDraft = (a: ScriptDraft, b: ScriptDraft) =>
  a.name === b.name &&
  a.mode === b.mode &&
  a.code === b.code &&
  a.autoRun === b.autoRun &&
  a.match === b.match &&
  a.tags.join() === b.tags.join();

export const ScriptsView: React.FC<{
  /** The Automation header's tab switch, rendered next to the title. */
  tabs: React.ReactNode;
  scripts: LibScript[];
  sessions: SessionRecord[];
  selectedIds: string[];
  runs: ScriptRun[];
  onChanged: () => Promise<void>;
  onRun: (target: { scriptId: string } | { draft: ScriptDraft }, ids: string[]) => Promise<ScriptRun | null>;
  /** Opens the Warm-up dialog for these profiles. */
  onWarmup: (ids: string[]) => void;
}> = ({ tabs, scripts, sessions, selectedIds, runs, onChanged, onRun, onWarmup }) => {
  const { toast, confirm } = useUI();
  // null = nothing chosen yet (follow the list); 'new' = an unsaved new script.
  const [currentId, setCurrentId] = useState<string | null>(scripts[0]?.id ?? null);
  const current = scripts.find((s) => s.id === currentId) || null;
  const [draft, setDraft] = useState<ScriptDraft>(() => (current ? toDraft(current) : blank('page')));
  // What the draft started from — the saved script, or a new script's template — so any
  // edit (name, mode, options, code) counts as unsaved, and an untouched template doesn't.
  const [base, setBase] = useState<ScriptDraft>(draft);
  // Follows the selection until the user picks: this view stays mounted, so a value fixed at
  // mount would ignore profiles selected later. A selection never widens to "all running".
  const [targetPick, setTarget] = useState<'selected' | 'live' | null>(null);
  const target = targetPick ?? (selectedIds.length ? 'selected' : 'live');
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const escaped = useRef(false);
  const codeRef = useRef<HTMLTextAreaElement>(null);

  const allTags = useMemo(() => [...new Set(sessions.flatMap((s) => s.tags || []))].sort(), [sessions]);
  const liveIds = sessions.filter((s) => s.status === 'live').map((s) => s.id);
  const selectedLive = selectedIds.filter((id) => liveIds.includes(id));
  const targetIds = target === 'selected' ? selectedLive : liveIds;
  const dirty = !sameDraft(draft, base);
  // The built-in Warm-up: shown for reading, run through its own dialog.
  const locked = !!current?.builtin;

  // The run shown is the one started here, else the latest for this script.
  const run =
    runs.find((r) => r.id === lastRunId && (!current || r.scriptId === current.id || r.scriptId === null)) ||
    (current ? runs.find((r) => r.scriptId === current.id) : undefined);
  const running = run ? Object.values(run.results).some((r) => r.state === 'running' || r.state === 'pending') : false;

  const load = (s: Script | null, mode: ScriptMode = 'page') => {
    const d = s ? toDraft(s) : blank(mode);
    setCurrentId(s ? s.id : 'new');
    setDraft(d);
    setBase(d);
    setLastRunId(null);
  };

  const open = async (s: Script | null, mode?: ScriptMode) => {
    if (dirty && !(await confirm({ title: 'Discard unsaved changes?', confirmLabel: 'Discard', danger: true }))) return;
    load(s, mode);
    requestAnimationFrame(() => codeRef.current?.focus());
  };

  // Follow the list: show the first script once they load, and move on after a delete.
  useEffect(() => {
    if (currentId === 'new') return;
    if (currentId === null) {
      if (scripts.length && !dirty) load(scripts[0]);
    } else if (!scripts.some((s) => s.id === currentId)) {
      load(scripts[0] || null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scripts, currentId]);

  const save = async () => {
    if (saving.current) return; // Ctrl+S twice must not create two scripts
    if (!draft.name.trim()) return toast('error', 'Give the script a name');
    saving.current = true;
    setBusy(true);
    const sent = draft;
    try {
      const saved = current ? await api.updateScript(current.id, sent) : await api.createScript(sent);
      await onChanged();
      setCurrentId(saved.id);
      setBase(toDraft(saved));
      // Keep anything typed while the save was in flight.
      setDraft((d) => (sameDraft(d, sent) ? toDraft(saved) : d));
      toast('success', current ? 'Saved' : `Created “${saved.name}”`);
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!current) return;
    const ok = await confirm({ title: `Delete “${current.name}”?`, confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await api.deleteScript(current.id);
      await onChanged();
      toast('success', 'Deleted');
    } catch (err: any) {
      toast('error', err.message);
    }
  };

  const runNow = async () => {
    if (locked) return;
    if (!targetIds.length) {
      return toast('info', target === 'selected' ? 'None of the selected profiles are running' : 'No profiles are running');
    }
    // Unsaved edits run as a draft, so what you see is what executes.
    const r = await onRun(current && !dirty ? { scriptId: current.id } : { draft }, targetIds);
    if (r) setLastRunId(r.id);
  };

  const onCodeKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      // Esc, then Tab, leaves the editor; otherwise Tab indents.
      escaped.current = true;
      return;
    }
    if (e.key === 'Tab' && !e.shiftKey && !escaped.current) {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart: a, selectionEnd: b, value } = el;
      const next = value.slice(0, a) + '  ' + value.slice(b);
      setDraft((d) => ({ ...d, code: next }));
      requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
    } else if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      save();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      runNow();
    }
    if (e.key !== 'Tab' && e.key !== 'Shift') escaped.current = false;
  };

  return (
    <>
      <header className="section-head">
        <h1>Automation</h1>
        {tabs}
        <span className="grow" />
        <Menu
          trigger={(t) => (
            <button className="btn primary" {...t}>
              <Plus size={14} /> New
            </button>
          )}
        >
          {(close) => (
            <>
              <button onClick={() => (close(), open(null, 'page'))}>
                <FileCode2 size={13} /> Page script
              </button>
              <button onClick={() => (close(), open(null, 'automation'))}>
                <MousePointerClick size={13} /> Automation
              </button>
            </>
          )}
        </Menu>
      </header>

      <div className="view">
        <div className="scripts">
          <div className="card script-list">
            <div className="items">
              {!scripts.length && <Empty icon={<FaceHuddle mood="calm" />} text="No scripts yet" hint="Create one with New." />}
              {scripts.map((s) => (
                <button
                  key={s.id}
                  className="script-item"
                  aria-current={s.id === currentId}
                  onClick={() => s.id !== currentId && open(s)}
                >
                  {s.builtin ? <Flame size={14} /> : s.mode === 'page' ? <FileCode2 size={14} /> : <MousePointerClick size={14} />}
                  <span className="grow">{s.name}</span>
                  {s.autoRun && (
                    <span className="auto-dot" title="Auto-runs on launch">
                      <span className="sr-only">, auto-runs on launch</span>
                    </span>
                  )}
                  {s.builtin ? (
                    <span className="mode" title="Built-in, read-only">
                      <Lock size={11} />
                      <span className="sr-only">, built-in, read-only</span>
                    </span>
                  ) : (
                    <span className="mode">{s.mode === 'page' ? 'page' : 'auto'}</span>
                  )}
                </button>
              ))}
            </div>
          </div>

          <div className="card editor">
            <div className="editor-head">
              <input
                className="input title"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                aria-label="Script name"
                maxLength={80}
                readOnly={locked}
              />
              {locked ? (
                <span className="badge" title="Ships with the app; it can't be edited or deleted">
                  <Lock size={11} /> Built-in
                </span>
              ) : (
              <div className="seg" role="group" aria-label="Mode">
                <button
                  aria-pressed={draft.mode === 'page'}
                  onClick={() => setDraft({ ...draft, mode: 'page' })}
                  title="Runs inside the tab"
                >
                  Page
                </button>
                <button
                  aria-pressed={draft.mode === 'automation'}
                  onClick={() => setDraft({ ...draft, mode: 'automation', autoRun: false })}
                  title="Drives the tab: goto, click, type…"
                >
                  Automation
                </button>
              </div>
              )}
              {!locked && <button className="btn" onClick={save} disabled={busy || !dirty} title="Ctrl+S">
                {busy ? <Loader2 size={13} className="spin" /> : <Save size={13} />}
                {current ? 'Save' : 'Create'}
              </button>}
              {current && !locked && (
                <button className="icon-btn danger" onClick={remove} aria-label="Delete script" title="Delete script">
                  <Trash2 size={14} />
                </button>
              )}
            </div>

            <div className="editor-split">
              <CodeEditor
                textRef={codeRef}
                value={draft.code}
                onChange={(code) => setDraft({ ...draft, code })}
                onKeyDown={onCodeKey}
                readOnly={locked}
                onFocus={() => (escaped.current = false)}
              />
              <div>
                {draft.mode === 'page' ? (
                  <div className="editor-opts">
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={draft.autoRun}
                        onChange={(e) => setDraft({ ...draft, autoRun: e.target.checked })}
                      />
                      Auto-run on every page at launch
                    </label>
                    {draft.autoRun && (
                      <>
                        <input
                          className="input mono"
                          style={{ width: 240 }}
                          placeholder="URL match, e.g. *://*.site.com/*"
                          value={draft.match}
                          onChange={(e) => setDraft({ ...draft, match: e.target.value })}
                          aria-label="Only on URLs matching"
                        />
                        <div style={{ minWidth: 200, flex: 1 }}>
                          <TagInput
                            id="script-tags"
                            value={draft.tags}
                            onChange={(tags) => setDraft({ ...draft, tags })}
                            suggestions={allTags}
                            placeholder="Only profiles tagged… (all if empty)"
                            label="Only profiles tagged"
                          />
                        </div>
                      </>
                    )}
                  </div>
                ) : (
                  <details className="editor-opts" style={{ display: 'block' }}>
                    <summary>
                      <ChevronRight size={13} /> API reference
                    </summary>
                    <pre className="code-block" style={{ marginTop: 8 }}>
                      {API_REF}
                    </pre>
                  </details>
                )}
              </div>
            </div>

            {locked ? (
            <div className="editor-run">
              <span className="hint">
                {selectedIds.length
                  ? `Visits sites on ${selectedIds.length} selected profile${selectedIds.length > 1 ? 's' : ''}, opening any that aren’t running.`
                  : 'Select profiles on the Profiles tab. They don’t need to be running.'}
              </span>
              <span className="grow" />
              {running && run && (
                <button className="btn danger" onClick={() => api.stopRun(run.id).catch((e) => toast('error', e.message))}>
                  <Square size={11} /> Stop
                </button>
              )}
              <button className="btn primary" onClick={() => onWarmup(selectedIds)} disabled={!selectedIds.length}>
                <Flame size={12} /> Run warm-up…
              </button>
            </div>
            ) : (
            <div className="editor-run">
              <div className="seg" role="group" aria-label="Run on">
                <button aria-pressed={target === 'selected'} onClick={() => setTarget('selected')}>
                  Selected <span className="n">{selectedLive.length}</span>
                </button>
                <button aria-pressed={target === 'live'} onClick={() => setTarget('live')}>
                  All running <span className="n">{liveIds.length}</span>
                </button>
              </div>
              <span className="hint">
                {targetIds.length
                  ? dirty
                    ? 'Runs the editor contents (unsaved).'
                    : `Runs on ${targetIds.length} profile${targetIds.length > 1 ? 's' : ''}.`
                  : target === 'selected'
                    ? 'Select running profiles on the Profiles tab.'
                    : 'Launch profiles to run scripts in them.'}
              </span>
              <span className="grow" />
              {running && run && (
                <button className="btn danger" onClick={() => api.stopRun(run.id).catch((e) => toast('error', e.message))}>
                  <Square size={11} /> Stop
                </button>
              )}
              <button className="btn primary" onClick={runNow} disabled={!targetIds.length || !draft.code.trim()} title="Ctrl+Enter">
                <Play size={12} /> Run
              </button>
            </div>
            )}

            {run && <Results run={run} />}
          </div>
        </div>
      </div>
    </>
  );
};

const STATE_ICON: Record<RunResult['state'], React.ReactNode> = {
  pending: <CircleDashed size={14} className="st-pending" />,
  running: <Loader2 size={14} className="spin st-running" />,
  ok: <CircleCheck size={14} className="st-ok" />,
  error: <CircleX size={14} className="st-error" />,
  stopped: <Ban size={14} className="st-stopped" />,
};

const SHOT = /^\/api\/screenshots\/[^\s"'<>]+\.png$/;

export const Results: React.FC<{ run: ScriptRun }> = ({ run }) => {
  const entries = Object.entries(run.results);
  const done = entries.filter(([, r]) => r.state !== 'pending' && r.state !== 'running').length;
  return (
    <div className="results" aria-live="polite">
      <div className="result head">
        <span className="dim">
          {run.scriptName} · {done}/{entries.length} done
        </span>
        <span className="dim">{new Date(run.startedAt).toLocaleTimeString([], { hour12: false })}</span>
      </div>
      {entries.map(([id, r]) => (
        <div key={id} className="result">
          <span role="img" aria-label={r.state}>
            {STATE_ICON[r.state]}
          </span>
          <span className="name" style={{ fontSize: 12 }} title={id}>
            {id}
          </span>
          <div style={{ minWidth: 0 }}>
            {r.error && <pre className="err">{r.error}</pre>}
            {r.value != null &&
              (SHOT.test(r.value) ? (
                <a href={r.value} target="_blank" rel="noreferrer">
                  <img src={r.value} alt={`Screenshot from ${id}`} style={{ maxHeight: 120, borderRadius: 6 }} />
                </a>
              ) : (
                <pre>{r.value}</pre>
              ))}
            {!!r.logs?.length && <pre className="dim">{r.logs.slice(-5).join('\n')}</pre>}
            {r.state === 'running' && !r.logs?.length && <span className="dim">running…</span>}
          </div>
          <span className="dim mono">{r.ms != null ? `${r.ms} ms` : ''}</span>
        </div>
      ))}
    </div>
  );
};
