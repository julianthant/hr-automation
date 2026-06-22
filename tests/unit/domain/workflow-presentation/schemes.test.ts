// tests/unit/domain/workflow-presentation/schemes.test.ts
import { describe, it, expect } from "vitest";
import { SCHEME_LIBRARY, resolveTitle, resolveSubtitle } from "../../../../src/domain/workflow-presentation/schemes.js";

const vars = { name: "Jane Doe", emplId: "10012345", pdfOriginalName: "oath.pdf", traceId: "ou-143012-a3f1", label: "Onboarding Roster" };

describe("resolveTitle", () => {
  it("person-name → name", () => expect(resolveTitle(vars, { scheme: "person-name" })).toBe("Jane Doe"));
  it("pdf-filename → pdf name", () => expect(resolveTitle(vars, { scheme: "pdf-filename" })).toBe("oath.pdf"));
  it("catalog-label → label", () => expect(resolveTitle(vars, { scheme: "catalog-label" })).toBe("Onboarding Roster"));
  it("batch-anchor → empty (count badge identifies it)", () => expect(resolveTitle(vars, { scheme: "batch-anchor" })).toBe(""));
  it("custom-template renders", () => expect(resolveTitle(vars, { scheme: "custom-template", template: "{name} #{emplId}" })).toBe("Jane Doe #10012345"));
});

describe("resolveSubtitle", () => {
  it("eid-else-trace → eid when present", () => expect(resolveSubtitle(vars, { scheme: "eid-else-trace" })).toBe("10012345"));
  it("eid-else-trace → trace when no eid", () => expect(resolveSubtitle({ ...vars, emplId: "" }, { scheme: "eid-else-trace" })).toBe("ou-143012-a3f1"));
  it("trace-only → trace", () => expect(resolveSubtitle(vars, { scheme: "trace-only" })).toBe("ou-143012-a3f1"));
});

describe("SCHEME_LIBRARY", () => {
  it("lists every title scheme id with a label", () => {
    const ids = SCHEME_LIBRARY.title.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(["person-name", "pdf-filename", "catalog-label", "batch-anchor", "custom-template"]));
    expect(SCHEME_LIBRARY.title.every((s) => s.label.length > 0)).toBe(true);
  });
});
