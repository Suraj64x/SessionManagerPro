import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Copy,
  Info,
  Minus,
  Plus,
  Square,
  SquareCheck,
  SquareMinus,
  X,
} from 'lucide-react';
import type { SessionRecord } from './types';
import { layoutRect, viewport } from './zoom';

/* ------------------------------------------------------------------ *
 * Modal — Escape, scrim click, focus trap, focus restore
 * ------------------------------------------------------------------ */

/**
 * Open layers — dialogs, the drawer, popovers — topmost last. Only the top layer handles
 * Escape and Tab, so Escape in a menu inside the drawer closes the menu, not the drawer
 * (and its unsaved edits).
 */
const layers: object[] = [];
const isTop = (token: object) => layers[layers.length - 1] === token;
const pushLayer = () => {
  const token = {};
  layers.push(token);
  return token;
};
const popLayer = (token: object) => {
  const i = layers.indexOf(token);
  if (i >= 0) layers.splice(i, 1);
};

/** Focus-trap + Escape for any dialog-like surface (modal or drawer). */
export function useDialog(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  // Callers pass inline arrows and the panel re-renders on every WebSocket frame.
  // Keying the effect on onClose would re-run it constantly and yank focus.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    const token = pushLayer();
    const restore = document.activeElement as HTMLElement | null;
    const node = ref.current;
    // React's autoFocus focuses on mount without writing an attribute; when it has already
    // put focus inside the dialog, leave it there.
    if (!node?.contains(document.activeElement)) {
      const target =
        node?.querySelector<HTMLElement>('[autofocus]') ??
        node?.querySelector<HTMLElement>('input:not([type=checkbox]), textarea, select') ??
        node?.querySelector<HTMLElement>('button');
      target?.focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (!isTop(token)) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !node) return;
      const items = [
        ...node.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,a[href],[tabindex]:not([tabindex="-1"])'
        ),
      ].filter(
        (el) => el.offsetParent !== null && (el.tagName === 'SUMMARY' || !el.closest('details:not([open])'))
      );
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      popLayer(token);
      document.removeEventListener('keydown', onKey, true);
      restore?.focus?.();
    };
  }, [ref]);
}

