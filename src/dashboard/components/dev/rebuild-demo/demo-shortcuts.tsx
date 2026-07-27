import { cn } from "@/lib/utils";
import { Kbd, SectionLabel, dsText } from "./demo-ui";

/**
 * DEV-ONLY — the demo's whole keyboard flow, in ONE registry.
 *
 * It lives in its own module because two surfaces render it and neither may own
 * it: the Top Bar's shortcuts Popover (reachable from every view, which is what
 * makes it discoverable) and the Settings → Help page (where an operator goes
 * to *learn* the product rather than to remember one key).
 *
 * **A shortcut that is not in this array is undocumented, and a binding that is
 * not here is unreachable from Help.** That is the point of the single home:
 * `DESIGN.md` binds the row context menu's keyboard route to this registry, and
 * a second hand-written legend somewhere else is exactly how a key comes to be
 * bound in one file and described in another.
 *
 * `where` is the SCOPE the binding actually has in `RebuildDemo.tsx`'s window
 * handler — not a category invented for the legend. It is what lets the Help
 * page group the list without the grouping being a second opinion about what
 * the keys do.
 */

export type DemoShortcutScope = "Anywhere" | "The queue" | "The detail panel";

export interface DemoShortcut {
  keys: string[];
  /** the separator drawn between two keys that are a RANGE, not a pair */
  join?: string;
  what: string;
  where: DemoShortcutScope;
}

export const DEMO_SHORTCUTS: DemoShortcut[] = [
  { keys: ["r"], what: "start a run — any workflow, from any view", where: "Anywhere" },
  { keys: ["j", "k"], what: "move down / up the queue", where: "The queue" },
  { keys: ["n"], what: "jump to the next row waiting on you", where: "The queue" },
  { keys: ["Enter"], what: "open the selected group", where: "The queue" },
  // The keyboard route to the row context menu. Right-click and the platform's
  // own Menu / Shift+F10 key open the same menu; this one does not depend on
  // the operator's keyboard having that key, and it works from the SELECTION
  // rather than from focus.
  { keys: ["m"], what: "every command on the selected row", where: "The queue" },
  { keys: ["Esc"], what: "back out of a group", where: "The queue" },
  { keys: ["c"], what: "mark the selected member checked", where: "The queue" },
  { keys: ["1", "4"], join: "–", what: "switch the detail panel's tab", where: "The detail panel" },
  { keys: ["w"], what: "cycle the Workflow Panel — floating, icon, sidebar", where: "Anywhere" },
];

/** the registry, in scope order, with empty scopes dropped */
export function shortcutsByScope(
  shortcuts: readonly DemoShortcut[] = DEMO_SHORTCUTS,
): { scope: DemoShortcutScope; shortcuts: DemoShortcut[] }[] {
  const order: DemoShortcutScope[] = ["Anywhere", "The queue", "The detail panel"];
  return order
    .map((scope) => ({ scope, shortcuts: shortcuts.filter((s) => s.where === scope) }))
    .filter((group) => group.shortcuts.length > 0);
}

/** the key cluster for one binding — `j k` as a pair, `1–4` as a range */
export function ShortcutKeys({ shortcut }: { shortcut: DemoShortcut }) {
  return (
    <span className="flex shrink-0 items-center gap-[var(--ds-space-tight)]">
      {shortcut.keys.map((key, index) => (
        <span key={key} className="inline-flex items-center gap-[var(--ds-space-tight)]">
          {index > 0 && shortcut.join && (
            <span aria-hidden className={cn(dsText.meta, "text-[color:var(--ds-fg-faint)]")}>
              {shortcut.join}
            </span>
          )}
          <Kbd>{key}</Kbd>
        </span>
      ))}
    </span>
  );
}

/**
 * The legend, as a definition list. ONE renderer, so the Popover in the Top Bar
 * and the Help page cannot describe the same key two different ways.
 *
 * `grouped` is the only difference between the two consumers, and it is a
 * density decision rather than a content one: a 380px popover reads better as
 * one uninterrupted list, a full page reads better with the scope named.
 */
export function DemoShortcutsLegend({
  grouped = false,
  className,
}: {
  grouped?: boolean;
  className?: string;
}) {
  if (!grouped) {
    return (
      <dl className={cn("flex flex-col gap-[var(--ds-space-snug)]", className)}>
        {DEMO_SHORTCUTS.map((shortcut) => (
          <ShortcutRow key={shortcut.what} shortcut={shortcut} />
        ))}
      </dl>
    );
  }

  return (
    <div className={cn("flex flex-col gap-[var(--ds-space-loose)]", className)}>
      {shortcutsByScope().map((group) => (
        <div key={group.scope} className="flex min-w-0 flex-col gap-[var(--ds-space-snug)]">
          <SectionLabel>{group.scope}</SectionLabel>
          <dl className="flex flex-col gap-[var(--ds-space-snug)]">
            {group.shortcuts.map((shortcut) => (
              <ShortcutRow key={shortcut.what} shortcut={shortcut} />
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}

function ShortcutRow({ shortcut }: { shortcut: DemoShortcut }) {
  return (
    <div className="flex items-baseline gap-[var(--ds-space-base)]">
      <dt className="flex shrink-0 items-center gap-[var(--ds-space-tight)]">
        <ShortcutKeys shortcut={shortcut} />
      </dt>
      <dd className={cn(dsText.body, "min-w-0 text-[color:var(--ds-fg-secondary)]")}>{shortcut.what}</dd>
    </div>
  );
}
