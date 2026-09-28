import React, { useMemo, useState } from 'react';
import { ArrowLeft, CircleAlert, Cookie, Download, FileArchive, FileSpreadsheet, LoaderCircle, Upload, X } from 'lucide-react';
import { useApp } from '../../app-context';
import { Modal, Pager, Picker, useStored, useUI, usePaged } from '../../ui';
import { api } from './api';
import {
  DELIMITERS,
  FIELDS,
  assignUnique,
  batches,
  cookieFormat,
  detectDelimiter,
  fieldLabel,
  fmtBytes,
  guessFromHeader,
  guessFromSample,
  idOf,
  isWebUrl,
  looksLikeHeader,
  nameError,
  parseDelimited,
  pickFiles,
  plural,
  proxyError,
  readText,
  stripExt,
  type Delimiter,
} from './csv';
import { openDialog, useOpenDialog } from './store';
import type { Column, Field, ImportResult, ImportRow, PickedFile, Skipped } from './types';

/** Mounted once through `profilesAbove`; renders whichever dialog the menus asked for. */
export const Dialogs: React.FC = () => {
  const d = useOpenDialog();
  const close = () => openDialog(null);
  if (!d) return null;
  if (d.kind === 'wizard') return <ImportWizard onClose={close} />;
  if (d.kind === 'cookies') return <CookieFiles onClose={close} />;
  if (d.kind === 'smp') return <SmpImport onClose={close} />;
  return <ExportDialog ids={d.ids} onClose={close} />;
};

/* ---------------- shared pieces ---------------- */

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Names the server would refuse because a profile (or a trashed one) already holds them. */
function useTaken() {
  const { sessions, trash } = useApp();
  return useMemo(() => {
    const m = new Map<string, string>();
    for (const t of trash) m.set(t.id.toLowerCase(), 'in the trash');
    for (const s of sessions) m.set(s.id.toLowerCase(), 'already exists');
    return m;
  }, [sessions, trash]);
}

/** Refreshes the panel and reports; returns true when nothing was skipped. */
function useFinish() {
  const { refresh } = useApp();
  const { toast } = useUI();
  return (created: number, skipped: number) => {
    void refresh.all();
    if (!created && skipped) toast('error', `Nothing imported · ${plural(skipped, 'skipped item')}`);
    else toast(skipped ? 'info' : 'success', `Imported ${plural(created, 'profile')}${skipped ? ` · ${skipped} skipped` : ''}`);
    return !skipped;
  };
}

/** A button you can also drop files on; Enter or a click opens the picker. */
const DropZone: React.FC<{
  accept: string;
  multiple?: boolean;
  text: string;
  hint: string;
  icon: React.ReactNode;
  onFiles: (files: File[]) => void;
}> = ({ accept, multiple = false, text, hint, icon, onFiles }) => {
  const [over, setOver] = useState(false);
  const exts = accept.split(',').map((s) => s.trim().toLowerCase());
  const take = (files: File[]) => {
    const ok = files.filter((f) => exts.some((x) => f.name.toLowerCase().endsWith(x)));
    if (ok.length) onFiles(multiple ? ok : ok.slice(0, 1));
  };
  return (
    <button
      type="button"
      className="ie-drop"
      data-over={over || undefined}
      onClick={async () => take(await pickFiles(accept, multiple))}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        take([...e.dataTransfer.files]);
      }}
    >
      {icon}
      <span>{text}</span>
      <span className="hint">{hint}</span>
    </button>
  );
};

const SkipList: React.FC<{ items: Array<{ name: string; error: string }> }> = ({ items }) =>
  items.length ? (
    <div className="ie-skips" role="alert">
      <div className="row-label">
        <CircleAlert size={13} /> {plural(items.length, 'item')} skipped
      </div>
      <ul>
        {items.map((s, i) => (
          <li key={i}>
            <b>{s.name}</b> <span>{s.error}</span>
          </li>
        ))}
      </ul>
    </div>
  ) : null;

