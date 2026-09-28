import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, CircleAlert, Copy, CopyPlus, LayoutTemplate, Loader2, Pencil, Plus, Settings2, Trash2, Zap } from 'lucide-react';
import { renderSlot } from '../../contributions';
import { useApp, useEvent } from '../../app-context';
import { Empty, Menu, Modal, Picker, TagInput, useUI } from '../../ui';
import { FaceHuddle } from '../../faces';
import { fptMeta } from '../../components/FingerprintPanel';
import { EngineSelect } from '../engines';
import { api } from './api';
import type { CreateResult, FptStrategy, ProxyStrategy, Template, TemplateDraft } from './types';

// The Quick profile split button (Profiles header) and the Templates settings section.

const PROXY_OPTIONS: Array<[ProxyStrategy, string]> = [
  ['unused', 'Any unused'],
  ['unused-ok', 'Unused and checked'],
  ['specific', 'Specific'],
];
const FPT_OPTIONS: Array<[FptStrategy, string]> = [
  ['unused', 'Any unused'],
  ['specific', 'Specific'],
];

/* ---------------- name patterns (mirrors the server) ---------------- */

const hasCounter = (pattern: string) => /\{n(?::\d+)?\}/.test(pattern);
const expand = (pattern: string, n: number) =>
  pattern
    .replace(/\{n(?::(\d+))?\}/g, (_, pad?: string) => (pad ? String(n).padStart(Number(pad), '0') : String(n)))
    .replace(/\{date\}/g, new Date().toISOString().slice(0, 10));

