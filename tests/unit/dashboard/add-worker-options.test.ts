/**
 * Unit tests for `buildAddWorkerOptions`, the pure helper behind the terminal
 * drawer's "+" add-worker picker. The ordering contract matters: the operator
 * adds workers to relieve a backlog, so the workflows that actually need
 * capacity must sort to the top — most queued work first, then most running
 * workers, then alphabetical for a stable list. Retired workflows are dropped.
 */

import { test, describe } from "vitest";
import assert from "node:assert/strict";

import {
  buildAddWorkerOptions,
  type AddWorkerOption,
} from "../../../src/dashboard/components/terminal-drawer/AddWorkerButton.js";
import type { WorkflowMetadata } from "../../../src/dashboard/lib/workflows-context.js";

function wf(name: string, label: string, iconName?: string): WorkflowMetadata {
  return {
    name,
    label,
    steps: [],
    systems: [],
    detailFields: [],
    ...(iconName ? { iconName } : {}),
  };
}

function names(options: AddWorkerOption[]): string[] {
  return options.map((o) => o.name);
}

describe("buildAddWorkerOptions", () => {
  test("sorts by queued desc, then workers desc, then label asc", () => {
    const workflows = [
      wf("alpha", "Alpha"),
      wf("bravo", "Bravo"),
      wf("charlie", "Charlie"),
      wf("delta", "Delta"),
    ];
    const workerCounts = { alpha: 1, bravo: 3, charlie: 1, delta: 0 };
    const queuedCounts = { alpha: 5, bravo: 0, charlie: 0, delta: 0 };

    const options = buildAddWorkerOptions(workflows, workerCounts, queuedCounts);

    // alpha wins on queued (5); bravo next on workers (3); charlie vs delta tie
    // on queued+workers fallback (1 vs 0) → charlie before delta.
    assert.deepEqual(names(options), ["alpha", "bravo", "charlie", "delta"]);
  });

  test("alphabetical by label when queued and workers are equal", () => {
    const workflows = [wf("z-last", "Zebra"), wf("a-first", "Apple")];
    const options = buildAddWorkerOptions(workflows, {}, {});
    assert.deepEqual(names(options), ["a-first", "z-last"]);
  });

  test("drops retired workflows from the picker", () => {
    const workflows = [wf("separations", "Separations"), wf("eid-lookup", "EID Lookup")];
    const options = buildAddWorkerOptions(workflows, {}, {});
    assert.deepEqual(names(options), ["separations"]);
  });

  test("defaults missing counts to zero and carries label + icon through", () => {
    const workflows = [wf("separations", "Separations", "UserMinus")];
    const [opt] = buildAddWorkerOptions(workflows, {}, {});
    assert.equal(opt.name, "separations");
    assert.equal(opt.label, "Separations");
    assert.equal(opt.iconName, "UserMinus");
    assert.equal(opt.workers, 0);
    assert.equal(opt.queued, 0);
  });
});
