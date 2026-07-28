/**
 * DEV-ONLY — WHERE THE OPERATOR HAS BEEN.
 *
 * A queue row can send you somewhere else: the `OCR review · done ↗` chip, the
 * `person lookup · fa… ↗` chip, the `← Oath Upload` back link, a notification,
 * a search hit. Every one of those changes the panel AND the selected row, and
 * until now the only way back was to remember which of fifteen workflows you
 * came from and which of its rows you were on. Operator: *"there should be like
 * a back and forth button so when i click on like a link to go to a different
 * workflow from a queue row, i can quickly go back to my previous workflow."*
 *
 * This is that history, and it is a PURE value so the semantics can be pinned
 * by a test rather than driven through a shell. The rules are the browser's,
 * because the browser's are the ones the operator already knows:
 *
 *  - A **place** is the triple that reproduces the view — the panel, the row
 *    inside it, and the tab that row was open on. Restoring two of the three
 *    lands you on the right row with the wrong thing showing, which is the
 *    failure mode that makes a back button not worth pressing.
 *  - Going somewhere **truncates the forward branch**. There is no tree.
 *  - Landing on the place you are already standing on is **not a move**, so a
 *    re-render, a tick, or re-selecting the same row cannot pad the history
 *    with entries that go nowhere.
 *  - Moving through the history does **not** push. That is the difference
 *    between a history and a log, and getting it wrong makes Back a loop of
 *    two entries.
 *  - The list is **capped**; the oldest end is dropped, and the index moves
 *    with it so the cap can never silently teleport the operator.
 */

/** the smallest triple that reproduces a view exactly */
export interface DemoNavPlace {
  workflow: string;
  rowId: string;
  /** the detail tab the row was open on; `null` = the row's own default */
  tab: string | null;
}

export interface DemoNavHistory {
  places: DemoNavPlace[];
  /** which of them the operator is standing on */
  index: number;
}

/**
 * How far back the operator can go. Deep enough that a session of cross-panel
 * link-following never runs out, shallow enough that the array is not a leak.
 */
export const NAV_HISTORY_LIMIT = 50;

export function initNavHistory(place: DemoNavPlace): DemoNavHistory {
  return { places: [place], index: 0 };
}

export function samePlace(a: DemoNavPlace | undefined, b: DemoNavPlace | undefined): boolean {
  if (!a || !b) return false;
  return a.workflow === b.workflow && a.rowId === b.rowId && a.tab === b.tab;
}

export function currentPlace(history: DemoNavHistory): DemoNavPlace | undefined {
  return history.places[history.index];
}

export function canGoBack(history: DemoNavHistory): boolean {
  return history.index > 0;
}

export function canGoForward(history: DemoNavHistory): boolean {
  return history.index < history.places.length - 1;
}

/**
 * Arrive somewhere. Truncates whatever was ahead, ignores a no-op, and drops
 * the oldest entry once the cap is reached.
 */
export function pushPlace(history: DemoNavHistory, place: DemoNavPlace): DemoNavHistory {
  if (samePlace(currentPlace(history), place)) return history;
  const kept = history.places.slice(0, history.index + 1);
  kept.push(place);
  // The oldest end goes, and the index goes with it — a cap that moved the
  // list without moving the cursor would silently change where "here" is.
  const overflow = Math.max(0, kept.length - NAV_HISTORY_LIMIT);
  const places = overflow > 0 ? kept.slice(overflow) : kept;
  return { places, index: places.length - 1 };
}

export function goBack(history: DemoNavHistory): DemoNavHistory {
  return canGoBack(history) ? { ...history, index: history.index - 1 } : history;
}

export function goForward(history: DemoNavHistory): DemoNavHistory {
  return canGoForward(history) ? { ...history, index: history.index + 1 } : history;
}

/**
 * What the control says it will do. A back button that only says "Back" makes
 * the operator press it to find out where it goes; naming the destination is
 * what turns two glyphs into a route they can plan with.
 */
export function navDestinationLabel(
  history: DemoNavHistory,
  direction: "back" | "forward",
  nameRow: (rowId: string) => string | undefined,
): string | undefined {
  const target = history.places[direction === "back" ? history.index - 1 : history.index + 1];
  if (!target) return undefined;
  const row = nameRow(target.rowId);
  return row ? `${target.workflow} · ${row}` : target.workflow;
}
