import { useCallback, useEffect, useState } from "react";

export interface UseCommandPaletteResult {
  open: boolean;
  setOpen: (next: boolean) => void;
  toggle: () => void;
}

/**
 * Owns ⌘K / Ctrl+K open/close state. Mirrors useTerminalDrawer's
 * Cmd+J pattern. Esc closes; clicking a result also closes (each
 * caller handles that locally and calls setOpen(false)).
 */
export function useCommandPalette(): UseCommandPaletteResult {
  const [open, setOpen] = useState(false);

  const toggle = useCallback(() => setOpen((prev) => !prev), []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toggle();
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, toggle]);

  return { open, setOpen, toggle };
}
