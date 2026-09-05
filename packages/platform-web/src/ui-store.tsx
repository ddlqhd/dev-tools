import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

/**
 * Overlay state that must be reachable from anywhere (command palette, hotkeys),
 * even though the dialogs themselves are rendered by the pages that own them.
 */
type UiStore = {
  commandOpen: boolean;
  setCommandOpen: (open: boolean) => void;
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
  createOpen: boolean;
  /** Jumps to the board first, since that is where the composer lives. */
  openCreate: () => void;
  closeCreate: () => void;
  anyOverlayOpen: boolean;
};

const UiContext = createContext<UiStore | null>(null);

export function useUi(): UiStore {
  const store = useContext(UiContext);
  if (!store) throw new Error("useUi must be used inside <UiProvider>");
  return store;
}

export function UiProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [commandOpen, setCommandOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const openCreate = useCallback(() => {
    setCommandOpen(false);
    navigate("/");
    setCreateOpen(true);
  }, [navigate]);

  const closeCreate = useCallback(() => setCreateOpen(false), []);

  const value = useMemo<UiStore>(
    () => ({
      commandOpen,
      setCommandOpen,
      helpOpen,
      setHelpOpen,
      createOpen,
      openCreate,
      closeCreate,
      anyOverlayOpen: commandOpen || helpOpen || createOpen,
    }),
    [commandOpen, helpOpen, createOpen, openCreate, closeCreate],
  );

  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}
