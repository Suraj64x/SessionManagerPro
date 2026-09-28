import React, { useEffect, useMemo, useState } from 'react';
import {
  ArchiveRestore,
  ChevronDown,
  ChevronUp,
  Code2,
  Folder,
  Globe,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Search,
  Settings2,
  Square,
  Star,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import type { PoolStatus, Script, SessionRecord, TrashItem } from '../types';
import { MAX_THREADS, type BulkAction } from '../api';
import {
  Avatar,
  CheckBox,
  CopyButton,
  Empty,
  Menu,
  Pager,
  StatusBadge,
  Stepper,
  Toolbar,
  ago,
  usePaged,
  useStored,
  useUI,
} from '../ui';
import { FaceHuddle } from '../faces';
import { renderSlot, singleSlot } from '../contributions';
import { useApp } from '../app-context';
import { fptShort } from './FingerprintPanel';
import { organizeApi } from '../features/organize/api';
import {
  COLUMNS,
  DEFAULT_COLUMNS,
  NO_FILTERS,
  anchorOf,
  filterCount,
  fmtWork,
  matchesFilters,
  sameName,
  useColumns,
  useFolderOps,
  useOrganize,
  type Anchor,
  type ColumnId,
  type Filters,
  type SortKey,
  type Status,
} from '../features/organize/model';
import {
  ColumnsPopover,
  FilterChips,
  FilterMenu,
  FolderStrip,
  NotesPopover,
  Popover,
  StatusPicker,
  TagsPopover,
} from '../features/organize/parts';
import { layoutPoint } from '../zoom';
import { tagTone } from '../ui';
import { DEFAULT_ENGINE, useBrowsers } from '../features/engines/store';

type StatusFilter = 'all' | 'live' | 'ready' | 'error';

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : undefined);

