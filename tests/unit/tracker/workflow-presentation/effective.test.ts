import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeOverride } from "../../../../src/tracker/workflow-presentation/override-store.js";
import {
  effectiveMetadata,
  applyOverride,
} from "../../../../src/tracker/workflow-presentation/effective.js";
import type { WorkflowMetadata } from "../../../../src/core/kernel/types.js";

let root: string;
const base: WorkflowMetadata = {
  name: "onboarding",
  label: "Onboarding",
  archetype: "single",
  code: "ob",
  steps: ["a"],
  systems: ["crm"],
  detailFields: [],
  presentation: {
    naming: {
      title: { scheme: "person-name" },
      subtitle: { scheme: "eid-else-trace" },
      trace: { scheme: "code-time-runid" },
    },
  },
};
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "eff-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("applyOverride (pure, no fs)", () => {
  it("null override → base unchanged (deep-equal)", () => {
    expect(applyOverride(base, null)).toEqual(base);
  });

  it("undefined override → base unchanged (deep-equal)", () => {
    expect(applyOverride(base, undefined)).toEqual(base);
  });

  it("label override replaces label", () => {
    expect(applyOverride(base, { label: "X" }).label).toBe("X");
  });

  it("presentation deep-merge: title overridden, subtitle from override kept", () => {
    const result = applyOverride(base, {
      presentation: {
        naming: {
          title: { scheme: "custom-template", template: "{name}" },
          subtitle: { scheme: "eid-else-trace" },
        },
      },
    });
    expect(result.presentation.naming?.title?.scheme).toBe("custom-template");
    expect((result.presentation.naming?.title as { template?: string } | undefined)?.template).toBe("{name}");
    expect(result.presentation.naming?.subtitle?.scheme).toBe("eid-else-trace");
    expect(result.presentation.naming?.trace?.scheme).toBe("code-time-runid");
  });

  it("non-label fields unchanged when not in override", () => {
    const result = applyOverride(base, { label: "New Label" });
    expect(result.steps).toEqual(base.steps);
    expect(result.systems).toEqual(base.systems);
    expect(result.detailFields).toEqual(base.detailFields);
  });
});

describe("effectiveMetadata (fs round-trip)", () => {
  it("no override → base unchanged", () => {
    expect(effectiveMetadata(base, root)).toEqual(base);
  });

  it("label override replaces label", () => {
    writeOverride(root, "onboarding", { label: "HC Onboarding" });
    expect(effectiveMetadata(base, root).label).toBe("HC Onboarding");
  });

  it("presentation override deep-merges (title overridden, subtitle kept)", () => {
    writeOverride(root, "onboarding", {
      presentation: {
        naming: {
          title: { scheme: "custom-template", template: "{name}" },
          subtitle: { scheme: "eid-else-trace" },
        },
      },
    });
    const eff = effectiveMetadata(base, root);
    expect(eff.presentation.naming?.title?.scheme).toBe("custom-template");
    expect(eff.presentation.naming?.subtitle?.scheme).toBe("eid-else-trace");
  });
});
