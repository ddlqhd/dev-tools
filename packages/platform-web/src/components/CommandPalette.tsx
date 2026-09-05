import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatCombo } from "../shortcuts";

export type CommandItem = {
  id: string;
  group: string;
  label: string;
  /** Secondary line: repo, branch, current node — also searchable. */
  hint?: string;
  combo?: string;
  danger?: boolean;
  run: () => void;
};

/**
 * Subsequence match with bonuses for consecutive runs and boundary starts.
 * Returns null when the query does not match at all.
 */
function score(text: string, query: string): number | null {
  if (!query) return 0;
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  let total = 0;
  let at = 0;
  let streak = 0;
  for (const ch of needle) {
    const found = haystack.indexOf(ch, at);
    if (found < 0) return null;
    streak = found === at && at > 0 ? streak + 1 : 0;
    total += 10 + streak * 6;
    if (found === 0 || /[\s/\-_:#]/.test(haystack[found - 1] ?? "")) total += 8;
    total -= Math.min(found - at, 12);
    at = found + 1;
  }
  return total;
}

function rank(items: CommandItem[], query: string): CommandItem[] {
  if (!query.trim()) return items;
  const q = query.trim();
  return items
    .map((item) => {
      const direct = score(item.label, q);
      const viaHint = item.hint ? score(item.hint, q) : null;
      const best =
        direct == null ? (viaHint == null ? null : viaHint - 20) : Math.max(direct, (viaHint ?? -Infinity) - 20);
      return best == null ? null : { item, best };
    })
    .filter((x): x is { item: CommandItem; best: number } => x !== null)
    .sort((a, b) => b.best - a.best)
    .map((x) => x.item);
}

export function CommandPalette({
  open,
  items,
  onClose,
}: {
  open: boolean;
  items: CommandItem[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => rank(items, query).slice(0, 60), [items, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useLayoutEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, results]);

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  if (!open) return null;

  const runAt = (index: number) => {
    const item = results[index];
    if (!item) return;
    onClose();
    item.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown" || (e.key === "n" && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      setActiveIndex((i) => (results.length === 0 ? 0 : (i + 1) % results.length));
      return;
    }
    if (e.key === "ArrowUp" || (e.key === "p" && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      setActiveIndex((i) => (results.length === 0 ? 0 : (i - 1 + results.length) % results.length));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      runAt(activeIndex);
    }
  };

  let lastGroup = "";

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="palette-input">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="4.75" stroke="currentColor" strokeWidth="1.4" />
            <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索任务，或输入命令…"
            aria-label="搜索任务或命令"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="kbd">Esc</kbd>
        </div>

        <div className="palette-list" ref={listRef} role="listbox">
          {results.length === 0 && <p className="palette-empty">没有匹配的任务或命令</p>}
          {results.map((item, index) => {
            const showGroup = item.group !== lastGroup;
            lastGroup = item.group;
            return (
              <div key={item.id}>
                {showGroup && <p className="palette-group">{item.group}</p>}
                <button
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  data-active={index === activeIndex}
                  className={`palette-item${item.danger ? " palette-item--danger" : ""}`}
                  onMouseMove={() => setActiveIndex(index)}
                  onClick={() => runAt(index)}
                >
                  <span className="palette-item-text">
                    <span className="palette-item-label">{item.label}</span>
                    {item.hint && <span className="palette-item-hint">{item.hint}</span>}
                  </span>
                  {item.combo && <kbd className="kbd">{formatCombo(item.combo)}</kbd>}
                </button>
              </div>
            );
          })}
        </div>

        <div className="palette-foot">
          <span>
            <kbd className="kbd">↑</kbd>
            <kbd className="kbd">↓</kbd> 选择
          </span>
          <span>
            <kbd className="kbd">↵</kbd> 执行
          </span>
          <span>
            <kbd className="kbd">?</kbd> 快捷键
          </span>
        </div>
      </div>
    </div>
  );
}