interface Props {
  sessions: SessionRecord[];
  trash: TrashItem[];
  pool: PoolStatus | null;
  scripts: Script[];
  query: string;
  onQuery: (q: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  selectedIds: string[];
  onSelect: React.Dispatch<React.SetStateAction<string[]>>;
  launchingIds: string[];
  openId: string | null;
  onOpen: (s: SessionRecord) => void;
  onNew: () => void;
  onLaunch: (ids: string[]) => void;
  onStop: (id: string) => void;
  onStopAll: () => void;
  threadLimit: number;
  onThreadSet: (n: number) => void;
  onThreadStep: (d: 1 | -1) => void;
  launchUrl: string;
  onLaunchUrl: (u: string) => void;
  onBulk: (ids: string[], action: BulkAction, value?: unknown) => Promise<void>;
  onRunScript: (scriptId: string, ids: string[]) => void;
  onRestore: (id: string) => void;
  onPurge: (id: string) => void;
  onEmptyTrash: () => void;
  pageSize: number;
  onPageSize: (n: number) => void;
}

/**
 * Which engine a profile runs on, beside its name: F for a Firefox build, C for a Chromium one,
 * in that family's colour. The Browser column says which build; this is the glance.
 */
const EngineMark: React.FC<{ s: SessionRecord }> = ({ s }) => {
  const { data } = useBrowsers();
  const id = s.browser || DEFAULT_ENGINE;
  const b = data?.browsers.find((x) => x.id === id);
  const family = b?.family || (id === DEFAULT_ENGINE ? 'firefox' : undefined);
  // No family: an engine the panel no longer offers, which the profile still names.
  if (!family) {
    return (
      <span className="eng-mark sm unknown" title={`Runs on "${id}", which this panel no longer offers — pick another browser in the profile`}>
        ?
      </span>
    );
  }
  return (
    <span className={`eng-mark sm ${family}`} title={`${b?.name || id}${b?.kind === 'stealth' ? ' (stealth)' : ''}`}>
      {family === 'chromium' ? 'C' : 'F'}
    </span>
  );
};

export const ProfilesView: React.FC<Props> = ({ searchRef, ...p }) => {
  const { data: engines } = useBrowsers();
  const { confirm, toast } = useUI();
  const { refresh } = useApp();
  const { statuses, folders } = useOrganize();
  const folderOps = useFolderOps();
  const { visible, setCols, compact, setCompact } = useColumns();
  const [status, setStatus] = useState<StatusFilter>('all');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [storedFolder, setFolder] = useStored<string>('profiles.folder', '');
  // A remembered folder that was deleted since falls back to All.
  const folder = folders.includes(storedFolder) ? storedFolder : '';
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  const [showTrash, setShowTrash] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tagsEdit, setTagsEdit] = useState<{ s: SessionRecord; at: Anchor } | null>(null);
  const [notesEdit, setNotesEdit] = useState<{ s: SessionRecord; at: Anchor } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ s: SessionRecord; at: Anchor } | null>(null);
  const [colsAt, setColsAt] = useState<Anchor | null>(null);

  const allTags = useMemo(() => [...new Set(p.sessions.flatMap((s) => s.tags || []))].sort(), [p.sessions]);
  const counts = useMemo(() => {
    const c = { all: p.sessions.length, live: 0, ready: 0, error: 0 };
    for (const s of p.sessions) {
      if (s.status === 'live') c.live++;
      else if (s.status === 'error') c.error++;
      else if (s.status === 'ready' || s.status === 'completed') c.ready++;
    }
    return c;
  }, [p.sessions]);
  const folderCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of p.sessions) if (s.folder) m.set(s.folder, (m.get(s.folder) || 0) + 1);
    return m;
  }, [p.sessions]);

  const rows = useMemo(() => {
    const q = p.query.trim().toLowerCase();
    const shown = p.sessions.filter((s) => {
      if (status === 'live' && s.status !== 'live' && s.status !== 'queued') return false;
      if (status === 'ready' && s.status !== 'ready' && s.status !== 'completed') return false;
      if (status === 'error' && s.status !== 'error') return false;
      if (folder && (s.folder || '') !== folder) return false;
      if (!matchesFilters(s, filters)) return false;
      if (!q) return true;
      return [s.id, s.email, s.notes, s.label, s.folder, s.lastExitIp, ...(s.tags || []), s.proxy && `${s.proxy.host}:${s.proxy.port}`]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
    const { key, dir } = sort;
    const byId = (a: SessionRecord, b: SessionRecord) => a.id.localeCompare(b.id, undefined, { numeric: true });
    // Statuses sort in list order; a label not in the list goes after them, none last.
    const rank = (label?: string) => {
      if (!label) return statuses.length + 1;
      const i = statuses.findIndex((st) => sameName(st.name, label));
      return i < 0 ? statuses.length : i;
    };
    return shown.sort((a, b) => {
      const pin = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
      if (pin) return pin;
      let d = 0;
      if (key === 'status') d = rank(a.label) - rank(b.label);
      else if (key === 'cookies') d = (a.cookieCount || 0) - (b.cookieCount || 0);
      else if (key === 'launches') d = (a.launchCount || 0) - (b.launchCount || 0);
      else if (key === 'lastOpened') d = (a.lastOpenedAt || '').localeCompare(b.lastOpenedAt || '');
      else if (key === 'created') d = (a.createdAt || '').localeCompare(b.createdAt || '');
      else d = byId(a, b);
      return d * dir || byId(a, b);
    });
  }, [p.sessions, p.query, status, folder, filters, sort, statuses]);

  const paged = usePaged(rows, p.pageSize, `${status}|${folder}|${JSON.stringify(filters)}|${p.query}|${sort.key}${sort.dir}`);
  const selected = new Set(p.selectedIds);
  const shownSelected = rows.filter((r) => selected.has(r.id)).length;
  const head: boolean | 'mixed' = rows.length && shownSelected === rows.length ? true : shownSelected ? 'mixed' : false;

  // Select-all and Ctrl+A act on the rows the filters show, never on hidden ones.
  // Functional updates: two clicks in one tick must both land.
  const shownIds = rows.map((r) => r.id);
  const selectShown = () => p.onSelect((prev) => [...new Set([...prev, ...shownIds])]);
  const toggleAll = () =>
    head === true ? p.onSelect((prev) => prev.filter((id) => !shownIds.includes(id))) : selectShown();
  const toggle = (id: string) =>
    p.onSelect((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const trashIds = async (ids: string[]) => {
    const ok = await confirm({
      title: ids.length > 1 ? `Move ${ids.length} profiles to trash?` : `Move ${ids[0]} to trash?`,
      body: 'Kept for 48 hours with their proxy and fingerprint reserved. Restore any time before then.',
      confirmLabel: 'Move to trash',
      danger: true,
    });
    if (ok) await p.onBulk(ids, 'trash');
  };

  useEffect(() => {
    if (showTrash) return;
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('.scrim, .drawer')) return;
      // Not while typing, and not in the log, where Ctrl+A should select log text.
      if ((e.target as HTMLElement)?.closest?.('input, textarea, select, .dock')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        selectShown();
      } else if (e.key === 'Delete' && p.selectedIds.length) {
        e.preventDefault();
        trashIds(p.selectedIds);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /* ---- one-field edits from the table: status, tags, notes, pin ---- */

  const patchRow = async (id: string, body: Record<string, unknown>) => {
    setBusyId(id);
    try {
      await organizeApi.patchSession(id, body);
      await refresh.sessions();
    } catch (err) {
      toast('error', errMsg(err));
    } finally {
      setBusyId(null);
    }
  };
  const filterStatus = (name: string) =>
    setFilters((f) => (f.statuses.some((x) => sameName(x, name)) ? f : { ...f, statuses: [...f.statuses, name], noStatus: false }));
  const filterTag = (t: string) => setFilters((f) => (f.tags.includes(t) ? f : { ...f, tags: [...f.tags, t], noTags: false }));
  const clearAll = () => {
    setFilters(NO_FILTERS);
    setFolder('');
    setStatus('all');
    p.onQuery('');
  };
  const narrowed = filterCount(filters) > 0 || Boolean(folder) || Boolean(p.query.trim()) || status !== 'all';

  const sortTh = (key: SortKey, label: string, className?: string) => {
    const active = sort.key === key;
    return (
      <th key={key} className={className} aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
        <button onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === 1 ? -1 : 1 }))}>
          {label}
          {active && (sort.dir === 1 ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
        </button>
      </th>
    );
  };

  const cell = (id: ColumnId, s: SessionRecord): React.ReactNode => {
    switch (id) {
      case 'name':
        return (
          <div className="org-name">
            <button
              className="pin"
              aria-pressed={Boolean(s.pinned)}
              aria-label={s.pinned ? `Unpin ${s.id}` : `Pin ${s.id}`}
              title={s.pinned ? 'Unpin' : 'Pin to top'}
              onClick={() => patchRow(s.id, { pinned: !s.pinned })}
            >
              <Star size={13} fill={s.pinned ? 'currentColor' : 'none'} />
            </button>
            <button className="who" onClick={() => p.onOpen(s)} aria-label={`Open ${s.id}`}>
              <Avatar s={s} size={compact ? 24 : 30} />
              <span>
                <span className="name-row">
                  <span className="name" title={s.id}>
                    {s.id}
                  </span>
                  <EngineMark s={s} />
                </span>
                {!compact && !visible.includes('notes') && s.notes && (
                  <span className="sub" title={s.notes}>
                    {s.notes}
                  </span>
                )}
              </span>
            </button>
            {(s.status === 'live' || s.status === 'queued' || s.status === 'error') && <StatusBadge s={s} />}
          </div>
        );
      case 'status':
        return (
          <StatusPicker s={s} statuses={statuses} busy={busyId === s.id} onSet={(label) => patchRow(s.id, { label })} onFilter={filterStatus} />
        );
      case 'tags': {
        const tags = s.tags || [];
        return (
          // A click on a chip filters; anywhere else in the cell edits.
          <div className="org-tags" onClick={(e) => e.target === e.currentTarget && setTagsEdit({ s, at: anchorOf(e.currentTarget) })}>
            {tags.slice(0, 3).map((t) => (
              <button key={t} className={`chip ${tagTone(t)}`} onClick={() => filterTag(t)} aria-label={`Filter by tag ${t}`}>
                {t}
              </button>
            ))}
            {tags.length > 3 && <span className="dim">+{tags.length - 3}</span>}
            <button className="add" aria-label={`Edit tags of ${s.id}`} title="Edit tags" onClick={(e) => setTagsEdit({ s, at: anchorOf(e.currentTarget) })}>
              {tags.length ? <Pencil size={11} /> : <Plus size={11} />}
              {!tags.length && 'Tag'}
            </button>
          </div>
        );
      }
      case 'notes':
        return (
          <button className="org-notes" aria-label={`Edit notes of ${s.id}`} title={s.notes || 'Add notes'} onClick={(e) => setNotesEdit({ s, at: anchorOf(e.currentTarget) })}>
            {s.notes || <span className="dim">Add notes</span>}
          </button>
        );
      case 'proxy':
        return s.proxy?.host ? (
          <span className="inline" style={{ gap: 2 }}>
            <span className="tag">
              <span>
                {s.proxy.host}:{s.proxy.port}
              </span>
            </span>
            <CopyButton value={`${s.proxy.host}:${s.proxy.port}`} label="Copy proxy" className="reveal" />
          </span>
        ) : (
          <span className="dim">Direct</span>
        );
      case 'browser': {
        const b = engines?.browsers.find((x) => x.id === (s.browser || DEFAULT_ENGINE));
        return (
          <span className={`eng-cell ${b?.family || ''}`} title={b ? `${b.name}${b.version ? ` ${b.version}` : ''}` : s.browser}>
            {b?.name || s.browser || 'Stealth Firefox'}
          </span>
        );
      }
      case 'leak':
        return s.leakCheck ? (
          <span
            className={`badge ${s.leakCheck.verdict === 'clean' ? 'live' : s.leakCheck.verdict === 'leak' ? 'error' : 'warn'}`}
            title={`${new Date(s.leakCheck.at).toLocaleString()}${s.leakCheck.failed.length ? ` · ${s.leakCheck.failed.join(', ')}` : ''}`}
          >
            {s.leakCheck.verdict === 'clean' ? 'No leaks' : s.leakCheck.verdict === 'leak' ? 'Leaking' : 'Warnings'}
          </span>
        ) : (
          <span className="dim">—</span>
        );
      case 'exitIp':
        return s.lastExitIp ? (
          <span className="mono" title={s.lastCountry}>
            {s.lastExitIp}
          </span>
        ) : (
          <span className="dim">—</span>
        );
      case 'fingerprint':
        return s.fingerprintFile ? (
          <span className="mono" title={s.fingerprintFile}>
            {fptShort(s.fingerprintFile)}
          </span>
        ) : (
          <span className="dim">—</span>
        );
      case 'cookies':
        return s.cookieCount || <span className="dim">0</span>;
      case 'folder':
        return s.folder ? (
          <button className="chip folder" onClick={() => setFolder(s.folder!)} aria-label={`Show folder ${s.folder}`}>
            <Folder size={11} /> {s.folder}
          </button>
        ) : (
          <span className="dim">—</span>
        );
      case 'launches':
        return s.launchCount || <span className="dim">—</span>;
      case 'workTime':
        return fmtWork(s.workSeconds);
      case 'lastOpened':
        return <span title={when(s.lastOpenedAt)}>{ago(s.lastOpenedAt)}</span>;
      case 'created':
        return <span title={when(s.createdAt)}>{ago(s.createdAt)}</span>;
    }
  };
  const tdClass = (id: ColumnId) => {
    const c = COLUMNS.find((k) => k.id === id);
    return c?.num ? 'num mono' : id === 'lastOpened' || id === 'created' ? 'dim' : undefined;
  };

  // The "…" menu and the right-click menu are the same items.
  const rowMenu = (s: SessionRecord, close: () => void) => (
    <>
      <button onClick={() => (p.onOpen(s), close())}>Open</button>
      <button onClick={() => (close(), patchRow(s.id, { pinned: !s.pinned }))}>
        <Star size={12} /> {s.pinned ? 'Unpin' : 'Pin to top'}
      </button>
      {renderSlot('rowMenu', { session: s, close })}
      {s.status === 'live' && p.scripts.length > 0 && (
        <>
          <hr />
          <div className="menu-head">Run script</div>
          {p.scripts.slice(0, 8).map((sc) => (
            <button key={sc.id} onClick={() => (p.onRunScript(sc.id, [s.id]), close())}>
              <Code2 size={12} /> {sc.name}
            </button>
          ))}
        </>
      )}
      <hr />
      <button className="danger" onClick={() => (close(), trashIds([s.id]))}>
        <Trash2 size={12} /> Move to trash
      </button>
    </>
  );

  if (showTrash) return <TrashView {...p} searchRef={searchRef} onBack={() => setShowTrash(false)} />;

  const active = p.pool?.activeCount ?? 0;
  const queued = p.pool?.queuedCount ?? 0;

  return (
    <>
      <Toolbar title="Profiles">
        <div className="seg" role="group" aria-label="Status">
          {(['all', 'live', 'ready', 'error'] as StatusFilter[]).map((f) => (
            <button key={f} aria-pressed={status === f} onClick={() => setStatus(f)}>
              {f[0].toUpperCase() + f.slice(1)}
              {f !== 'all' && counts[f] > 0 && <span className="n">{counts[f]}</span>}
            </button>
          ))}
        </div>

        <FilterMenu statuses={statuses} allTags={allTags} folders={folders} filters={filters} onFilters={setFilters} folder={folder} onFolder={setFolder} />
        <FilterChips statuses={statuses} filters={filters} onFilters={setFilters} />

        <div className="field search">
          <Search size={14} />
          <input
            ref={searchRef}
            type="search"
            data-search=""
            className="input"
            placeholder="Search"
            value={p.query}
            onChange={(e) => p.onQuery(e.target.value)}
            aria-label="Search profiles"
          />
        </div>

        <button className="btn ghost" onClick={() => setShowTrash(true)} aria-label={`Trash, ${p.trash.length} items`}>
          <Trash2 size={13} />
          {p.trash.length > 0 && p.trash.length}
        </button>
        {singleSlot('profilesPrimary')?.({ onNew: p.onNew }) ?? (
          <span className="split">
            <button className="btn primary" onClick={p.onNew}>
              <Plus size={14} /> New
            </button>
            <Menu
              trigger={(t) => (
                <button className="btn primary" aria-label="More ways to add profiles" {...t}>
                  <ChevronDown size={14} />
                </button>
              )}
            >
              {(close) => (
                <>
                  <button onClick={() => (close(), p.onNew())}>New profile…</button>
                  {renderSlot('createMenu', { close })}
                </>
              )}
            </Menu>
          </span>
        )}
      </Toolbar>
      {renderSlot('profilesAbove')}

      <div className={`view${p.selectedIds.length ? ' pad-bulk' : ''}`}>
        <div className="runstrip">
          <div className="meter" role="status" aria-label={`${active} of ${p.threadLimit} running, ${queued} queued`}>
            {Math.max(p.threadLimit, active) <= 16 ? (
              <div className="slots" aria-hidden="true">
                {Array.from({ length: Math.max(p.threadLimit, active) }, (_, i) => (
                  <span key={i} className={`slot${i < active ? ' on' : i < active + queued ? ' queued' : ''}`} />
                ))}
              </div>
            ) : (
              <div className="slots bar" aria-hidden="true">
                <i className="queued" style={{ width: `${Math.min(100, ((active + queued) / p.threadLimit) * 100)}%` }} />
                <i className="on" style={{ width: `${Math.min(100, (active / p.threadLimit) * 100)}%` }} />
              </div>
            )}
            <span>
              <b>{active}</b>/{p.threadLimit}
              {queued > 0 && ` · ${queued} queued`}
            </span>
          </div>
          <Stepper value={p.threadLimit} min={1} max={MAX_THREADS} onStep={p.onThreadStep} onSet={p.onThreadSet} label="Parallel windows" />
          <div className="field" style={{ flex: 1, maxWidth: 320 }}>
            <Globe size={14} />
            <input
              className="input"
              placeholder="Start URL (optional)"
              value={p.launchUrl}
              onChange={(e) => p.onLaunchUrl(e.target.value)}
              aria-label="Start URL for this launch"
            />
          </div>
          <span className="grow" />
          {active > 0 && (
            <button className="btn danger" onClick={p.onStopAll}>
              <Square size={11} /> Stop all
            </button>
          )}
          <button
            className="btn primary"
            onClick={() => p.onLaunch(p.selectedIds)}
            disabled={!p.selectedIds.length}
            title={p.selectedIds.length ? 'Ctrl+Enter' : 'Select profiles first'}
          >
            <Play size={12} /> Start{p.selectedIds.length ? ` ${p.selectedIds.length}` : ''}
          </button>
        </div>

        {p.sessions.length > 0 && (
          <FolderStrip
            folders={folders}
            counts={folderCounts}
            total={p.sessions.length}
            selected={folder}
            onSelect={setFolder}
            onCreate={folderOps.create}
            onRename={async (old, name) => {
              const ok = await folderOps.rename(old, name);
              if (ok && folder === old) setFolder(name);
              return ok;
            }}
            onDelete={folderOps.remove}
            onDrop={(ids, f) => folderOps.move(ids, f)}
          />
        )}

        {!p.sessions.length ? (
          <div className="table-wrap">
            <Empty
              icon={<FaceHuddle />}
              text="No profiles yet"
              hint="Each profile is its own browser: a sticky proxy, a unique fingerprint and its own cookies."
              action={
                <button className="btn primary" onClick={p.onNew}>
                  <Plus size={14} /> Create profile
                </button>
              }
            />
          </div>
        ) : !rows.length ? (
          <div className="table-wrap">
            <Empty
              icon={<FaceHuddle mood="puzzled" />}
              text="Nothing matches"
              hint="Try a different search or clear the filters."
              action={
                narrowed ? (
                  <button className="btn" onClick={clearAll}>
                    <X size={13} /> Clear filters
                  </button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div className="table-wrap">
            <div className="table-scroll">
              <table className={`tbl org-table${compact ? ' compact' : ''}`}>
                <thead>
                  <tr>
                    <th className="tight">
                      <CheckBox state={head} onClick={toggleAll} label="Select all shown" />
                    </th>
                    {sortTh('name', 'Name')}
                    <th className="tight run">Run</th>
                    {visible.slice(1).map((id) => {
                      const c = COLUMNS.find((k) => k.id === id)!;
                      return c.sort ? (
                        sortTh(c.sort, c.label, c.num ? 'num' : undefined)
                      ) : (
                        <th key={id} className={c.num ? 'num' : undefined}>
                          {c.label}
                        </th>
                      );
                    })}
                    <th className="tight gear">
                      <div className="inline">
                        <button className="icon-btn xs" aria-label="Columns" title="Columns" aria-expanded={Boolean(colsAt)} onClick={(e) => setColsAt(anchorOf(e.currentTarget))}>
                          <Settings2 size={14} />
                        </button>
                      </div>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {paged.slice.map((s) => (
                    <tr
                      key={s.id}
                      data-selected={selected.has(s.id)}
                      data-open={p.openId === s.id}
                      draggable={selected.has(s.id)}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', p.selectedIds.join('\n'));
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setCtxMenu({ s, at: layoutPoint(e.clientX, e.clientY) });
                      }}
                    >
                      <td className="tight">
                        <CheckBox state={selected.has(s.id)} onClick={() => toggle(s.id)} label={`Select ${s.id}`} />
                      </td>
                      {/* Start sits right after the name: it is what a row is opened for. */}
                      <td className={tdClass('name')}>{cell('name', s)}</td>
                      <td className="tight run">
                        {s.status === 'live' ? (
                          <button className="btn xs danger" onClick={() => p.onStop(s.id)}>
                            <Square size={10} /> Stop
                          </button>
                        ) : (
                          <button
                            className="btn xs start"
                            onClick={() => p.onLaunch([s.id])}
                            disabled={p.launchingIds.includes(s.id) || s.status === 'queued'}
                          >
                            {p.launchingIds.includes(s.id) ? <Loader2 size={11} className="spin" /> : <Play size={10} />}
                            Start
                          </button>
                        )}
                      </td>
                      {visible.slice(1).map((id) => (
                        <td key={id} className={tdClass(id)}>
                          {cell(id, s)}
                        </td>
                      ))}
                      <td className="tight">
                        <div className="inline" style={{ gap: 4, justifyContent: 'flex-end' }}>
                          <Menu
                            fixed
                            trigger={(t) => (
                              <button className="icon-btn xs" aria-label={`More for ${s.id}`} {...t}>
                                <MoreHorizontal size={15} />
                              </button>
                            )}
                          >
                            {(close) => rowMenu(s, close)}
                          </Menu>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager paged={paged} total={rows.length} noun="profiles" pageSize={p.pageSize} onPageSize={p.onPageSize} />
          </div>
        )}
      </div>

      {tagsEdit && (
        <TagsPopover
          s={tagsEdit.s}
          at={tagsEdit.at}
          allTags={allTags}
          onClose={() => setTagsEdit(null)}
          onSave={(tags) => patchRow(tagsEdit.s.id, { tags })}
        />
      )}
      {notesEdit && (
        <NotesPopover s={notesEdit.s} at={notesEdit.at} onClose={() => setNotesEdit(null)} onSave={(notes) => patchRow(notesEdit.s.id, { notes })} />
      )}
      {ctxMenu && (
        <Popover at={ctxMenu.at} onClose={() => setCtxMenu(null)} label={`Menu for ${ctxMenu.s.id}`} className="menu" width={220}>
          {rowMenu(ctxMenu.s, () => setCtxMenu(null))}
        </Popover>
      )}
      {colsAt && (
        <ColumnsPopover
          at={colsAt}
          visible={visible}
          onChange={setCols}
          compact={compact}
          onCompact={setCompact}
          onReset={() => {
            setCols(DEFAULT_COLUMNS);
            setCompact(false);
          }}
          onClose={() => setColsAt(null)}
        />
      )}

      {p.selectedIds.length > 0 && (
        <BulkBar
          ids={p.selectedIds}
          sessions={p.sessions}
          scripts={p.scripts}
          allTags={allTags}
          statuses={statuses}
          folders={folders}
          onClear={() => p.onSelect([])}
          onLaunch={() => p.onLaunch(p.selectedIds)}
          onBulk={p.onBulk}
          onFolder={(f) => folderOps.move(p.selectedIds, f)}
          onRunScript={p.onRunScript}
          onTrash={() => trashIds(p.selectedIds)}
          drawerOpen={!!p.openId}
        />
      )}
    </>
  );
};

/* ------------------------------------------------------------------ */

const BulkBar: React.FC<{
  ids: string[];
  sessions: SessionRecord[];
  scripts: Script[];
  allTags: string[];
  statuses: Status[];
  folders: string[];
  onClear: () => void;
  onLaunch: () => void;
  onBulk: Props['onBulk'];
  onFolder: (folder: string) => void;
  onRunScript: Props['onRunScript'];
  onTrash: () => void;
  drawerOpen: boolean;
}> = ({ ids, sessions, scripts, allTags, statuses, folders, onClear, onLaunch, onBulk, onFolder, onRunScript, onTrash, drawerOpen }) => {
  const [tag, setTag] = useState('');
  const selected = ids.map((id) => sessions.find((s) => s.id === id)).filter((s): s is SessionRecord => !!s);
  const live = selected.filter((s) => s.status === 'live');
  const liveIds = live.map((s) => s.id);
  const selectedTags = [...new Set(selected.flatMap((s) => s.tags || []))];

  return (
    <div className={`bulkbar${drawerOpen ? ' beside-drawer' : ''}`} role="toolbar" aria-label="Selected profiles">
      <span className="count">{ids.length} selected</span>
      <button className="btn xs start" onClick={onLaunch}>
        <Play size={10} /> Start
      </button>
      {liveIds.length > 0 && (
        <button className="btn xs" onClick={() => onBulk(liveIds, 'stop')}>
          <Square size={10} /> Stop {liveIds.length}
        </button>
      )}
      <Menu
        up
        left
        trigger={(t) => (
          <button className="btn xs" disabled={!liveIds.length} title={liveIds.length ? '' : 'Launch them first'} {...t}>
            <Code2 size={12} /> Run
          </button>
        )}
      >
        {(close) =>
          scripts.length ? (
            <>
              <div className="menu-head">On {liveIds.length} running</div>
              {scripts.map((s) => (
                <button key={s.id} onClick={() => (onRunScript(s.id, liveIds), close())}>
                  {s.name}
                </button>
              ))}
            </>
          ) : (
            <div className="menu-head">No scripts yet</div>
          )
        }
      </Menu>
      <Menu
        up
        trigger={(t) => (
          <button className="btn xs" {...t}>
            <Tag size={12} /> Tag
          </button>
        )}
      >
        {(close) => (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (tag.trim()) onBulk(ids, 'tag', [tag]).then(() => (setTag(''), close()));
            }}
          >
            <input
              className="input"
              list="bulk-tags"
              autoFocus
              placeholder="Add tag, Enter"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
            />
            <datalist id="bulk-tags">
              {allTags.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
            {selectedTags.length > 0 && <div className="menu-head">Remove</div>}
            {selectedTags.map((t) => (
              <button type="button" key={t} onClick={() => onBulk(ids, 'untag', [t]).then(close)}>
                <X size={12} /> {t}
              </button>
            ))}
          </form>
        )}
      </Menu>
      <Menu
        up
        trigger={(t) => (
          <button className="btn xs" {...t}>
            Set status
          </button>
        )}
      >
        {(close) => (
          <>
            {statuses.map((st) => (
              <button key={st.name} onClick={() => onBulk(ids, 'label', st.name).then(close)}>
                <span className="status-dot" style={{ '--c': st.color } as React.CSSProperties} />
                {st.name}
              </button>
            ))}
            <hr />
            <button onClick={() => onBulk(ids, 'label', '').then(close)}>
              <X size={12} /> No status
            </button>
          </>
        )}
      </Menu>
      <Menu
        up
        trigger={(t) => (
          <button className="btn xs" {...t}>
            <Folder size={12} /> Move to folder
          </button>
        )}
      >
        {(close) =>
          folders.length ? (
            <>
              {folders.map((f) => (
                <button key={f} onClick={() => (close(), onFolder(f))}>
                  <Folder size={12} /> {f}
                </button>
              ))}
              <hr />
              <button onClick={() => (close(), onFolder(''))}>
                <X size={12} /> No folder
              </button>
            </>
          ) : (
            <div className="menu-head">No folders yet · add one above the table</div>
          )
        }
      </Menu>
      {renderSlot('bulkBar', { ids, sessions: selected, live, clear: onClear })}
      <span className="vr" />
      <button className="btn xs danger" onClick={onTrash}>
        <Trash2 size={11} /> Trash
      </button>
      <button className="icon-btn xs" onClick={onClear} aria-label="Clear selection">
        <X size={14} />
      </button>
    </div>
  );
};

/* ------------------------------------------------------------------ */

const until = (iso: string) => {
  const h = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 3_600_000));
  return h ? `${h}h` : '<1h';
};

const TrashView: React.FC<Props & { onBack: () => void }> = ({ trash, onBack, onRestore, onPurge, onEmptyTrash }) => {
  const { confirm } = useUI();
  return (
    <>
      <Toolbar title="Trash">
        {trash.length > 0 && (
          <button
            className="btn danger"
            onClick={async () => {
              const ok = await confirm({
                title: `Permanently delete ${trash.length} profile(s)?`,
                body: 'Browser data and cookies are erased and their proxies and fingerprints freed. This cannot be undone.',
                confirmLabel: 'Delete forever',
                danger: true,
              });
              if (ok) onEmptyTrash();
            }}
          >
            Empty trash
          </button>
        )}
        <button className="btn" onClick={onBack}>
          Back to profiles
        </button>
      </Toolbar>
      <div className="view">
        <div className="table-wrap">
          {!trash.length ? (
            <Empty icon={<FaceHuddle mood="calm" />} text="Trash is empty" hint="Deleted profiles wait here for 48 hours, with their proxy and fingerprint reserved." />
          ) : (
            <div className="table-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Profile</th>
                    <th>Deleted</th>
                    <th>Purged in</th>
                    <th>Proxy</th>
                    <th className="num">Cookies</th>
                    <th className="tight" />
                  </tr>
                </thead>
                <tbody>
                  {trash.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <div className="who">
                          <Avatar s={{ id: t.id }} size={30} />
                          <span>
                            <span className="name">{t.id}</span>
                            {t.notes && <span className="sub">{t.notes}</span>}
                          </span>
                        </div>
                      </td>
                      <td className="dim">{ago(t.deletedAt)}</td>
                      <td>{until(t.purgeAt)}</td>
                      <td className="mono dim">{t.proxy ? `${t.proxy.host}:${t.proxy.port}` : '—'}</td>
                      <td className="num mono">{t.cookieCount}</td>
                      <td className="tight">
                        <div className="inline" style={{ gap: 4 }}>
                          <button className="btn xs" onClick={() => onRestore(t.id)}>
                            <ArchiveRestore size={12} /> Restore
                          </button>
                          <button
                            className="icon-btn xs danger"
                            aria-label={`Delete ${t.id} forever`}
                            title="Delete forever"
                            onClick={async () => {
                              const ok = await confirm({
                                title: `Delete ${t.id} forever?`,
                                body: 'Its browser data and cookies are erased. This cannot be undone.',
                                confirmLabel: 'Delete forever',
                                danger: true,
                              });
                              if (ok) onPurge(t.id);
                            }}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
};
