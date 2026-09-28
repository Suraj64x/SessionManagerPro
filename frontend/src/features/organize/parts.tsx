import React, { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Filter, Folder, FolderPlus, Loader2, MoreHorizontal, Pencil, Trash2, X } from 'lucide-react';
import type { SessionRecord } from '../../types';
import { CheckBox, Menu, Picker, TagInput, tagTone, useDialog } from '../../ui';
import {
  COLUMNS,
  NO_FILTERS,
  filterCount,
  sameName,
  anchorOf,
  statusOf,
  toggleIn,
  type Anchor,
  type ColumnId,
  type Filters,
  type Status,
} from './model';
import { layoutPoint, viewport } from '../../zoom';

/* ------------------------------------------------------------------ *
 * Popover — fixed at a point, focus-trapped, closes on outside click, Escape, scroll
 * ------------------------------------------------------------------ */

export const Popover: React.FC<{
  at: Anchor;
  onClose: () => void;
  label: string;
  /** `menu` for item lists (the shared menu styles apply), `org-pop` for forms. */
  className?: 'menu' | 'org-pop';
  width?: number;
  children: React.ReactNode;
}> = ({ at, onClose, label, className = 'org-pop', width, children }) => {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  // Blur first: a TagInput commits its draft on blur, and the caller reads it on close.
  const dismiss = () => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    closeRef.current();
  };
  useDialog(ref, dismiss);
  useEffect(() => {
    const outside = (e: Event) => !ref.current?.contains(e.target as Node) && dismiss();
    window.addEventListener('mousedown', outside);
    window.addEventListener('scroll', outside, true);
    window.addEventListener('resize', outside);
    return () => {
      window.removeEventListener('mousedown', outside);
      window.removeEventListener('scroll', outside, true);
      window.removeEventListener('resize', outside);
    };
  }, []);
  const w = width || 240;
  const below = at.y + (at.h || 0);
  const vp = viewport();
  const flip = vp.h - below < 300 && at.y > 300;
  const style: React.CSSProperties = {
    position: 'fixed',
    zIndex: 60,
    width,
    left: Math.max(8, Math.min(at.x, vp.w - w - 8)),
    right: 'auto',
    top: flip ? 'auto' : below + 6,
    bottom: flip ? vp.h - at.y + 6 : 'auto',
  };
  return (
    <div ref={ref} className={className} role="dialog" aria-label={label} style={style} onContextMenu={(e) => e.preventDefault()}>
      {children}
    </div>
  );
};

/* ------------------------------------------------------------------ *
 * Status chip + picker
 * ------------------------------------------------------------------ */

const NO_STATUS_COLOR = '#94a3b8';

export const StatusChip: React.FC<{ statuses: Status[]; label?: string }> = ({ statuses, label }) => {
  const st = statusOf(statuses, label);
  if (!label) return <span className="status-chip none">—</span>;
  return (
    <span className="status-chip" style={{ '--c': st?.color || NO_STATUS_COLOR } as React.CSSProperties} title={st ? undefined : 'Not in the status list'}>
      <span className="dot" />
      <span>{st?.name || label}</span>
    </span>
  );
};

/** The chip as a button: click to pick a status, or filter by the current one. */
export const StatusPicker: React.FC<{
  s: SessionRecord;
  statuses: Status[];
  busy?: boolean;
  onSet: (label: string) => void;
  onFilter: (name: string) => void;
}> = ({ s, statuses, busy, onSet, onFilter }) => {
  const st = statusOf(statuses, s.label);
  const color = st?.color || NO_STATUS_COLOR;
  return (
    <Menu
      fixed
      left
      trigger={(t) => (
        <button
          className={`status-chip${s.label ? '' : ' none'}`}
          style={{ '--c': color } as React.CSSProperties}
          aria-label={`Status of ${s.id}: ${st?.name || s.label || 'none'}. Change`}
          aria-busy={busy || undefined}
          title={st || !s.label ? undefined : 'Not in the status list'}
          {...t}
        >
          {s.label && <span className="dot" />}
          <span>{st?.name || s.label || '—'}</span>
        </button>
      )}
    >
      {(close) => (
        <>
          {statuses.map((o) => {
            const on = sameName(o.name, s.label);
            return (
              <button key={o.name} aria-pressed={on} onClick={() => (close(), !on && onSet(o.name))}>
                <span className="tick">{on && <Check size={12} />}</span>
                <span className="status-dot" style={{ '--c': o.color } as React.CSSProperties} />
                {o.name}
              </button>
            );
          })}
          <button aria-pressed={!s.label} onClick={() => (close(), s.label && onSet(''))}>
            <span className="tick">{!s.label && <Check size={12} />}</span>
            No status
          </button>
          {st && (
            <>
              <hr />
              <button onClick={() => (close(), onFilter(st.name))}>
                <Filter size={12} /> Filter by {st.name}
              </button>
            </>
          )}
        </>
      )}
    </Menu>
  );
};