export const Modal: React.FC<{
  title: string;
  onClose: () => void;
  width?: number;
  children: React.ReactNode;
  footer?: React.ReactNode;
}> = ({ title, onClose, width = 460, children, footer }) => {
  const ref = useRef<HTMLDivElement>(null);
  useDialog(ref, onClose);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="modal" style={{ maxWidth: width }} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={15} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ *
 * Toasts + confirm
 * ------------------------------------------------------------------ */

type ToastKind = 'success' | 'error' | 'info';
type ConfirmOpts = { title: string; body?: React.ReactNode; confirmLabel?: string; danger?: boolean };
type UIApi = { toast: (kind: ToastKind, text: string) => void; confirm: (opts: ConfirmOpts) => Promise<boolean> };

const UICtx = createContext<UIApi | null>(null);

export const useUI = (): UIApi => {
  const ctx = useContext(UICtx);
  if (!ctx) throw new Error('useUI must be used inside <UIProvider>');
  return ctx;
};

const TOAST_ICON = { success: CircleCheck, error: CircleAlert, info: Info };

export const UIProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<Array<{ id: number; kind: ToastKind; text: string }>>([]);
  const [ask, setAsk] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const seq = useRef(0);

  const toast = useCallback((kind: ToastKind, text: string) => {
    const id = ++seq.current;
    setToasts((prev) => [...prev.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), kind === 'error' ? 6000 : 3200);
  }, []);

  const confirm = useCallback(
    (opts: ConfirmOpts) => new Promise<boolean>((resolve) => setAsk({ ...opts, resolve })),
    []
  );

  const settle = (value: boolean) => {
    ask?.resolve(value);
    setAsk(null);
  };

  const api = useMemo(() => ({ toast, confirm }), [toast, confirm]);

  return (
    <UICtx.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => {
          const Icon = TOAST_ICON[t.kind];
          return (
            <div key={t.id} className={`toast ${t.kind}`}>
              <Icon size={15} />
              <span>{t.text}</span>
              <button
                className="icon-btn xs"
                onClick={() => setToasts((p) => p.filter((x) => x.id !== t.id))}
                aria-label="Dismiss"
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>
      {ask && (
        <Modal
          title={ask.title}
          width={400}
          onClose={() => settle(false)}
          footer={
            <>
              <button className="btn" onClick={() => settle(false)}>
                Cancel
              </button>
              <button className={`btn ${ask.danger ? 'danger' : 'primary'}`} onClick={() => settle(true)}>
                {ask.confirmLabel || 'Confirm'}
              </button>
            </>
          }
        >
          <p style={{ color: 'var(--txt-2)' }}>{ask.body}</p>
        </Modal>
      )}
    </UICtx.Provider>
  );
};

/* ------------------------------------------------------------------ *
 * Small shared pieces
 * ------------------------------------------------------------------ */

/** A view's header row: its name and count on the left, its actions on the right. */
export const Toolbar: React.FC<{ title: string; count?: number; children?: React.ReactNode }> = ({
  title,
  count,
  children,
}) => (
  <header className="section-head">
    <h1>
      {title}
      {count !== undefined && <span className="badge">{count}</span>}
    </h1>
    <span className="grow" />
    {children}
  </header>
);

export const Empty: React.FC<{
  icon: React.ReactNode;
  text: string;
  hint?: string;
  action?: React.ReactNode;
}> = ({ icon, text, hint, action }) => (
  <div className="empty">
    {icon}
    <div>
      <p>{text}</p>
      {hint && <p className="hint">{hint}</p>}
    </div>
    {action}
  </div>
);

export const CheckBox: React.FC<{ state: boolean | 'mixed'; onClick: () => void; label: string }> = ({
  state,
  onClick,
  label,
}) => {
  const Icon = state === 'mixed' ? SquareMinus : state ? SquareCheck : Square;
  return (
    <button
      className="check"
      role="checkbox"
      aria-checked={state === 'mixed' ? 'mixed' : state}
      aria-label={label}
      onClick={onClick}
    >
      <Icon size={15} />
    </button>
  );
};

/** Emits a delta, not a total — a burst of clicks must not all read the same stale value. */
/** −/+ buttons around a number. With `onSet` the number itself can be typed (Enter or blur commits). */
export const Stepper: React.FC<{
  value: number;
  min: number;
  max: number;
  onStep: (delta: 1 | -1) => void;
  onSet?: (n: number) => void;
  label: string;
}> = ({ value, min, max, onStep, onSet, label }) => {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const n = Math.round(Number(draft));
    setDraft(null);
    if (draft !== null && Number.isFinite(n) && n !== value) onSet?.(Math.min(max, Math.max(min, n)));
  };
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button onClick={() => onStep(-1)} disabled={value <= min} aria-label={`${label} down`}>
        <Minus size={12} />
      </button>
      {onSet ? (
        <input
          className="stepper-input"
          inputMode="numeric"
          aria-label={label}
          value={draft ?? String(value)}
          size={Math.max(2, String(draft ?? value).length)}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.target.value.replace(/\D/g, '').slice(0, String(max).length))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            else if (e.key === 'Escape') {
              setDraft(null);
              e.currentTarget.blur();
            }
          }}
        />
      ) : (
        <span aria-live="polite">{value}</span>
      )}
      <button onClick={() => onStep(1)} disabled={value >= max} aria-label={`${label} up`}>
        <Plus size={12} />
      </button>
    </div>
  );
};

const PAGE_SIZES = [25, 50, 100, 250];

