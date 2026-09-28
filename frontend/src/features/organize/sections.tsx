import React, { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Folder, Plus, Trash2 } from 'lucide-react';
import { useApp } from '../../app-context';
import { useUI } from '../../ui';
import { MAX_STATUSES, inFolder, sameName, useFolderOps, useOrganize, useStatusOps, usedBy } from './model';

// Settings › Statuses and Settings › Folders. The Profiles table and the drawer read the
// same lists through useOrganize().

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** Commits on blur or Enter; Escape or an empty value restores the current name. */
const NameInput: React.FC<{ value: string; max: number; label: string; onCommit: (v: string) => void }> = ({ value, max, label, onCommit }) => {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(value);
  }
  const commit = () => {
    const v = draft.trim();
    if (!v || v === value) return setDraft(value);
    onCommit(v);
  };
  return (
    <input
      className="input name"
      value={draft}
      maxLength={max}
      aria-label={label}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') setDraft(value);
      }}
    />
  );
};

/** The native picker fires on every drag; one save lands 400 ms after the last change. */
const ColorInput: React.FC<{ value: string; label: string; onCommit: (c: string) => void }> = ({ value, label, onCommit }) => {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(value);
  }
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return (
    <input
      type="color"
      className="org-color"
      value={draft}
      aria-label={label}
      onChange={(e) => {
        const c = e.target.value;
        setDraft(c);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => onCommit(c), 400);
      }}
    />
  );
};

/* ---------------- Settings › Statuses ---------------- */

export const StatusesSection: React.FC = () => {
  const { sessions } = useApp();
  const { toast } = useUI();
  const { statuses } = useOrganize();
  const ops = useStatusOps();
  const [name, setName] = useState('');
  const [color, setColor] = useState('#94a3b8');
  const full = statuses.length >= MAX_STATUSES;
  const taken = (n: string, skip = -1) => statuses.some((st, i) => i !== skip && sameName(st.name, n));

  return (
    <>
      <div className="org-list">
        {statuses.map((st, i) => {
          const n = usedBy(sessions, st.name);
          return (
            <div key={st.name} className="org-item">
              <ColorInput value={st.color} label={`Colour of ${st.name}`} onCommit={(c) => ops.recolor(i, c)} />
              <NameInput
                value={st.name}
                max={24}
                label={`Name of status ${st.name}`}
                onCommit={(v) => (taken(v, i) ? toast('error', `A status named ${v} already exists`) : ops.rename(i, v))}
              />
              <span className="count">{n ? plural(n, 'profile') : 'unused'}</span>
              <button className="icon-btn xs" disabled={i === 0} onClick={() => ops.move(i, -1)} aria-label={`Move ${st.name} up`}>
                <ArrowUp size={13} />
              </button>
              <button className="icon-btn xs" disabled={i === statuses.length - 1} onClick={() => ops.move(i, 1)} aria-label={`Move ${st.name} down`}>
                <ArrowDown size={13} />
              </button>
              <button
                className="icon-btn xs danger"
                disabled={statuses.length === 1}
                title={statuses.length === 1 ? 'The last status stays' : 'Delete'}
                onClick={() => ops.remove(i)}
                aria-label={`Delete ${st.name}`}
              >
                <Trash2 size={13} />
              </button>
            </div>
          );
        })}
      </div>
      <form
        className="org-add"
        onSubmit={async (e) => {
          e.preventDefault();
          const v = name.trim();
          if (!v) return;
          if (taken(v)) return toast('error', `A status named ${v} already exists`);
          if (await ops.add({ name: v, color })) setName('');
        }}
      >
        <input type="color" className="org-color" value={color} aria-label="Colour of the new status" onChange={(e) => setColor(e.target.value)} />
        <input className="input" value={name} maxLength={24} placeholder="New status" aria-label="New status name" disabled={full} onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="btn" disabled={full || !name.trim()}>
          <Plus size={14} /> Add
        </button>
      </form>
      <span className="hint">
        {full ? `Up to ${MAX_STATUSES} statuses.` : 'Set from a profile’s row or drawer. Renaming a status updates every profile using it.'}
      </span>
    </>
  );
};

/* ---------------- Settings › Folders ---------------- */

export const FoldersSection: React.FC = () => {
  const { sessions } = useApp();
  const { folders } = useOrganize();
  const ops = useFolderOps();
  const [name, setName] = useState('');

  return (
    <>
      <div className="org-list">
        {folders.length === 0 && <div className="org-empty">No folders yet</div>}
        {folders.map((f, i) => {
          const n = inFolder(sessions, f).length;
          return (
            <div key={f} className="org-item">
              <Folder size={14} className="dim" aria-hidden="true" />
              <NameInput value={f} max={40} label={`Name of folder ${f}`} onCommit={(v) => ops.rename(f, v)} />
              <span className="count">{n ? plural(n, 'profile') : 'empty'}</span>
              <button className="icon-btn xs" disabled={i === 0} onClick={() => ops.reorder(i, -1)} aria-label={`Move ${f} up`}>
                <ArrowUp size={13} />
              </button>
              <button className="icon-btn xs" disabled={i === folders.length - 1} onClick={() => ops.reorder(i, 1)} aria-label={`Move ${f} down`}>
                <ArrowDown size={13} />
              </button>
              <button className="icon-btn xs danger" title="Delete" onClick={() => ops.remove(f)} aria-label={`Delete folder ${f}`}>
                <Trash2 size={13} />
              </button>
            </div>
          );
        })}
      </div>
      <form
        className="org-add"
        onSubmit={async (e) => {
          e.preventDefault();
          const v = name.trim();
          if (v && (await ops.create(v))) setName('');
        }}
      >
        <input className="input" value={name} maxLength={40} placeholder="New folder" aria-label="New folder name" onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="btn" disabled={!name.trim()}>
          <Plus size={14} /> Add
        </button>
      </form>
      <span className="hint">Deleting a folder keeps its profiles, just unfiled. Drag selected rows onto a folder tab to move them.</span>
    </>
  );
};
