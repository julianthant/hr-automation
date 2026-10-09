import { describe, expect, it } from "vitest";
import {
  NAV_HISTORY_LIMIT,
  canGoBack,
  canGoForward,
  currentPlace,
  goBack,
  goForward,
  initNavHistory,
  navDestinationLabel,
  pushPlace,
  type DemoNavPlace,
} from "@/components/dev/rebuild-demo/demo-nav-history";

const place = (n: number): DemoNavPlace => ({
  workflow: `Workflow ${n}`,
  rowId: `row-${n}`,
  tab: n % 2 === 0 ? "logs" : "review",
});

describe("rebuild demo — cross-workflow navigation history", () => {
  it("restores workflow, row, and tab in both directions", () => {
    const first = initNavHistory(place(1));
    const second = pushPlace(first, place(2));
    const third = pushPlace(second, place(3));

    expect(currentPlace(goBack(third))).toEqual(place(2));
    expect(currentPlace(goForward(goBack(third)))).toEqual(place(3));
    expect(canGoBack(third)).toBe(true);
    expect(canGoForward(third)).toBe(false);
  });

  it("truncates forward history after a new destination and ignores no-op pushes", () => {
    const atThird = pushPlace(pushPlace(initNavHistory(place(1)), place(2)), place(3));
    const atSecond = goBack(atThird);
    const branched = pushPlace(atSecond, place(4));

    expect(branched.places).toEqual([place(1), place(2), place(4)]);
    expect(canGoForward(branched)).toBe(false);
    expect(pushPlace(branched, place(4))).toBe(branched);
  });

  it("caps the oldest end without moving the current destination", () => {
    let history = initNavHistory(place(0));
    for (let n = 1; n <= NAV_HISTORY_LIMIT + 4; n += 1) history = pushPlace(history, place(n));

    expect(history.places).toHaveLength(NAV_HISTORY_LIMIT);
    expect(currentPlace(history)).toEqual(place(NAV_HISTORY_LIMIT + 4));
  });

  it("names the destination using the row when it is available", () => {
    const history = pushPlace(initNavHistory(place(1)), place(2));

    expect(navDestinationLabel(history, "back", (rowId) => rowId === "row-1" ? "Packet.pdf" : undefined))
      .toBe("Workflow 1 · Packet.pdf");
    expect(navDestinationLabel(goBack(history), "forward", () => undefined)).toBe("Workflow 2");
  });
});