export const Pager: React.FC<{
  paged: ReturnType<typeof usePaged>;
  total: number;
  noun: string;
  pageSize: number;
  onPageSize: (n: number) => void;
}> = ({ paged, total, noun, pageSize, onPageSize }) => (
  <div className="pager">
    <div>
      <b>
        {paged.from}–{paged.to}
      </b>{' '}
      of <b>{total}</b> {noun}
    </div>
    <div className="inline">
      <Menu
        fixed
        trigger={(t) => (
          <button className="page-size" aria-label={`Rows per page: ${pageSize}`} aria-haspopup="menu" {...t}>
            <b>{pageSize}</b> per page <ChevronDown size={13} />
          </button>
        )}
      >
        {(close) => (
          <div className="page-size-menu" role="menu">
            <div className="menu-head">Rows per page</div>
            {PAGE_SIZES.map((n) => (
              <button
                key={n}
                role="menuitemradio"
                aria-checked={n === pageSize}
                onClick={() => (onPageSize(n), close())}
              >
                <span className="grow">{n}</span>
                {n === pageSize && <Check size={13} />}
              </button>
            ))}
          </div>
        )}
      </Menu>
      <button
        className="icon-btn xs"
        disabled={paged.page <= 1}
        onClick={() => paged.setPage(paged.page - 1)}
        aria-label="Previous page"
      >
        <ChevronLeft size={15} />
      </button>
      <span>
        <b>{paged.page}</b> / {paged.pages}
      </span>
      <button
        className="icon-btn xs"
        disabled={paged.page >= paged.pages}
        onClick={() => paged.setPage(paged.page + 1)}
        aria-label="Next page"
      >
        <ChevronRight size={15} />
      </button>
    </div>
  </div>
);

export const CopyButton: React.FC<{ value: string; label: string; className?: string }> = ({
  value,
  label,
  className = '',
}) => {
  const [done, setDone] = useState(false);
  const { toast } = useUI();
  return (
    <button
      className={`icon-btn xs ${className}`}
      aria-label={label}
      title={done ? 'Copied' : label}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        } catch {
          toast('error', 'Clipboard unavailable');
        }
      }}
    >
      {done ? <Check size={13} color="var(--accent-txt)" /> : <Copy size={13} />}
    </button>
  );
};

/**
 * Popover anchored to its trigger. Closes on outside click, Escape, or when an item
 * is chosen. `render` receives `close` so items can dismiss it.
 * `fixed` positions it against the viewport, for triggers inside a scrolling box (table
 * rows) that would otherwise clip it; it flips up near the bottom and closes on scroll.
 */
/**
 * A dropdown in the panel's own style: the native `select` keeps the OS list, which looks
 * nothing like the rest. Long lists get a filter box.
 */
export interface PickerOption {
  value: string;
  label: string;
  /** Shown after the label, quieter: a version, a country, "current". */
  hint?: string;
  /** A heading this option sits under. */
  group?: string;
  disabled?: boolean;
  title?: string;
}

export const Picker: React.FC<{
  value: string;
  options: PickerOption[];
  onChange: (value: string) => void;
  label: string;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Fills its row instead of sizing to its content (a form field). */
  block?: boolean;
}> = ({ value, options, onChange, label, id, placeholder, disabled, block }) => {
  const current = options.find((o) => o.value === value);
  return (
    <Menu
      fixed
      trigger={(t) => (
        <button
          id={id}
          className={`picker${block ? ' block' : ''}`}
          aria-label={label}
          aria-haspopup="listbox"
          disabled={disabled || !options.length}
          title={current?.title || current?.label}
          {...t}
        >
          <span className="picker-v">
            {current ? current.label : value || placeholder || ''}
            {current?.hint && <span className="dim"> · {current.hint}</span>}
          </span>
          <ChevronDown size={13} />
        </button>
      )}
    >
      {(close) => <PickerList value={value} options={options} label={label} onPick={(v) => (close(), onChange(v))} />}
    </Menu>
  );
};