/* ------------------------------------------------------------------ *
 * Inline editors: tags and notes
 * ------------------------------------------------------------------ */

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Saves on close (outside click or Escape) when the list changed. */
export const TagsPopover: React.FC<{
  s: SessionRecord;
  at: Anchor;
  allTags: string[];
  onClose: () => void;
  onSave: (tags: string[]) => void;
}> = ({ s, at, allTags, onClose, onSave }) => {
  const [tags, setTags] = useState<string[]>(s.tags || []);
  // The latest list, read on close: the blur that commits a draft lands in the same tick.
  const latest = useRef(tags);
  const done = () => {
    if (!sameList(latest.current, s.tags || [])) onSave(latest.current);
    onClose();
  };
  return (
    <Popover at={at} onClose={done} label={`Tags for ${s.id}`} width={300}>
      <TagInput
        id={`tags-${s.id}`}
        value={tags}
        onChange={(next) => {
          latest.current = next;
          setTags(next);
        }}
        suggestions={allTags}
        label={`Tags for ${s.id}`}
      />
      <span className="hint">Enter or comma adds. Saved when this closes.</span>
    </Popover>
  );
};

/** Enter saves, Shift+Enter breaks a line, Escape cancels. */
export const NotesPopover: React.FC<{
  s: SessionRecord;
  at: Anchor;
  onClose: () => void;
  onSave: (notes: string) => Promise<void>;
}> = ({ s, at, onClose, onSave }) => {
  const [text, setText] = useState(s.notes || '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (text === (s.notes || '')) return onClose();
    setBusy(true);
    await onSave(text);
    onClose();
  };
  return (
    <Popover at={at} onClose={onClose} label={`Notes for ${s.id}`} width={320}>
      <textarea
        className="input"
        rows={3}
        value={text}
        maxLength={2000}
        aria-label={`Notes for ${s.id}`}
        placeholder="Notes"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            save();
          }
        }}
      />
      <div className="inline">
        <span className="hint grow">Enter saves · Esc cancels</span>
        <button className="btn xs primary" onClick={save} disabled={busy}>
          {busy && <Loader2 size={11} className="spin" />} Save
        </button>
      </div>
    </Popover>
  );
};

/* ------------------------------------------------------------------ *
 * Filter menu
 * ------------------------------------------------------------------ */

export const FilterMenu: React.FC<{
  statuses: Status[];
  allTags: string[];
  folders: string[];
  filters: Filters;
  onFilters: (f: Filters) => void;
  folder: string;
  onFolder: (f: string) => void;
}> = ({ statuses, allTags, folders, filters: f, onFilters, folder, onFolder }) => {
  const n = filterCount(f) + Number(Boolean(folder));
  const set = (patch: Partial<Filters>) => onFilters({ ...f, ...patch });
  const tick = (on: boolean) => <span className="tick">{on && <Check size={12} />}</span>;
  return (
    <Menu
      left
      trigger={(t) => (
        <button className="btn" {...t}>
          <Filter size={13} /> Filter
          {n > 0 && <span className="org-filter-count">{n}</span>}
        </button>
      )}
    >
      {(close) => (
        <div className="org-filter">
          <div className="menu-head">Status</div>
          {statuses.map((st) => {
            const on = f.statuses.some((x) => sameName(x, st.name));
            return (
              <button key={st.name} aria-pressed={on} onClick={() => set({ statuses: toggleIn(f.statuses, st.name) })}>
                {tick(on)}
                <span className="status-dot" style={{ '--c': st.color } as React.CSSProperties} />
                {st.name}
              </button>
            );
          })}
          <button aria-pressed={f.noStatus} onClick={() => set({ noStatus: !f.noStatus })}>
            {tick(f.noStatus)}No status
          </button>
          <hr />
          <div className="menu-head">Tags</div>
          {allTags.length > 1 && (
            <button onClick={() => set({ tagMode: f.tagMode === 'any' ? 'all' : 'any' })} aria-label={`Match ${f.tagMode} selected tag. Switch`}>
              <span className="tick" />
              Match {f.tagMode === 'any' ? 'any' : 'all'} · switch
            </button>
          )}
          {allTags.map((t) => {
            const on = f.tags.includes(t);
            return (
              <button key={t} aria-pressed={on} onClick={() => set({ tags: toggleIn(f.tags, t), noTags: false })}>
                {tick(on)}
                {t}
              </button>
            );
          })}
          <button aria-pressed={f.noTags} onClick={() => set({ noTags: !f.noTags, tags: [] })}>
            {tick(f.noTags)}No tags
          </button>
          {folders.length > 0 && (
            <>
              <hr />
              <div className="menu-head">Folder</div>
              <Picker
                label="Folder"
                value={folder}
                onChange={onFolder}
                options={[{ value: '', label: 'All folders' }, ...folders.map((fo) => ({ value: fo, label: fo }))]}
              />
            </>
          )}
          {n > 0 && (
            <>
              <hr />
              <button onClick={() => (onFilters(NO_FILTERS), onFolder(''), close())}>
                <X size={12} /> Clear filters
              </button>
            </>
          )}
        </div>
      )}
    </Menu>
  );
};

