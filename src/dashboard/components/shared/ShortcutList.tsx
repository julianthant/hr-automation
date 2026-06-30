import { cn } from "@/lib/utils";
import type { KeyboardShortcut } from "../../../domain/settings/reference.js";

/** Renders a list of keyboard shortcuts with kbd chips. */
export function ShortcutList({
  shortcuts,
  className,
}: {
  shortcuts: KeyboardShortcut[];
  className?: string;
}): JSX.Element {
  return (
    <ul className={cn("flex flex-col gap-1", className)}>
      {shortcuts.map((s) => (
        <li
          key={s.description}
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
          <span className="text-muted-foreground">{s.description}</span>
        </li>
      ))}
    </ul>
  );
}