const PickerList: React.FC<{
  value: string;
  options: PickerOption[];
  label: string;
  onPick: (value: string) => void;
}> = ({ value, options, label, onPick }) => {
  const [q, setQ] = useState('');
  const search = options.length > 8;
  const needle = q.trim().toLowerCase();
  const shown = needle ? options.filter((o) => `${o.label} ${o.hint || ''}`.toLowerCase().includes(needle)) : options;
  let group = '';
  return (
    <div className="picker-menu" role="listbox" aria-label={label}>
      {search && (
        <input
          className="input"
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search…"
          aria-label={`Search ${label}`}
        />
      )}
      {shown.map((o) => {
        const head = o.group && o.group !== group ? o.group : null;
        group = o.group || '';
        return (
          <React.Fragment key={o.value}>
            {head && <div className="menu-head">{head}</div>}
            <button
              role="option"
              aria-selected={o.value === value}
              disabled={o.disabled}
              onClick={() => onPick(o.value)}
              title={o.title || o.label}
            >
              <span className="grow">{o.label}</span>
              {o.hint && <span className="dim">{o.hint}</span>}
              {o.value === value && <Check size={13} />}
            </button>
          </React.Fragment>
        );
      })}
      {!shown.length && <div className="menu-head">Nothing matches</div>}
    </div>
  );
};

export const Menu: React.FC<{
  trigger: (props: { onClick: (e: React.MouseEvent<HTMLElement>) => void; 'aria-expanded': boolean }) => React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  up?: boolean;
  left?: boolean;
  fixed?: boolean;
}> = ({ trigger, children, up, left, fixed }) => {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<React.CSSProperties | undefined>(undefined);
  const ref = useRef<HTMLSpanElement>(null);
  const toggle = (e: React.MouseEvent<HTMLElement>) => {
    if (!open && fixed) {
      const r = layoutRect(e.currentTarget);
      const vp = viewport();
      // Open on the side with more room, and scroll inside rather than run off the screen.
      const below = vp.h - r.bottom - 12;
      const above = r.top - 12;
      const flip = below < 240 && above > below;
      setPlace({
        position: 'fixed',
        right: Math.max(8, vp.w - r.right),
        left: 'auto',
        top: flip ? 'auto' : r.bottom + 6,
        bottom: flip ? vp.h - r.top + 6 : 'auto',
        maxHeight: Math.max(140, (flip ? above : below) - 6),
        overflowY: 'auto',
      });
    }
    setOpen((o) => !o);
  };
  useEffect(() => {
    if (!open) return;
    const token = pushLayer();
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    // A fixed menu would float away from its row, so any scroll outside it closes it.
    const moved = (e: Event) => !ref.current?.contains(e.target as Node) && setOpen(false);
    if (fixed) {
      window.addEventListener('scroll', moved, true);
      window.addEventListener('resize', moved);
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !isTop(token)) return;
      // Capture phase + stop: the drawer and the page-level shortcuts never see this Escape.
      e.stopPropagation();
      setOpen(false);
      ref.current?.querySelector<HTMLElement>('button')?.focus();
    };
    window.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc, true);
    return () => {
      popLayer(token);
      window.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc, true);
      window.removeEventListener('scroll', moved, true);
      window.removeEventListener('resize', moved);
    };
  }, [open, fixed]);
  return (
    <span className="menu-anchor" ref={ref}>
      {trigger({ onClick: toggle, 'aria-expanded': open })}
      {open && (
        <div className={`menu${up ? ' up' : ''}${left ? ' left' : ''}`} style={fixed ? place : undefined}>
          {children(() => setOpen(false))}
        </div>
      )}
    </span>
  );
};

/** Chip editor: Enter or comma adds, Backspace on empty removes the last. */
/**
 * A tag's colour: one of eight tones, picked from the name itself, so "ready" is the same green
 * in the table, in the editor and in the filter — and two tags rarely collide. Written as a
 * class (`tag-c3`), coloured in index.css so both themes stay readable.
 */
export const tagTone = (tag: string) => {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.toLowerCase().charCodeAt(i)) >>> 0;
  return `tag-c${h % 8}`;
};

