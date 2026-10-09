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

const STORAGE_KEY = "terminal-drawer-open";

interface TerminalDrawerCtx {
  open: boolean;
  toggle: () => void;
  openDrawer: () => void;
  closeDrawer: () => void;
  /**
   * Currently-focused session card instance id. Clicking a card sets this;
   * the value is consumed elsewhere (e.g. the LogPanel) to coordinate
   * cross-panel focus. `null` when no card is focused.
   */
  focusedInstance: string | null;
  setFocusedInstance: (id: string | null) => void;
}

const Ctx = createContext<TerminalDrawerCtx | null>(null);

function readInitial(): boolean {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return false;
    return JSON.parse(raw) === true;
  } catch {
    return false;
  }
}

export function TerminalDrawerProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<boolean>(() => readInitial());
  const [focusedInstance, setFocusedInstance] = useState<string | null>(null);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(open));
    } catch {
      /* private mode / quota */
    }
  }, [open]);

  // Cmd+J / Ctrl+J global toggle — VSCode/JetBrains convention. Skip when an
  // editable element has focus so it doesn't fight with text input shortcuts.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() !== "j") return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const editable =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        target?.isContentEditable === true;
      if (editable) return;
      e.preventDefault();
      setOpen((v) => !v);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const toggle = useCallback(() => setOpen((v) => !v), []);
  const openDrawer = useCallback(() => setOpen(true), []);
  const closeDrawer = useCallback(() => setOpen(false), []);

  const value = useMemo<TerminalDrawerCtx>(
    () => ({ open, toggle, openDrawer, closeDrawer, focusedInstance, setFocusedInstance }),
    [open, toggle, openDrawer, closeDrawer, focusedInstance],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTerminalDrawer(): TerminalDrawerCtx {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error("useTerminalDrawer must be used inside TerminalDrawerProvider");
  }
  return ctx;
}
