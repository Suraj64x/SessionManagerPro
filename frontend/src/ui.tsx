import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
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

/* ------------------------------------------------------------------ *
 * Modal — Escape to close, scrim click, focus trap, focus restore
 * ------------------------------------------------------------------ */

export const Modal: React.FC<{
  title: React.ReactNode;
  onClose: () => void;
  width?: number;
  children: React.ReactNode;
  footer?: React.ReactNode;
  belowTitle?: React.ReactNode;
}> = ({ title, onClose, width = 480, children, footer, belowTitle }) => {
  const ref = useRef<HTMLDivElement>(null);

  // Callers pass an inline arrow, and the panel re-renders on every WebSocket frame.
  // Keying the effect on onClose would tear it down and re-focus the dialog many
  // times a second while logs stream, yanking the caret out of whatever you type in.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null;
    const node = ref.current;
    // Land on the first thing worth editing, not on the Close button that precedes it.
    const target =
      node?.querySelector<HTMLElement>('[autofocus]') ??
      node?.querySelector<HTMLElement>('.modal-body input, .modal-body textarea, .modal-body select') ??
      node?.querySelector<HTMLElement>('button');
    target?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !node) return;
      const items = [
        ...node.querySelectorAll<HTMLElement>(
          'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])'
        ),
      ].filter((el) => el.offsetParent !== null);
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
      document.removeEventListener('keydown', onKey, true);
      restore?.focus?.();
    };
  }, []);

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className="modal"
        style={{ maxWidth: width }}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={15} />
          </button>
        </div>
        {belowTitle}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ *
 * Toasts + confirm, behind one provider
 * ------------------------------------------------------------------ */

type ToastKind = 'success' | 'error' | 'info';
type Toast = { id: number; kind: ToastKind; text: string };

type ConfirmOpts = {
  title: string;
  body?: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
};

type UIApi = {
  toast: (kind: ToastKind, text: string) => void;
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
};

const UICtx = createContext<UIApi | null>(null);

export const useUI = (): UIApi => {
  const ctx = useContext(UICtx);
  if (!ctx) throw new Error('useUI must be used inside <UIProvider>');
  return ctx;
};

const TOAST_ICON = { success: CircleCheck, error: CircleAlert, info: Info };

export const UIProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
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
                onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
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
              <button
                className={`btn ${ask.danger ? 'danger' : 'primary'}`}
                onClick={() => settle(true)}
              >
                {ask.confirmLabel || 'Confirm'}
              </button>
            </>
          }
        >
          <p style={{ color: 'var(--txt-2)', fontSize: 12.5 }}>{ask.body}</p>
        </Modal>
      )}
    </UICtx.Provider>
  );
};

/* ------------------------------------------------------------------ *
 * Small shared pieces
 * ------------------------------------------------------------------ */

export const Toolbar: React.FC<{
  title: string;
  count?: number;
  children?: React.ReactNode;
}> = ({ title, count, children }) => (
  <div className="topbar">
    <div className="window-controls">
      <button className="win-btn close" onClick={() => window.close()} aria-label="Close" />
      <button className="win-btn min" aria-label="Minimize" />
      <button className="win-btn max" onClick={() => {
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen().catch(() => {});
        } else {
          document.exitFullscreen().catch(() => {});
        }
      }} aria-label="Maximize" />
    </div>
    <h1>{title}</h1>
    {count !== undefined && <span className="count">{count}</span>}
    <span className="topbar-sep" />
    {children}
  </div>
);

export const Empty: React.FC<{
  icon: React.ReactNode;
  text: string;
  action?: React.ReactNode;
}> = ({ icon, text, action }) => (
  <div className="empty">
    {icon}
    <p>{text}</p>
    {action}
  </div>
);

export const CheckBox: React.FC<{
  state: boolean | 'mixed';
  onClick: () => void;
  label: string;
}> = ({ state, onClick, label }) => {
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
export const Stepper: React.FC<{
  value: number;
  min: number;
  max: number;
  onStep: (delta: 1 | -1) => void;
  label: string;
}> = ({ value, min, max, onStep, label }) => (
  <div className="stepper" role="group" aria-label={label}>
    <button onClick={() => onStep(-1)} disabled={value <= min} aria-label={`${label} down`}>
      <Minus size={13} />
    </button>
    <span aria-live="polite">{value}</span>
    <button onClick={() => onStep(1)} disabled={value >= max} aria-label={`${label} up`}>
      <Plus size={13} />
    </button>
  </div>
);

export const Pager: React.FC<{
  page: number;
  pages: number;
  from: number;
  to: number;
  total: number;
  noun: string;
  pageSize: number;
  onPage: (p: number) => void;
  onPageSize: (n: number) => void;
  standalone?: boolean;
}> = ({ page, pages, from, to, total, noun, pageSize, onPage, onPageSize, standalone }) => (
  <div className={`pager${standalone ? ' standalone' : ''}`}>
    <div>
      <b>
        {from}–{to}
      </b>{' '}
      of <b>{total}</b> {noun}
    </div>
    <div className="pager-nav">
      <div className="select-wrap">
        <select
          className="input"
          style={{ height: 26, fontSize: 11.5, paddingLeft: 8 }}
          value={pageSize}
          onChange={(e) => onPageSize(Number(e.target.value))}
          aria-label="Rows per page"
        >
          {[25, 50, 100, 250].map((n) => (
            <option key={n} value={n}>
              {n} / page
            </option>
          ))}
        </select>
        <ChevronDown size={12} />
      </div>
      <button
        className="icon-btn xs"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
        aria-label="Previous page"
      >
        <ChevronLeft size={15} />
      </button>
      <span style={{ minWidth: 54, textAlign: 'center' }}>
        <b>{page}</b> / {pages}
      </span>
      <button
        className="icon-btn xs"
        disabled={page >= pages}
        onClick={() => onPage(page + 1)}
        aria-label="Next page"
      >
        <ChevronRight size={15} />
      </button>
    </div>
  </div>
);

export const CopyButton: React.FC<{ value: string; label: string; size?: number }> = ({
  value,
  label,
  size = 13,
}) => {
  const [done, setDone] = useState(false);
  const { toast } = useUI();
  return (
    <button
      className="icon-btn xs"
      aria-label={label}
      title={done ? 'Copied' : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        } catch {
          toast('error', 'Clipboard unavailable');
        }
      }}
    >
      {done ? <Check size={size} color="var(--accent)" /> : <Copy size={size} />}
    </button>
  );
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
      /* private mode — fall back to in-memory only */
    }
  }, [key, value]);
  return [value, setValue] as const;
}

/**
 * Page a list. `resetKey` should describe what the user changed (filter, query,
 * page size) — NOT the item count, or a session going live would bounce them
 * back to page 1 mid-read. Out-of-range pages are clamped instead.
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
  return h
    ? `${h}:${pad(Math.floor((secs % 3600) / 60))}:${pad(secs % 60)}`
    : `${Math.floor(secs / 60)}:${pad(secs % 60)}`;
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