const Busy: React.FC<{ text: string }> = ({ text }) => (
  <>
    <LoaderCircle size={13} className="spin" /> {text}
  </>
);

/* ---------------- import wizard ---------------- */

type Draft = ImportRow & { key: number };
type RowErrors = Partial<Record<Field, string>>;

const STEPS = ['File', 'Columns', 'Review'];

function validate(rows: Draft[], taken: Map<string, string>): Map<number, RowErrors> {
  const seen = new Map<string, number>();
  for (const r of rows) {
    const id = idOf(r.name).toLowerCase();
    if (id) seen.set(id, (seen.get(id) || 0) + 1);
  }
  const out = new Map<number, RowErrors>();
  for (const r of rows) {
    const e: RowErrors = {};
    const id = idOf(r.name).toLowerCase();
    const n = nameError(r.name) || taken.get(id) || ((seen.get(id) || 0) > 1 ? 'repeated in this file' : null);
    if (n) e.name = n;
    const p = r.proxy?.trim() && proxyError(r.proxy);
    if (p) e.proxy = p;
    const urls = (r.startUrl || '').split(/\s+/).filter(Boolean);
    if (urls.length > 10 || !urls.every(isWebUrl)) e.startUrl = 'up to 10 http(s) URLs';
    if (r.cookies?.trim() && !cookieFormat(r.cookies)) e.cookies = 'not a JSON array or cookies.txt';
    if (Object.keys(e).length) out.set(r.key, e);
  }
  return out;
}

