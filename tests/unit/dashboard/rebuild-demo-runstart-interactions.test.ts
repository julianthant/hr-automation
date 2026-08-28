import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

const source = readFileSync(
  new URL("../../../src/dashboard/components/dev/rebuild-demo/DemoRunStart.tsx", import.meta.url),
  "utf8",
);

describe("rebuild demo run-start interactions", () => {
  it("keeps the settings menu non-modal inside the run dialog", () => {
    assert.match(
      source,
      /<DropdownMenu\s+modal=\{false\}\s+open=\{settingsOpen\}/,
      "a modal DropdownMenu pointer-locks the parent Dialog; its next body click dismisses both layers",
    );
  });

  it("renders the opt-in options directly on the launcher surface", () => {
    const optionsStage = source.match(
      /\{currentStage === "Options"[\s\S]*?\{currentStage === "Confirm"/,
    )?.[0];

    assert.ok(optionsStage, "expected the Options stage before Confirm");
    assert.doesNotMatch(
      optionsStage,
      /bg-\[var\(--ds-recess-bg\)\]/,
      "the Options controls must not reintroduce a separate black recessed panel",
    );
  });
});
