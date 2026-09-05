import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ToastKind = "success" | "error" | "info";

type ToastItem = {
  id: number;
  kind: ToastKind;
  message: string;
  detail?: string;
};

export type ToastApi = {
  success: (message: string) => void;
  info: (message: string) => void;
  /** Errors linger longer and expose the raw message behind a disclosure. */
  error: (message: string, detail?: unknown) => void;
};

const noop: ToastApi = { success: () => {}, info: () => {}, error: () => {} };
const ToastContext = createContext<ToastApi>(noop);

const DISMISS_MS: Record<ToastKind, number> = {
  success: 3_000,
  info: 3_000,
  error: 8_000,
};

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

/** Normalizes the `unknown` thrown by fetch wrappers into displayable text. */
export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((kind: ToastKind, message: string, detail?: string) => {
    const id = nextId.current++;
    setItems((prev) => [...prev.slice(-3), { id, kind, message, detail }]);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      success: (message) => push("success", message),
      info: (message) => push("info", message),
      error: (message, detail) => {
        const raw = detail === undefined ? undefined : errorText(detail);
        push("error", message, raw && raw !== message ? raw : undefined);
      },
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-viewport" aria-live="polite">
        {items.map((item) => (
          <ToastRow key={item.id} item={item} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastRow({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (expanded) return;
    const timer = setTimeout(() => onDismiss(item.id), DISMISS_MS[item.kind]);
    return () => clearTimeout(timer);
  }, [expanded, item.id, item.kind, onDismiss]);

  return (
    <div
      className={`toast toast--${item.kind}`}
      role={item.kind === "error" ? "alert" : undefined}
    >
      <span className="toast-icon" aria-hidden="true">
        <ToastIcon kind={item.kind} />
      </span>
      <div className="toast-content">
        <p className="toast-message">{item.message}</p>
        {item.detail && (
          <>
            <button
              type="button"
              className="toast-disclosure"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "收起详情" : "查看详情"}
            </button>
            {expanded && <pre className="toast-detail">{item.detail}</pre>}
          </>
        )}
      </div>
      <button
        type="button"
        className="toast-close"
        aria-label="关闭提示"
        onClick={() => onDismiss(item.id)}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path
            d="M3 3l6 6M9 3l-6 6"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}

function ToastIcon({ kind }: { kind: ToastKind }) {
  if (kind === "success") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="7" fill="currentColor" opacity="0.16" />
        <path
          d="M4.75 8.25l2.25 2.25 4.25-4.75"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (kind === "error") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="7" fill="currentColor" opacity="0.16" />
        <path d="M8 4.25v4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="8" cy="11.25" r="0.9" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="7" fill="currentColor" opacity="0.16" />
      <path d="M8 7.25v4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="8" cy="4.75" r="0.9" fill="currentColor" />
    </svg>
  );
}