const ImportWizard: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { proxies, fingerprints } = useApp();
  const { toast } = useUI();
  const taken = useTaken();
  const finish = useFinish();

  const [step, setStep] = useState(0);
  const [file, setFile] = useState<PickedFile | null>(null);
  const [delim, setDelim] = useState<Delimiter>(',');
  const [header, setHeader] = useState(true);
  const [start, setStart] = useState(1);
  const [mapping, setMapping] = useState<Column[]>([]);
  const [rows, setRows] = useState<Draft[]>([]);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [pageSize, setPageSize] = useStored('importexport.pageSize', 50);

  const parsed = useMemo(() => (file ? parseDelimited(file.text, delim) : []), [file, delim]);
  const body = parsed.slice(Math.max(0, start - 1));
  const head = header ? body[0] : undefined;
  const data = header ? body.slice(1) : body;
  const width = Math.max(0, ...body.slice(0, 200).map((r) => r.length));

  const load = async (files: File[]) => {
    try {
      const [f] = await readText(files);
      const text = f.text.replace(/^﻿/, '');
      const d = detectDelimiter(text);
      const first = parseDelimited(text.slice(0, 20000), d)[0] || [];
      setFile({ ...f, text });
      setDelim(d);
      setHeader(looksLikeHeader(first));
      setStart(1);
    } catch (e) {
      toast('error', `Could not read the file: ${errMsg(e)}`);
    }
  };

  const toColumns = () => {
    const guesses = Array.from({ length: width }, (_, j) =>
      head && guessFromHeader(head[j] || '') !== 'ignore'
        ? guessFromHeader(head[j] || '')
        : guessFromSample(data.slice(0, 50).map((r) => r[j] || ''))
    );
    // Keep the user's mapping when they only stepped back to look.
    if (mapping.length !== width) setMapping(assignUnique(guesses));
    setStep(1);
  };

  const setColumn = (j: number, v: Column) =>
    setMapping((m) => m.map((c, i) => (i === j ? v : v !== 'ignore' && c === v ? 'ignore' : c)));

  const toReview = () => {
    setRows(
      data.map((cells, i) => {
        const r: Draft = { key: i, name: '' };
        mapping.forEach((f, j) => {
          if (f !== 'ignore') (r as Record<Field, string>)[f] = cells[j] ?? '';
        });
        return r;
      })
    );
    setOnlyErrors(false);
    setStep(2);
  };

  const errors = useMemo(() => validate(rows, taken), [rows, taken]);
  const valid = rows.filter((r) => !errors.has(r.key));
  const shown = onlyErrors ? rows.filter((r) => errors.has(r.key)) : rows;
  const paged = usePaged(shown, pageSize, String(onlyErrors));
  // Review columns follow the field order, not the file's.
  const cols = FIELDS.map(([f]) => f).filter((f): f is Field => f !== 'ignore' && mapping.includes(f));

  const needProxies = valid.filter((r) => !r.proxy?.trim()).length;
  const freeProxies = proxies.filter((p) => !p.isAssigned).length;
  const freeFpts = fingerprints.filter((f) => !f.isAssigned && !f.error).length;

  const edit = (key: number, f: Field, v: string) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, [f]: v } : r)));
  const remove = (key: number) => setRows((rs) => rs.filter((r) => r.key !== key));

  const create = async () => {
    const out = valid.map((r) => {
      const clean: ImportRow = { name: r.name.trim() };
      for (const f of cols) if (f !== 'name' && r[f]?.trim()) clean[f] = r[f]!.trim();
      return clean;
    });
    let created = 0;
    const skipped: Skipped[] = [];
    let done = 0;
    try {
      for (const batch of batches(out)) {
        setBusy(`Creating ${done + 1}–${done + batch.length} of ${out.length}…`);
        try {
          const res = await api.importProfiles(batch);
          created += res.created;
          skipped.push(...res.skipped);
        } catch (e) {
          skipped.push(...batch.map((r) => ({ name: r.name, error: errMsg(e) })));
        }
        done += batch.length;
      }
    } finally {
      setBusy(null);
    }
    if (finish(created, skipped.length)) onClose();
    else setResult({ created, skipped });
  };

  if (result)
    return (
      <Modal title="Import profiles" width={720} onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
        <p>
          Created <b className="num-inline">{result.created}</b> · skipped <b className="num-inline">{result.skipped.length}</b>
        </p>
        <SkipList items={result.skipped} />
      </Modal>
    );

  const footer = (
    <>
      {step > 0 && (
        <button className="btn ghost ie-back" onClick={() => setStep(step - 1)} disabled={!!busy}>
          <ArrowLeft size={13} /> Back
        </button>
      )}
      <button className="btn" onClick={onClose} disabled={!!busy}>
        Cancel
      </button>
      {step === 0 && (
        <button className="btn primary" onClick={toColumns} disabled={!data.length || !width}>
          Next
        </button>
      )}
      {step === 1 && (
        <button className="btn primary" onClick={toReview} disabled={!mapping.includes('name')}>
          Next
        </button>
      )}
      {step === 2 && (
        <button className="btn primary" onClick={create} disabled={!valid.length || !!busy}>
          {busy ? <Busy text={busy} /> : `Create ${valid.length}`}
        </button>
      )}
    </>
  );

  return (
    <Modal title="Import profiles" width={720} onClose={() => !busy && onClose()} footer={footer}>
      <ol className="ie-steps" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={i === step ? 'step' : undefined} data-done={i < step || undefined}>
            <span className="n">{i + 1}</span> {s}
          </li>
        ))}
      </ol>

      {step === 0 &&
        (!file ? (
          <DropZone
            accept=".csv,.txt,.tsv"
            text="Drop a .csv or .txt file, or choose one"
            hint="One profile per row. You map the columns next."
            icon={<FileSpreadsheet size={22} />}
            onFiles={load}
          />
        ) : (
          <>
            <div className="ie-file">
              <FileSpreadsheet size={15} />
              <span className="grow ie-ellipsis" title={file.name}>
                {file.name}
              </span>
              <span className="hint num-inline">
                {plural(data.length, 'row')} · {fmtBytes(file.bytes)}
              </span>
              <button className="btn xs" onClick={async () => load(await pickFiles('.csv,.txt,.tsv'))}>
                Replace
              </button>
            </div>
            <div className="ie-opts">
              <div className="seg" role="group" aria-label="Delimiter">
                {DELIMITERS.map(([d, label]) => (
                  <button key={label} aria-pressed={delim === d} onClick={() => setDelim(d)}>
                    {label}
                  </button>
                ))}
              </div>
              <label className="switch">
                <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} />
                First row is a header
              </label>
              <label className="inline ie-start">
                <span className="row-label">Start at row</span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={Math.max(1, parsed.length)}
                  value={start}
                  onChange={(e) => setStart(Math.min(Math.max(1, Math.floor(Number(e.target.value)) || 1), Math.max(1, parsed.length)))}
                />
              </label>
            </div>
            {body.length ? (
              <div className="table-wrap ie-raw">
                <div className="table-scroll">
                  <table className="tbl">
                    <tbody>
                      {body.slice(0, 6).map((r, i) => (
                        <tr key={i} data-head={(header && i === 0) || undefined}>
                          <td className="dim num tight">{start + i}</td>
                          {Array.from({ length: width }, (_, j) => (
                            <td key={j} className="ie-ellipsis" title={r[j]}>
                              {r[j]}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <p className="hint">No rows from here on.</p>
            )}
          </>
        ))}

      {step === 1 && (
        <>
          <p className="hint">Pick what each column holds. One column must be the name.</p>
          <div className="ie-map">
            {mapping.map((c, j) => {
              const samples = data
                .slice(0, 50)
                .map((r) => r[j])
                .filter(Boolean)
                .slice(0, 3);
              return (
                <div key={j} className="ie-map-row" data-ignored={c === 'ignore' || undefined}>
                  <div className="ie-map-name">
                    <b className="ie-ellipsis">{head?.[j] || `Column ${j + 1}`}</b>
                    <span className="hint ie-ellipsis mono">{samples.join(' · ') || 'empty'}</span>
                  </div>
                  <Picker
                    block
                    value={c}
                    onChange={(v) => setColumn(j, v as Column)}
                    label={`${head?.[j] || `Column ${j + 1}`} holds`}
                    options={FIELDS.map(([f, label]) => ({ value: f, label }))}
                  />
                </div>
              );
            })}
          </div>
          {!mapping.includes('name') && (
            <div className="alert">
              <CircleAlert size={14} /> Map one column to Name / email.
            </div>
          )}
        </>
      )}

      {step === 2 && (
        <>
          <div className="ie-opts">
            <div className="seg" role="group" aria-label="Show">
              <button aria-pressed={!onlyErrors} onClick={() => setOnlyErrors(false)}>
                All <span className="n">{rows.length}</span>
              </button>
              <button aria-pressed={onlyErrors} onClick={() => setOnlyErrors(true)} disabled={!errors.size && !onlyErrors}>
                Errors {errors.size > 0 && <span className="n">{errors.size}</span>}
              </button>
            </div>
            <span className="hint">
              {errors.size ? `${plural(errors.size, 'row')} with errors will be left out. Fix them inline or remove them.` : 'Every row is valid.'}
            </span>
          </div>
          {(needProxies > freeProxies || valid.length > freeFpts) && valid.length > 0 && (
            <div className="alert ie-warn">
              <CircleAlert size={14} />
              {needProxies > freeProxies
                ? `${plural(needProxies, 'row')} take a proxy from the library, which has ${freeProxies} free.`
                : `Each profile takes a fingerprint; ${freeFpts} are free.`}{' '}
              The rest will be skipped.
            </div>
          )}
          {shown.length ? (
            <div className="table-wrap ie-review">
              <div className="table-scroll">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th className="num tight">#</th>
                      {cols.map((f) => (
                        <th key={f}>{fieldLabel(f)}</th>
                      ))}
                      <th className="tight">
                        <span className="sr-only">Remove</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {paged.slice.map((r) => {
                      const e = errors.get(r.key);
                      return (
                        <tr key={r.key} data-invalid={e ? true : undefined}>
                          <td className="num tight dim">{r.key + 1}</td>
                          {cols.map((f) => (
                            <td key={f} className={`ie-cell-${f}`}>
                              {f === 'cookies' ? (
                                <span className={`badge${e?.cookies ? ' error' : ''}`} title={e?.cookies}>
                                  {!r.cookies?.trim() ? '—' : e?.cookies ? 'Invalid' : cookieFormat(r.cookies) === 'json' ? 'JSON' : 'cookies.txt'}
                                </span>
                              ) : (
                                <input
                                  className="input"
                                  value={r[f] ?? ''}
                                  aria-label={`Row ${r.key + 1} ${fieldLabel(f)}`}
                                  aria-invalid={e?.[f] ? true : undefined}
                                  title={e?.[f]}
                                  onChange={(ev) => edit(r.key, f, ev.target.value)}
                                />
                              )}
                              {e?.[f] && f !== 'cookies' && <span className="ie-err">{e[f]}</span>}
                            </td>
                          ))}
                          <td className="tight">
                            <button className="icon-btn xs" onClick={() => remove(r.key)} aria-label={`Remove row ${r.key + 1}`}>
                              <X size={13} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {shown.length > 25 && <Pager paged={paged} total={shown.length} noun="rows" pageSize={pageSize} onPageSize={setPageSize} />}
            </div>
          ) : (
            <p className="hint">{rows.length ? 'No rows with errors.' : 'No rows left. Go back to pick another file.'}</p>
          )}
        </>
      )}
    </Modal>
  );
};

/* ---------------- profiles from cookie files ---------------- */

const MAX_COOKIE_FILE = 8 * 1024 * 1024; // the server takes 10 MB of JSON per request

const CookieFiles: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { toast } = useUI();
  const taken = useTaken();
  const finish = useFinish();
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<Skipped[] | null>(null);

  const add = async (picked: File[]) => {
    try {
      const read = await readText(picked);
      setFiles((cur) => [...cur.filter((c) => !read.some((r) => r.name === c.name)), ...read]);
    } catch (e) {
      toast('error', `Could not read the files: ${errMsg(e)}`);
    }
  };

  const errors = useMemo(() => {
    const count = new Map<string, number>();
    for (const f of files) count.set(idOf(stripExt(f.name)).toLowerCase(), (count.get(idOf(stripExt(f.name)).toLowerCase()) || 0) + 1);
    return files.map((f) => {
      const id = idOf(stripExt(f.name)).toLowerCase();
      if (f.bytes > MAX_COOKIE_FILE) return 'larger than 8 MB';
      if (!f.text.trim()) return 'file is empty';
      if (!cookieFormat(f.text)) return 'not a JSON array or cookies.txt';
      return nameError(stripExt(f.name)) || taken.get(id) || ((count.get(id) || 0) > 1 ? 'same name as another file' : null);
    });
  }, [files, taken]);
  const ready = files.filter((_, i) => !errors[i]);

  const create = async () => {
    let created = 0;
    const skip: Skipped[] = [];
    let done = 0;
    try {
      for (const batch of batches(ready.map(({ name, text }) => ({ name, text })))) {
        setBusy(`Creating ${done + 1}–${done + batch.length} of ${ready.length}…`);
        try {
          const res = await api.importCookieFiles(batch);
          created += res.created;
          skip.push(...res.skipped);
        } catch (e) {
          skip.push(...batch.map((f) => ({ name: stripExt(f.name), error: errMsg(e) })));
        }
        done += batch.length;
      }
    } finally {
      setBusy(null);
    }
    if (finish(created, skip.length)) onClose();
    else setSkipped(skip);
  };

  return (
    <Modal
      title="Profiles from cookie files"
      width={620}
      onClose={() => !busy && onClose()}
      footer={
        skipped ? (
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button className="btn" onClick={onClose} disabled={!!busy}>
              Cancel
            </button>
            <button className="btn primary" onClick={create} disabled={!ready.length || !!busy}>
              {busy ? <Busy text={busy} /> : `Create ${ready.length}`}
            </button>
          </>
        )
      }
    >
      {skipped ? (
        <SkipList items={skipped} />
      ) : (
        <>
          <DropZone
            accept=".json,.txt"
            multiple
            text={files.length ? 'Add more files' : 'Drop cookie files, or choose them'}
            hint="JSON arrays or Netscape cookies.txt. One profile per file, named after it."
            icon={<Cookie size={files.length ? 16 : 22} />}
            onFiles={add}
          />
          {files.length > 0 && (
            <div className="table-wrap ie-list">
              <div className="table-scroll">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Profile</th>
                      <th className="tight">Format</th>
                      <th className="num tight">Size</th>
                      <th className="tight">
                        <span className="sr-only">Remove</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {files.map((f, i) => (
                      <tr key={f.name} data-invalid={errors[i] ? true : undefined}>
                        <td>
                          <div className="name ie-ellipsis">{stripExt(f.name)}</div>
                          {errors[i] ? <span className="ie-err">{errors[i]}</span> : <div className="sub ie-ellipsis">{f.name}</div>}
                        </td>
                        <td className="tight">
                          <span className="badge">{cookieFormat(f.text) === 'json' ? 'JSON' : cookieFormat(f.text) ? 'cookies.txt' : '—'}</span>
                        </td>
                        <td className="num tight mono">{fmtBytes(f.bytes)}</td>
                        <td className="tight">
                          <button className="icon-btn xs" onClick={() => setFiles((cur) => cur.filter((x) => x !== f))} aria-label={`Remove ${f.name}`}>
                            <X size={13} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
  );
};

/* ---------------- .smp import ---------------- */

type SmpItem = { file: File; state: 'ready' | 'busy' | 'done' | 'error'; note?: string };

const SmpImport: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const finish = useFinish();
  const [items, setItems] = useState<SmpItem[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);

  const set = (i: number, patch: Partial<SmpItem>) => setItems((cur) => cur.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const run = async () => {
    setRunning(true);
    let created = 0;
    let skipped = 0;
    for (let i = 0; i < items.length; i++) {
      if (items[i].state === 'done') continue;
      set(i, { state: 'busy', note: undefined });
      try {
        const res = await api.importSmp(items[i].file);
        created += res.created.length;
        skipped += res.skipped.length;
        if (res.created.length) set(i, { state: 'done', note: `→ ${res.created.join(', ')}` });
        else set(i, { state: 'error', note: res.skipped[0]?.error || 'not imported' });
      } catch (e) {
        skipped++;
        set(i, { state: 'error', note: errMsg(e) });
      }
    }
    setRunning(false);
    setDone(true);
    if (finish(created, skipped)) onClose();
  };

  const pending = items.filter((x) => x.state !== 'done').length;
  return (
    <Modal
      title="Import .smp"
      width={560}
      onClose={() => !running && onClose()}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={running}>
            {done ? 'Close' : 'Cancel'}
          </button>
          <button className="btn primary" onClick={run} disabled={!pending || running}>
            {running ? <Busy text="Importing…" /> : done && pending ? `Retry ${pending}` : `Import ${pending}`}
          </button>
        </>
      }
    >
      {!running && !done && (
        <DropZone
          accept=".smp,.zip"
          multiple
          text={items.length ? 'Add more files' : 'Drop .smp files, or choose them'}
          hint="Exported profiles with their cookies and fingerprint. A taken name gets -2, -3 …"
          icon={<FileArchive size={items.length ? 16 : 22} />}
          onFiles={(files) =>
            setItems((cur) => [...cur.filter((c) => !files.some((f) => f.name === c.file.name)), ...files.map((file) => ({ file, state: 'ready' as const }))])
          }
        />
      )}
      {items.length > 0 && (
        <ul className="ie-files">
          {items.map((x) => (
            <li key={x.file.name} data-state={x.state}>
              <FileArchive size={14} />
              <div className="grow ie-min">
                <div className="ie-ellipsis">{x.file.name}</div>
                {x.note && <div className={x.state === 'error' ? 'ie-err' : 'sub ie-ellipsis'}>{x.note}</div>}
              </div>
              <span className="hint mono">{fmtBytes(x.file.size)}</span>
              {x.state === 'busy' ? (
                <LoaderCircle size={14} className="spin" aria-label="Importing" />
              ) : x.state === 'done' ? (
                <span className="badge live">Imported</span>
              ) : x.state === 'error' ? (
                <span className="badge error">Failed</span>
              ) : (
                <button className="icon-btn xs" onClick={() => setItems((cur) => cur.filter((y) => y !== x))} disabled={running} aria-label={`Remove ${x.file.name}`}>
                  <X size={13} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
};

/* ---------------- export ---------------- */

const download = (url: string) => {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
};

const ExportDialog: React.FC<{ ids: string[]; onClose: () => void }> = ({ ids, onClose }) => {
  const { sessions } = useApp();
  const { toast } = useUI();
  const [withData, setWithData] = useState(false);
  const [withPassword, setWithPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<Array<{ id: string; url: string; bytes: number }> | null>(null);
  const [skipped, setSkipped] = useState<Skipped[]>([]);

  const chosen = sessions.filter((s) => ids.includes(s.id));
  const running = chosen.filter((s) => s.status === 'live' || s.status === 'queued');
  const ready = chosen.filter((s) => !running.includes(s));

  const run = async () => {
    setBusy(true);
    try {
      const res = await api.exportSessions(
        ready.map((s) => s.id),
        { includeBrowserData: withData, includeProxyPassword: withPassword }
      );
      setFiles(res.files);
      setSkipped(res.skipped.map((s) => ({ name: s.id, error: s.error })));
      // One click per file; the browser may ask once to allow several downloads.
      res.files.forEach((f, i) => setTimeout(() => download(f.url), i * 250));
      if (res.files.length)
        toast(res.skipped.length ? 'info' : 'success', `Exported ${plural(res.files.length, 'profile')}${res.skipped.length ? ` · ${res.skipped.length} skipped` : ''}`);
      else toast('error', `Nothing exported${res.skipped[0] ? ` · ${res.skipped[0].error}` : ''}`);
    } catch (e) {
      toast('error', `Export failed: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const title = chosen.length === 1 ? `Export ${chosen[0].id}` : `Export ${plural(chosen.length, 'profile')}`;

  if (files)
    return (
      <Modal title={title} width={520} onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
        {files.length > 0 && (
          <ul className="ie-files">
            {files.map((f) => (
              <li key={f.id}>
                <FileArchive size={14} />
                <span className="grow ie-ellipsis">{f.url.split('/').pop()}</span>
                <span className="hint mono">{fmtBytes(f.bytes)}</span>
                <a className="btn xs" href={f.url} download aria-label={`Download ${f.id} again`}>
                  <Download size={12} /> Download
                </a>
              </li>
            ))}
          </ul>
        )}
        <SkipList items={skipped} />
      </Modal>
    );

  return (
    <Modal
      title={title}
      width={520}
      onClose={() => !busy && onClose()}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={run} disabled={!ready.length || busy}>
            {busy ? <Busy text="Exporting…" /> : <><Upload size={13} /> Export {ready.length}</>}
          </button>
        </>
      }
    >
      <p className="hint">Each profile becomes one .smp file with its settings, cookies and fingerprint.</p>
      <label className="switch ie-switch">
        <input type="checkbox" checked={withData} onChange={(e) => setWithData(e.target.checked)} />
        <span>
          Include browser data
          <span className="hint">History, storage and logins. Files get much larger.</span>
        </span>
      </label>
      <label className="switch ie-switch">
        <input type="checkbox" checked={withPassword} onChange={(e) => setWithPassword(e.target.checked)} />
        <span>
          Include proxy password
          <span className="hint">Anyone with the file can use the proxy.</span>
        </span>
      </label>
      {running.length > 0 && (
        <div className="alert ie-warn">
          <CircleAlert size={14} />
          <span>
            {running.length === chosen.length ? 'Running, stop first: ' : `Skipped while running: `}
            {running.map((s) => s.id).join(', ')}
          </span>
        </div>
      )}
      {!chosen.length && <p className="hint">These profiles no longer exist.</p>}
    </Modal>
  );
};