/** The first `count` names the server would pick, given the ids already taken (lower-case). */
function previewNames(pattern: string, count: number, taken: Set<string>) {
  if (!hasCounter(pattern)) return [expand(pattern, 1)];
  const out: string[] = [];
  const seen = new Set(taken);
  for (let n = 1; out.length < count && n < 10000; n++) {
    const name = expand(pattern, n);
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

/** Existing and trashed ids, lower-case: both stay taken. */
function useTakenIds() {
  const { sessions, trash } = useApp();
  return useMemo(() => new Set([...sessions.map((s) => s.id), ...trash.map((t) => t.id)].map((x) => x.toLowerCase())), [sessions, trash]);
}

/* ---------------- data ---------------- */

function useTemplates() {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The error clears only once a list arrives, so a retry never flashes the list away.
  const reload = useCallback(
    () =>
      api.list().then(
        (list) => {
          setTemplates(list);
          setError(null);
        },
        (e: Error) => setError(e.message)
      ),
    []
  );
  useEffect(() => {
    reload();
  }, [reload]);
  // Every save on the server is broadcast, so the button and the settings list stay in step.
  useEvent('templates', setTemplates);
  return { templates, error, reload };
}

const summary = (t: Template) =>
  [
    PROXY_OPTIONS.find(([v]) => v === t.proxyStrategy)?.[1].toLowerCase() + ' proxy',
    t.fptStrategy === 'specific' ? 'fixed fingerprint' : 'any fingerprint',
    t.folder && `folder ${t.folder}`,
    t.status,
    t.tags.length > 0 && `${t.tags.length} tag${t.tags.length === 1 ? '' : 's'}`,
    t.startUrls.length > 0 && `${t.startUrls.length} start page${t.startUrls.length === 1 ? '' : 's'}`,
  ]
    .filter(Boolean)
    .join(' · ');

/* ---------------- Profiles header: Quick profile ▾ ---------------- */

export const QuickProfile: React.FC<{ onNew: () => void }> = ({ onNew }) => {
  const { openProfile, refresh } = useApp();
  const { toast } = useUI();
  const { templates, error, reload } = useTemplates();
  const [busy, setBusy] = useState(false);
  const [several, setSeveral] = useState(false);
  const [manage, setManage] = useState(false);
  const def = templates?.find((t) => t.isDefault) ?? templates?.[0] ?? null;

  const createFrom = async (t: Template, count = 1): Promise<CreateResult | null> => {
    setBusy(true);
    try {
      const r = await api.createProfiles(t.id, count);
      // The drawer only opens for a profile the list already knows.
      await refresh.sessions();
      if (r.skipped.length) toast(r.created.length ? 'info' : 'error', `${r.skipped[0].name}: ${r.skipped[0].error}`);
      if (r.created.length === 1 && count === 1) {
        toast('success', `Created ${r.created[0].id}`);
        openProfile(r.created[0].id);
      } else if (r.created.length) {
        toast('success', `Created ${r.created.length} profiles`);
      }
      return r;
    } catch (err: any) {
      toast('error', err.message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const title = def
    ? `One profile from "${def.name}"`
    : error
      ? 'Templates unavailable'
      : templates
        ? 'No templates'
        : 'Loading templates';

  return (
    <>
      <span className="split">
        <button className="btn primary" onClick={() => def && createFrom(def)} disabled={busy || !def} title={title}>
          {busy ? <Loader2 size={14} className="spin" /> : <Zap size={14} />} Quick profile
        </button>
        <Menu
          trigger={(t) => (
            <button className="btn primary" aria-label="More ways to add profiles" disabled={busy} {...t}>
              <ChevronDown size={14} />
            </button>
          )}
        >
          {(close) => (
            <>
              <button onClick={() => (close(), onNew())}>
                <Plus size={12} /> New profile…
              </button>
              {(templates?.length || error) && <hr />}
              {templates?.map((t) => (
                <button key={t.id} className="tpl-item" onClick={() => (close(), createFrom(t))} title={t.pattern}>
                  <LayoutTemplate size={12} />
                  <span>
                    From {t.name}
                    {t.isDefault ? ' · default' : ''}
                  </span>
                </button>
              ))}
              {error && (
                <button onClick={() => (close(), reload())}>
                  <CircleAlert size={12} /> Templates unavailable · retry
                </button>
              )}
              <button onClick={() => (close(), setSeveral(true))} disabled={!templates?.length}>
                <CopyPlus size={12} /> Create several…
              </button>
              {renderSlot('createMenu', { close })}
              <hr />
              <button onClick={() => (close(), setManage(true))}>
                <Settings2 size={12} /> Manage templates
              </button>
            </>
          )}
        </Menu>
      </span>
      {several && templates && def && (
        <CreateSeveral templates={templates} initial={def.id} busy={busy} onCreate={createFrom} onClose={() => setSeveral(false)} />
      )}
      {manage && (
        <Modal title="Templates" width={620} onClose={() => setManage(false)}>
          <TemplatesSection />
        </Modal>
      )}
    </>
  );
};

const CreateSeveral: React.FC<{
  templates: Template[];
  initial: string;
  busy: boolean;
  onCreate: (t: Template, count: number) => Promise<CreateResult | null>;
  onClose: () => void;
}> = ({ templates, initial, busy, onCreate, onClose }) => {
  const taken = useTakenIds();
  const [count, setCount] = useState(5);
  const [id, setId] = useState(initial);
  const t = templates.find((x) => x.id === id) ?? templates[0];
  const names = previewNames(t.pattern, Math.min(count, 3), taken);
  const noCounter = count > 1 && !hasCounter(t.pattern);
  const oneOnly = count > 1 && (t.proxyStrategy === 'specific' || t.fptStrategy === 'specific');
  const valid = Number.isInteger(count) && count >= 1 && count <= 100 && !noCounter && !oneOnly;

  return (
    <Modal
      title="Create several profiles"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="tpl-several" className="btn primary" disabled={busy || !valid}>
            {busy ? <Loader2 size={13} className="spin" /> : <Plus size={13} />} Create {valid ? count : ''}
          </button>
        </>
      }
    >
      <form
        id="tpl-several"
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!valid) return;
          const r = await onCreate(t, count);
          if (r?.created.length) onClose();
        }}
      >
        <div className="inline" style={{ alignItems: 'flex-start' }}>
          <div className="row" style={{ flex: 1 }}>
            <label htmlFor="tpl-sev-count">Count</label>
            <input
              id="tpl-sev-count"
              type="number"
              min={1}
              max={100}
              className="input tpl-num"
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
            />
          </div>
          <div className="row" style={{ flex: 2 }}>
            <label htmlFor="tpl-sev-template">Template</label>
            <Picker
              id="tpl-sev-template"
              block
              label="Template"
              value={t.id}
              onChange={setId}
              options={templates.map((x) => ({ value: x.id, label: x.name, hint: x.isDefault ? 'default' : undefined }))}
            />
          </div>
        </div>
        <div className="row">
          <span className="row-label">Names</span>
          <div className="code-block">
            {names.join('\n')}
            {count > 3 && `\n… ${count - 3} more`}
          </div>
          {noCounter && (
            <span className="hint" style={{ color: 'var(--danger)' }}>
              The pattern needs {'{n}'} to create more than one profile.
            </span>
          )}
          {oneOnly && (
            <span className="hint" style={{ color: 'var(--danger)' }}>
              A specific proxy or fingerprint fits one profile only.
            </span>
          )}
          {!noCounter && !oneOnly && <span className="hint">Each gets its own proxy and fingerprint from the pool.</span>}
        </div>
      </form>
    </Modal>
  );
};

/* ---------------- Settings › Templates ---------------- */

export const TemplatesSection: React.FC = () => {
  const { templates, error, reload } = useTemplates();
  const { toast, confirm } = useUI();
  const [editing, setEditing] = useState<Template | 'new' | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusyId(id);
    try {
      await fn();
      await reload();
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (t: Template) => {
    const ok = await confirm({
      title: `Delete template ${t.name}?`,
      body: `${t.isDefault ? 'It is the default; the next template takes over. ' : ''}Profiles already created keep their settings.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (ok) act(t.id, () => api.remove(t.id));
  };

  return (
    <>
      {error ? (
        <div className="alert">
          <CircleAlert size={14} style={{ marginTop: 1 }} />
          <span className="grow">{error}</span>
          <button className="btn xs" onClick={reload}>
            Retry
          </button>
        </div>
      ) : templates === null ? (
        <span className="hint inline">
          <Loader2 size={13} className="spin" /> Loading templates
        </span>
      ) : templates.length === 0 ? (
        <Empty
          icon={<FaceHuddle mood="puzzled" />}
          text="No templates"
          action={
            <button className="btn primary" onClick={() => setEditing('new')}>
              <Plus size={14} /> New template
            </button>
          }
        />
      ) : (
        templates.map((t) => (
          <div key={t.id} className="setting tpl-row">
            <div className="tpl-info">
              <div className="row-label">
                {t.name}
                {t.isDefault && <span className="badge">Default</span>}
              </div>
              <div className="hint mono" title={t.pattern}>
                {t.pattern}
              </div>
              <div className="hint">{summary(t)}</div>
            </div>
            <div className="inline tpl-actions">
              {!t.isDefault && (
                <button className="btn xs ghost" onClick={() => act(t.id, () => api.update(t.id, { isDefault: true }))} disabled={busyId === t.id}>
                  Make default
                </button>
              )}
              <button className="icon-btn xs" aria-label={`Edit ${t.name}`} title="Edit" onClick={() => setEditing(t)}>
                <Pencil size={13} />
              </button>
              <button
                className="icon-btn xs"
                aria-label={`Duplicate ${t.name}`}
                title="Duplicate"
                onClick={() => act(t.id, () => api.duplicate(t.id))}
                disabled={busyId === t.id}
              >
                {busyId === t.id ? <Loader2 size={13} className="spin" /> : <Copy size={13} />}
              </button>
              <button
                className="icon-btn xs danger"
                aria-label={`Delete ${t.name}`}
                title={templates.length === 1 ? 'The last template stays' : 'Delete'}
                onClick={() => remove(t)}
                disabled={busyId === t.id || templates.length === 1}
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        ))
      )}
      {templates && templates.length > 0 && (
        <div className="setting">
          <span className="hint">Quick profile uses the default. Every template fills in name, labels, start pages, proxy and fingerprint.</span>
          <button className="btn" onClick={() => setEditing('new')}>
            <Plus size={14} /> New template
          </button>
        </div>
      )}
      {editing && (
        <TemplateForm
          template={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </>
  );
};

/* ---------------- edit form ---------------- */

type Form = Omit<TemplateDraft, 'startUrls'> & { pages: string };

/** Unique non-empty strings, case-insensitively, in first-seen order. */
const names = (xs: unknown[]) => {
  const seen = new Set<string>();
  return xs.filter((x): x is string => typeof x === 'string' && x !== '' && !seen.has(x.toLowerCase()) && !!seen.add(x.toLowerCase()));
};

const blank = (): Form => ({
  name: '',
  pattern: 'profile-{n}',
  folder: '',
  tags: [],
  status: '',
  pages: '',
  notes: '',
  proxyStrategy: 'unused',
  proxy: '',
  fptStrategy: 'unused',
  fingerprintFile: '',
  browser: '',
  isDefault: false,
});

const TemplateForm: React.FC<{ template: Template | null; onClose: () => void; onSaved: () => void }> = ({ template, onClose, onSaved }) => {
  const { sessions, fingerprints, app } = useApp();
  const taken = useTakenIds();
  const [form, setForm] = useState<Form>(() =>
    template ? { ...template, browser: template.browser || '', pages: template.startUrls.join('\n') } : blank()
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const allTags = useMemo(() => [...new Set(sessions.flatMap((s) => s.tags || []))].sort(), [sessions]);
  // Suggestions: the organize lists (app settings "folders", "statuses") plus whatever profiles already use.
  const appFolders = app?.folders;
  const appStatuses = app?.statuses;
  const folders = useMemo(
    () => names([...(Array.isArray(appFolders) ? appFolders : []), ...sessions.map((s) => s.folder)]),
    [appFolders, sessions]
  );
  const labels = useMemo(
    () =>
      names([
        ...(Array.isArray(appStatuses) ? appStatuses.map((st: { name?: unknown }) => st?.name) : []),
        ...sessions.map((s) => s.label),
      ]),
    [appStatuses, sessions]
  );
  // Free fingerprints, plus the one this template already names (it may have been taken since).
  const fptOptions = useMemo(
    () => fingerprints.filter((f) => (!f.isAssigned && !f.error) || f.file === form.fingerprintFile),
    [fingerprints, form.fingerprintFile]
  );
  const next = form.pattern.trim() ? previewNames(form.pattern.trim(), 1, taken)[0] : '';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { pages, ...rest } = form;
      const draft: TemplateDraft = {
        ...rest,
        name: form.name.trim(),
        pattern: form.pattern.trim(),
        startUrls: pages.split('\n').map((u) => u.trim()).filter(Boolean),
      };
      if (template) await api.update(template.id, draft);
      else await api.create(draft);
      onSaved();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={template ? `Edit ${template.name}` : 'New template'}
      width={520}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="tpl-form" className="btn primary" disabled={busy || !form.name.trim() || !form.pattern.trim()}>
            {busy && <Loader2 size={13} className="spin" />} Save
          </button>
        </>
      }
    >
      <form id="tpl-form" className="form" onSubmit={submit}>
        {error && (
          <div className="alert">
            <CircleAlert size={14} style={{ marginTop: 1 }} />
            {error}
          </div>
        )}
        <div className="row">
          <label htmlFor="tpl-name">Name</label>
          <input id="tpl-name" className="input" autoFocus value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={40} placeholder="Warm-up" />
        </div>
        <div className="row">
          <label htmlFor="tpl-pattern">Profile name pattern</label>
          <input id="tpl-pattern" className="input mono" value={form.pattern} onChange={(e) => set('pattern', e.target.value)} maxLength={80} />
          <span className="hint">
            {'{n}'} counter · {'{n:03}'} zero-padded · {'{date}'} today{next && ` · next: ${next}`}
          </span>
        </div>
        <div className="inline" style={{ alignItems: 'flex-start' }}>
          <div className="row" style={{ flex: 1 }}>
            <label htmlFor="tpl-folder">Folder</label>
            <input id="tpl-folder" className="input" list="tpl-folders" value={form.folder} onChange={(e) => set('folder', e.target.value)} maxLength={40} />
            <datalist id="tpl-folders">
              {folders.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </div>
          <div className="row" style={{ flex: 1 }}>
            <label htmlFor="tpl-status">Status</label>
            <input
              id="tpl-status"
              className="input"
              list="tpl-labels"
              placeholder="e.g. warming"
              value={form.status}
              onChange={(e) => set('status', e.target.value)}
              maxLength={24}
            />
            <datalist id="tpl-labels">
              {labels.map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          </div>
        </div>
        <div className="row">
          <label htmlFor="tpl-tags">Tags</label>
          <TagInput id="tpl-tags" value={form.tags} onChange={(v) => set('tags', v)} suggestions={allTags} />
        </div>
        <div className="row">
          <label htmlFor="tpl-pages">Start pages</label>
          <textarea
            id="tpl-pages"
            className="input mono"
            rows={2}
            placeholder="One URL per line"
            value={form.pages}
            onChange={(e) => set('pages', e.target.value)}
          />
        </div>
        <div className="row">
          <label htmlFor="tpl-notes">Notes</label>
          <textarea id="tpl-notes" className="input" rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} maxLength={2000} />
        </div>

        <div className="row">
          <label htmlFor="tpl-browser">Browser</label>
          <EngineSelect id="tpl-browser" inherit value={form.browser} onChange={(v) => set('browser', v)} />
        </div>

        <fieldset className="tpl-radios">
          <legend>Proxy</legend>
          {PROXY_OPTIONS.map(([v, label]) => (
            <label key={v}>
              <input type="radio" name="tpl-proxy" value={v} checked={form.proxyStrategy === v} onChange={() => set('proxyStrategy', v)} />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        {form.proxyStrategy === 'specific' && (
          <div className="row">
            <input
              className="input mono"
              aria-label="Proxy URL"
              placeholder="http://user:pass@host:port"
              value={form.proxy}
              onChange={(e) => set('proxy', e.target.value)}
            />
            <span className="hint">
              http, https, socks4 or socks5. One profile only.{form.proxy.includes(':***@') && ' *** keeps the saved password.'}
            </span>
          </div>
        )}
        {form.proxyStrategy === 'unused-ok' && <span className="hint">From the proxy library, checked and working; the plain pool when there is none.</span>}

        <fieldset className="tpl-radios">
          <legend>Fingerprint</legend>
          {FPT_OPTIONS.map(([v, label]) => (
            <label key={v}>
              <input type="radio" name="tpl-fpt" value={v} checked={form.fptStrategy === v} onChange={() => set('fptStrategy', v)} />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        {form.fptStrategy === 'specific' && (
          <div className="row">
            <Picker
              block
              label="Fingerprint file"
              value={form.fingerprintFile}
              onChange={(v) => set('fingerprintFile', v)}
              options={[
                { value: '', label: 'Choose', hint: `${fptOptions.length} free` },
                ...fptOptions.map((f) => {
                  const m = fptMeta(f);
                  return {
                    value: f.file,
                    label: `${m.shortId} · ${m.country || '—'} · ${f.platform}`,
                    hint: f.isAssigned ? 'bound' : undefined,
                    title: f.file,
                  };
                }),
              ]}
            />
            <span className="hint">One profile only.</span>
          </div>
        )}

        <label className="switch">
          <input
            type="checkbox"
            checked={form.isDefault}
            disabled={Boolean(template?.isDefault)}
            onChange={(e) => set('isDefault', e.target.checked)}
          />
          Use for Quick profile{template?.isDefault ? ' (make another template the default to change this)' : ''}
        </label>
      </form>
    </Modal>
  );
};
