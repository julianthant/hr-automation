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

  it("renders the dynamic configuration path as the compact ruled strip", () => {
    const configurationPath = source.match(
      /<ol\s+aria-label="Run configuration path"[\s\S]*?<\/ol>/,
    )?.[0];

    assert.ok(configurationPath, "expected the numbered run configuration path");
    assert.match(configurationPath, /border-b border-\[color:var\(--ds-border\)\] pb-\[var\(--ds-space-cozy\)\]/);
    assert.match(configurationPath, /dsText\.micro/);
    assert.match(configurationPath, /bg-\[var\(--ds-surface-3\)\]/);
    assert.doesNotMatch(configurationPath, /dsText\.meta/);
  });

  it("places the configuration path above the workflow title and settings", () => {
    const configurationPathIndex = source.indexOf('aria-label="Run configuration path"');
    const workflowTitleIndex = source.indexOf(">\{workflow.label\}</h3>");

    assert.notEqual(configurationPathIndex, -1, "expected the configuration path");
    assert.notEqual(workflowTitleIndex, -1, "expected the workflow title");
    assert.ok(configurationPathIndex < workflowTitleIndex, "the stepper must be the first launcher row");
  });
});
