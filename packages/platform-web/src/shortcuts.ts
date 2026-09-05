import { useEffect, useRef } from "react";

/**
 * Combo syntax: `mod+k` (Cmd on macOS, Ctrl elsewhere), `shift+/`, plain `c`,
 * or a Linear-style sequence written as `g b`.
 */
export type KeyBinding = {
  combo: string;
  run: (event: KeyboardEvent) => void;
  /** Fire even while focus sits in a text field. Default false. */
  whenTyping?: boolean;
  enabled?: boolean;
};

/** Sequences reset if the second key does not arrive in time. */
const SEQUENCE_TIMEOUT_MS = 1_200;

export const IS_MAC =
  typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Renders `mod+k` as `⌘K` on macOS and `Ctrl K` elsewhere. */
export function formatCombo(combo: string): string {
  return combo
    .split(" ")
    .map((chunk) =>
      chunk
        .split("+")
        .map((part) => {
          if (part === "mod") return IS_MAC ? "⌘" : "Ctrl";
          if (part === "shift") return IS_MAC ? "⇧" : "Shift";
          if (part === "alt") return IS_MAC ? "⌥" : "Alt";
          if (part === "enter") return "↵";
          if (part === "escape") return "Esc";
          return part.length === 1 ? part.toUpperCase() : part;
        })
        .join(IS_MAC ? "" : "+"),
    )
    .join(" ");
}

function eventToken(e: KeyboardEvent): string | null {
  const key = e.key;
  if (!key || key === "Shift" || key === "Control" || key === "Alt" || key === "Meta") return null;

  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("mod");
  if (e.altKey) parts.push("alt");

  const named = key.length === 1 ? key.toLowerCase() : key.toLowerCase();
  // `shift` is only meaningful for keys that don't already change identity with it
  // (`?` is its own key, `Shift+J` is just `j` with shift).
  if (e.shiftKey && key.length > 1) parts.push("shift");

  parts.push(named);
  return parts.join("+");
}

/**
 * Registers global key bindings for as long as the component is mounted.
 * Bindings are matched in array order; the first match wins and stops propagation.
 */
export function useKeyBindings(bindings: KeyBinding[]) {
  const ref = useRef(bindings);
  ref.current = bindings;

  useEffect(() => {
    let prefix: string | null = null;
    let prefixTimer: ReturnType<typeof setTimeout> | undefined;

    const clearPrefix = () => {
      prefix = null;
      if (prefixTimer) clearTimeout(prefixTimer);
      prefixTimer = undefined;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const token = eventToken(e);
      if (!token) return;
      const typing = isTypingTarget(e.target);
      const active = ref.current.filter((b) => b.enabled !== false);

      if (prefix) {
        const sequence = `${prefix} ${token}`;
        clearPrefix();
        const hit = active.find((b) => b.combo === sequence && (b.whenTyping || !typing));
        if (hit) {
          e.preventDefault();
          hit.run(e);
        }
        return;
      }

      const hit = active.find((b) => b.combo === token && (b.whenTyping || !typing));
      if (hit) {
        e.preventDefault();
        hit.run(e);
        return;
      }

      if (typing) return;
      const isPrefix = active.some((b) => b.combo.startsWith(`${token} `));
      if (isPrefix) {
        prefix = token;
        prefixTimer = setTimeout(clearPrefix, SEQUENCE_TIMEOUT_MS);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      clearPrefix();
    };
  }, []);
}
