import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** Ordered reference of every dashboard keyboard shortcut. */
const SHORTCUTS: { keys: string[]; desc: string }[] = [
  { keys: ["↑", "↓"], desc: "Move selection between queue rows" },
  { keys: ["Ctrl", "Shift", "R"], desc: "Retry the selected row" },
  { keys: ["x"], desc: "Cancel the selected row" },
  { keys: ["/"], desc: "Focus the search bar" },
  { keys: ["[", "]"], desc: "Previous / next workflow" },
  { keys: ["g", "t"], desc: "Go to today" },
  { keys: ["?"], desc: "Toggle this shortcuts guide" },
  { keys: ["Esc"], desc: "Close dialogs / deselect" },
  { keys: ["⌘/Ctrl", "J"], desc: "Toggle the session drawer" },
];

export function ShortcutsGuide({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[460px] p-0">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <ul className="flex flex-col gap-1 px-5 py-4">
          {SHORTCUTS.map((s) => (
            <li
              key={s.desc}
              className="flex items-center gap-3 rounded-md px-1.5 py-1.5 text-[13px]"
            >
              <span className="flex shrink-0 items-center gap-1">
                {s.keys.map((k) => (
                  <kbd
                    key={k}
                    className="inline-flex min-w-[22px] justify-center rounded-md border border-b-2 border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground"
                  >
                    {k}
                  </kbd>
                ))}
              </span>
              <span className="text-muted-foreground">{s.desc}</span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
