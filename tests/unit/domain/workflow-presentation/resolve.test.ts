// tests/unit/domain/workflow-presentation/resolve.test.ts
import { describe, it, expect } from "vitest";
import {
  defaultPresentationFromMetadata,
  mergePresentation,
} from "../../../../src/domain/workflow-presentation/resolve.js";

describe("defaultPresentationFromMetadata", () => {
  it("person-subject workflow → person-name title, eid-else-trace subtitle", () => {
    const p = defaultPresentationFromMetadata({ inputSubject: "eid", archetype: "single" });
    expect(p.naming?.title?.scheme).toBe("person-name");
    expect(p.naming?.subtitle?.scheme).toBe("eid-else-trace");
  });

  it("pdf-subject workflow → pdf-filename title, trace-only subtitle", () => {
    const p = defaultPresentationFromMetadata({ inputSubject: "pdf", archetype: "preview" });
    expect(p.naming?.title?.scheme).toBe("pdf-filename");
    expect(p.naming?.subtitle?.scheme).toBe("trace-only");
  });

  it("selector-subject workflow → catalog-label title", () => {
    const p = defaultPresentationFromMetadata({ inputSubject: "selector", archetype: "single" });
    expect(p.naming?.title?.scheme).toBe("catalog-label");
  });

  it("defaults trace scheme to code-time-runid", () => {
    const p = defaultPresentationFromMetadata({ inputSubject: "name", archetype: "single" });
    expect(p.naming?.trace?.scheme).toBe("code-time-runid");
  });
});

describe("mergePresentation", () => {
  it("override naming title replaces base title, keeps base subtitle", () => {
    const base = defaultPresentationFromMetadata({ inputSubject: "eid", archetype: "single" });
    const merged = mergePresentation(base, {
      naming: { title: { scheme: "custom-template", template: "{name}" } } as any,
    });
    expect(merged.naming?.title?.scheme).toBe("custom-template");
    expect(merged.naming?.subtitle?.scheme).toBe("eid-else-trace"); // untouched
  });

  it("undefined override returns base unchanged (deep-equal)", () => {
    const base = defaultPresentationFromMetadata({ inputSubject: "pdf", archetype: "preview" });
    expect(mergePresentation(base, undefined)).toEqual(base);
  });

  it("override step rules replace base step rules", () => {
    const base: any = { steps: { rules: [{ step: "a", hidden: true }] } };
    const merged = mergePresentation(base, { steps: { rules: [{ step: "b", label: "B" }] } });
    expect(merged.steps?.rules).toEqual([{ step: "b", label: "B" }]);
  });
});