/** Removable chips for the active filters, next to the Filter button. */
export const FilterChips: React.FC<{ statuses: Status[]; filters: Filters; onFilters: (f: Filters) => void }> = ({
  statuses,
  filters: f,
  onFilters,
}) => {
  if (!filterCount(f)) return null;
  const chip = (key: string, text: React.ReactNode, drop: () => void, label: string) => (
    <span key={key} className={`chip ${tagTone(String(key))}`}>
      {text}
      <button onClick={drop} aria-label={`Remove filter ${label}`}>
        <X size={10} />
      </button>
    </span>
  );
  return (
    <span className="org-facets">
      {f.statuses.map((n) =>
        chip(
          `s-${n}`,
          <>
            <span className="status-dot" style={{ '--c': statusOf(statuses, n)?.color || NO_STATUS_COLOR } as React.CSSProperties} />
            {n}
          </>,
          () => onFilters({ ...f, statuses: f.statuses.filter((x) => x !== n) }),
          n
        )
      )}
      {f.noStatus && chip('nostatus', 'No status', () => onFilters({ ...f, noStatus: false }), 'no status')}
      {f.tags.map((t) => chip(`t-${t}`, `#${t}`, () => onFilters({ ...f, tags: f.tags.filter((x) => x !== t) }), t))}
      {f.noTags && chip('notags', 'No tags', () => onFilters({ ...f, noTags: false }), 'no tags')}
    </span>
  );
};

/* ------------------------------------------------------------------ *
 * Folder strip
 * ------------------------------------------------------------------ */

const MAX_TABS = 6; // ponytail: fixed cap, measure the strip if folders routinely exceed it

export const FolderStrip: React.FC<{
  folders: string[];
  counts: Map<string, number>;
  total: number;
  selected: string;
  onSelect: (folder: string) => void;
  onCreate: (name: string) => Promise<boolean>;
  onRename: (old: string, name: string) => Promise<boolean>;
  onDelete: (name: string) => void;
  /** Ids dropped on a tab; '' is the All tab (unfile). */
  onDrop: (ids: string[], folder: string) => void;
}> = ({ folders, counts, total, selected, onSelect, onCreate, onRename, onDelete, onDrop }) => {
  const [ctx, setCtx] = useState<{ folder: string; at: Anchor } | null>(null);
  const [edit, setEdit] = useState<{ folder: string | null; at: Anchor } | null>(null); // null folder = new
  const [over, setOver] = useState<string | null>(null);

  const shown = folders.slice(0, MAX_TABS);
  if (selected && !shown.includes(selected) && folders.includes(selected)) shown.push(selected);
  const more = folders.filter((f) => !shown.includes(f));

  const dropProps = (folder: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('text/plain')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (over !== folder) setOver(folder);
    },
    onDragLeave: () => setOver((o) => (o === folder ? null : o)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(null);
      const ids = e.dataTransfer.getData('text/plain').split('\n').filter(Boolean);
      if (ids.length) onDrop(ids, folder);
    },
  });

  const tab = (folder: string, label: string, count: number) => (
    <span key={folder || '*'} className={`org-tab${folder ? ' has-menu' : ''}${over === folder ? ' drop' : ''}`} {...dropProps(folder)}
      onContextMenu={folder ? (e) => (e.preventDefault(), setCtx({ folder, at: layoutPoint(e.clientX, e.clientY) })) : undefined}
    >
      <button role="tab" aria-selected={selected === folder} onClick={() => onSelect(folder)}>
        <span>{label}</span>
        <span className="n">{count}</span>
      </button>
      {folder && (
        <button
          className="icon-btn xs org-tab-more"
          aria-label={`Options for folder ${folder}`}
          onClick={(e) => setCtx({ folder, at: anchorOf(e.currentTarget) })}
        >
          <MoreHorizontal size={13} />
        </button>
      )}
    </span>
  );

  return (
    <div className="org-strip" role="tablist" aria-label="Folders">
      {tab('', 'All', total)}
      {shown.map((f) => tab(f, f, counts.get(f) || 0))}
      {more.length > 0 && (
        <Menu
          left
          trigger={(t) => (
            <button className="btn xs ghost" {...t}>
              More · {more.length}
            </button>
          )}
        >
          {(close) => (
            <>
              {more.map((f) => (
                <button key={f} onClick={() => (onSelect(f), close())} aria-selected={selected === f}>
                  <Folder size={12} /> {f} <span className="dim">{counts.get(f) || 0}</span>
                </button>
              ))}
            </>
          )}
        </Menu>
      )}
      <span className="vr" />
      <button className="btn xs ghost add" onClick={(e) => setEdit({ folder: null, at: anchorOf(e.currentTarget) })}>
        <FolderPlus size={13} /> Folder
      </button>

      {ctx && (
        <Popover at={ctx.at} onClose={() => setCtx(null)} label={`Folder ${ctx.folder}`} className="menu" width={190}>
          <button onClick={() => (setEdit({ folder: ctx.folder, at: ctx.at }), setCtx(null))}>
            <Pencil size={12} /> Rename
          </button>
          <button className="danger" onClick={() => (setCtx(null), onDelete(ctx.folder))}>
            <Trash2 size={12} /> Delete folder
          </button>
        </Popover>
      )}
      {edit && (
        <FolderForm
          at={edit.at}
          initial={edit.folder || ''}
          onClose={() => setEdit(null)}
          onSubmit={(name) => (edit.folder ? onRename(edit.folder, name) : onCreate(name))}
        />
      )}
    </div>
  );
};

