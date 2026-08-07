import { useCallback, useEffect, useState } from "react";

export type ThemeChoice = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "codeloop-theme";
const MEDIA = "(prefers-color-scheme: dark)";

function resolve(choice: ThemeChoice): ResolvedTheme {
  if (choice !== "system") return choice;
  return window.matchMedia(MEDIA).matches ? "dark" : "light";
}

function apply(choice: ThemeChoice) {
  document.documentElement.dataset.theme = resolve(choice);
}

export function getInitialChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* ignore */
  }
  return "system";
}

export function useTheme(): [ThemeChoice, (t: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(getInitialChoice);

  useEffect(() => {
    apply(choice);
    try {
      localStorage.setItem(STORAGE_KEY, choice);
    } catch {
      /* ignore */
    }
    if (choice !== "system") return;
    const mq = window.matchMedia(MEDIA);
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [choice]);

  return [choice, useCallback((t: ThemeChoice) => setChoice(t), [])];
}