export const TagInput: React.FC<{
  value: string[];
  onChange: (tags: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
  id?: string;
  /** Accessible name when there is no <label htmlFor>, or once chips replace the placeholder. */
  label?: string;
}> = ({ value, onChange, suggestions = [], placeholder = 'Add tag…', id, label }) => {
  const [draft, setDraft] = useState('');
  const add = (raw: string) => {
    const t = raw.trim().toLowerCase().slice(0, 24);
    if (t && !value.includes(t) && value.length < 20) onChange([...value, t]); // the server keeps 20
    setDraft('');
  };
  const listId = id ? `${id}-list` : undefined;
  return (
    <div className="tag-input">
      {value.map((t) => (
        <span key={t} className={`chip ${tagTone(t)}`}>
          {t}
          <button type="button" onClick={() => onChange(value.filter((x) => x !== t))} aria-label={`Remove ${t}`}>
            <X size={10} />
          </button>
        </span>
      ))}
      <input
        id={id}
        aria-label={label}
        list={listId}
        value={draft}
        placeholder={value.length ? '' : placeholder}
        onChange={(e) => (e.target.value.endsWith(',') ? add(e.target.value.slice(0, -1)) : setDraft(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add(draft);
          } else if (e.key === 'Backspace' && !draft && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => draft && add(draft)}
      />
      {listId && (
        <datalist id={listId}>
          {suggestions.filter((s) => !value.includes(s)).map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ *
 * Profile presentation shared by table, drawer, and trash
 * ------------------------------------------------------------------ */

export { Avatar } from './faces';

export const ago = (iso?: string) => {
  if (!iso) return '—';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
};

export const StatusBadge: React.FC<{ s: SessionRecord }> = ({ s }) => {
  const uptime = useElapsed(s.status === 'live' ? s.liveInfo?.startedAt : null);
  if (s.status === 'live')
    return (
      <span className="badge live" title={s.liveInfo?.slot ? `Thread ${s.liveInfo.slot} (the number on its taskbar icon)` : undefined}>
        <span className="dot" />
        {s.liveInfo?.slot ? <b className="thread-no">#{s.liveInfo.slot}</b> : null}
        {uptime || 'Live'}
      </span>
    );
  if (s.status === 'queued')
    return (
      <span className="badge queued">
        <span className="dot" />
        Queued
      </span>
    );
  if (s.status === 'error')
    return (
      <span className="badge error" title={s.lastResult?.reason}>
        <CircleAlert size={11} />
        Error<span className="sr-only">: {s.lastResult?.reason || 'unknown'}</span>
      </span>
    );
  return <span className="badge">{s.status === 'completed' ? 'Done' : 'Ready'}</span>;
};

/* ------------------------------------------------------------------ *
 * Hooks
 * ------------------------------------------------------------------ */

export function useStored<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`smp.${key}`);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(`smp.${key}`, JSON.stringify(value));
    } catch {
      /* private mode: in-memory only */
    }
  }, [key, value]);
  return [value, setValue] as const;
}

/**
 * Page a list. `resetKey` describes what the user changed (filter, query, sort) —
 * never the item count, or a profile going live would bounce them to page 1.
 */
export function usePaged<T>(items: T[], pageSize: number, resetKey = '') {
  const [page, setPage] = useState(1);
  const [seen, setSeen] = useState({ resetKey, pageSize });
  if (seen.resetKey !== resetKey || seen.pageSize !== pageSize) {
    setSeen({ resetKey, pageSize });
    setPage(1);
  }
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(page, pages);
  const start = (current - 1) * pageSize;
  return {
    page: current,
    pages,
    setPage,
    slice: items.slice(start, start + pageSize),
    from: items.length ? start + 1 : 0,
    to: Math.min(start + pageSize, items.length),
  };
}

const elapsed = (since: string) => {
  const secs = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(secs / 3600);
  return h ? `${h}:${pad(Math.floor((secs % 3600) / 60))}:${pad(secs % 60)}` : `${Math.floor(secs / 60)}:${pad(secs % 60)}`;
};

/** Ticking elapsed-time label for an ISO start timestamp. */
export function useElapsed(since?: string | null) {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    if (!since) {
      setLabel(null);
      return;
    }
    const update = () => setLabel(elapsed(since));
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [since]);
  return label;
}

/** Reads a user-picked file as text. */
export const pickTextFile = (accept: string) =>
  new Promise<string | null>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      f.text().then(resolve, () => resolve(null));
    };
    input.click();
  });