const FolderForm: React.FC<{ at: Anchor; initial: string; onClose: () => void; onSubmit: (name: string) => Promise<boolean> }> = ({
  at,
  initial,
  onClose,
  onSubmit,
}) => {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const rename = Boolean(initial);
  return (
    <Popover at={at} onClose={onClose} label={rename ? 'Rename folder' : 'New folder'} width={240}>
      <form
        className="form"
        style={{ gap: 8 }}
        onSubmit={async (e) => {
          e.preventDefault();
          const v = name.trim();
          if (!v || v === initial) return onClose();
          setBusy(true);
          const ok = await onSubmit(v);
          setBusy(false);
          if (ok) onClose();
        }}
      >
        <input className="input" value={name} maxLength={40} placeholder="Folder name" aria-label="Folder name" autoFocus onChange={(e) => setName(e.target.value)} />
        <div className="inline end">
          <button type="button" className="btn xs" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn xs primary" disabled={busy || !name.trim()}>
            {busy && <Loader2 size={11} className="spin" />} {rename ? 'Rename' : 'Create'}
          </button>
        </div>
      </form>
    </Popover>
  );
};

/* ------------------------------------------------------------------ *
 * Column settings
 * ------------------------------------------------------------------ */

export const ColumnsPopover: React.FC<{
  at: Anchor;
  visible: ColumnId[];
  onChange: (cols: ColumnId[]) => void;
  compact: boolean;
  onCompact: (v: boolean) => void;
  onReset: () => void;
  onClose: () => void;
}> = ({ at, visible, onChange, compact, onCompact, onReset, onClose }) => {
  const hidden = COLUMNS.map((c) => c.id).filter((id) => !visible.includes(id));
  const move = (i: number, d: 1 | -1) => {
    const next = [...visible];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x);
    onChange(next);
  };
  const labelOf = (id: ColumnId) => COLUMNS.find((c) => c.id === id)?.label || id;
  return (
    <Popover at={at} onClose={onClose} label="Columns" width={260}>
      <div className="org-cols">
        {visible.map((id, i) => (
          <div key={id} className="org-col" data-on="true">
            {id === 'name' ? (
              <span className="fixed" aria-hidden="true">
                <Check size={14} />
              </span>
            ) : (
              <CheckBox state onClick={() => onChange(visible.filter((x) => x !== id))} label={`Hide ${labelOf(id)}`} />
            )}
            <span className="grow">{labelOf(id)}</span>
            {id !== 'name' && (
              <>
                <button className="icon-btn xs" disabled={i <= 1} onClick={() => move(i, -1)} aria-label={`Move ${labelOf(id)} up`}>
                  <ArrowUp size={12} />
                </button>
                <button className="icon-btn xs" disabled={i >= visible.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${labelOf(id)} down`}>
                  <ArrowDown size={12} />
                </button>
              </>
            )}
          </div>
        ))}
        {hidden.map((id) => (
          <div key={id} className="org-col" data-on="false">
            <CheckBox state={false} onClick={() => onChange([...visible, id])} label={`Show ${labelOf(id)}`} />
            <span className="grow">{labelOf(id)}</span>
          </div>
        ))}
        <hr />
        <label className="switch">
          <input type="checkbox" checked={compact} onChange={(e) => onCompact(e.target.checked)} />
          Compact rows
        </label>
        <hr />
        <button className="btn xs" onClick={onReset} style={{ alignSelf: 'flex-start' }}>
          Reset
        </button>
      </div>
    </Popover>
  );
};
