import { describe, it, expect } from "vitest";
import {
  resolveMemberPresentation,
  resolvePrepPresentation,
} from "../../../src/domain/workflow-runtime/projection.js";

describe("resolveMemberPresentation — delegation naming", () => {
  it("custom member title template wins", () => {
    const r = resolveMemberPresentation(
      { id: "m1", data: { queueRowKind: "person", name: "Jane Doe", __traceId: "os-1-aa11" } },
      {
        delegation: {
          memberTitle: { scheme: "custom-template", template: "Signer: {name}" },
          memberSubtitle: { scheme: "trace-only" },
        },
      },
    );
    expect(r?.title).toBe("Signer: Jane Doe");
    expect(r?.subtitle).toBe("os-1-aa11");
  });

  it("returns undefined with no presentation config (no-op)", () => {
    const r = resolveMemberPresentation(
      { id: "m1", data: { queueRowKind: "person", name: "Jane Doe", __traceId: "os-1-aa11" } },
      undefined,
    );
    expect(r).toBeUndefined();
  });

  it("returns undefined when delegation block is empty (no-op)", () => {
    const r = resolveMemberPresentation(
      { id: "m1", data: { queueRowKind: "person", name: "Jane Doe", __traceId: "os-1-aa11" } },
      { delegation: {} },
    );
    expect(r).toBeUndefined();
  });

  it("returns undefined when only memberTitle is set (both required)", () => {
    const r = resolveMemberPresentation(
      { id: "m1", data: { queueRowKind: "person", name: "Jane Doe", __traceId: "os-1-aa11" } },
      { delegation: { memberTitle: { scheme: "custom-template", template: "Signer: {name}" } } },
    );
    expect(r).toBeUndefined();
  });

  it("returns undefined when only memberSubtitle is set (both required)", () => {
    const r = resolveMemberPresentation(
      { id: "m1", data: { queueRowKind: "person", name: "Jane Doe", __traceId: "os-1-aa11" } },
      { delegation: { memberSubtitle: { scheme: "trace-only" } } },
    );
    expect(r).toBeUndefined();
  });
});

describe("resolvePrepPresentation — delegation naming", () => {
  it("custom prep title template wins", () => {
    const r = resolvePrepPresentation(
      {
        id: "p1",
        data: {
          queueRowKind: "file",
          pdfOriginalName: "oaths.pdf",
          __traceId: "oc-1-bb22",
        },
      },
      {
        delegation: {
          prepTitle: { scheme: "custom-template", template: "Prep: {pdfOriginalName}" },
        },
      },
    );
    expect(r?.title).toBe("Prep: oaths.pdf");
  });

  it("returns undefined with no presentation config (no-op)", () => {
    const r = resolvePrepPresentation(
      { id: "p1", data: { queueRowKind: "file", pdfOriginalName: "oaths.pdf", __traceId: "oc-1-bb22" } },
      undefined,
    );
    expect(r).toBeUndefined();
  });

  it("returns undefined when delegation block has no prepTitle (no-op)", () => {
    const r = resolvePrepPresentation(
      { id: "p1", data: { queueRowKind: "file", pdfOriginalName: "oaths.pdf", __traceId: "oc-1-bb22" } },
      { delegation: { memberTitle: { scheme: "person-name" } } },
    );
    expect(r).toBeUndefined();
  });
});
