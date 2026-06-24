import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readOverride, writeOverride, deleteOverride, listOverrides } from "../../../../src/tracker/workflow-presentation/override-store.js";
import { WorkflowOverrideSchema } from "../../../../src/tracker/workflow-presentation/schema.js";

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "wfpres-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("override-store round trip", () => {
  it("read of a missing override → null", () => {
    expect(readOverride(root, "onboarding")).toBeNull();
  });
  it("write then read returns the override", () => {
    writeOverride(root, "onboarding", { label: "HC Onboarding" });
    expect(readOverride(root, "onboarding")).toEqual({ label: "HC Onboarding" });
  });
  it("listOverrides returns written workflow names", () => {
    writeOverride(root, "onboarding", { label: "X" });
    writeOverride(root, "separations", { label: "Y" });
    expect(listOverrides(root).sort()).toEqual(["onboarding", "separations"]);
  });
  it("delete removes the file", () => {
    writeOverride(root, "ocr", { iconName: "FileScan" });
    expect(deleteOverride(root, "ocr")).toBe(true);
    expect(readOverride(root, "ocr")).toBeNull();
  });
});

describe("WorkflowOverrideSchema validation", () => {
  it("rejects an unknown title scheme", () => {
    expect(WorkflowOverrideSchema.safeParse({ presentation: { naming: { title: { scheme: "bogus" }, subtitle: { scheme: "trace-only" } } } }).success).toBe(false);
  });
  it("rejects custom-template title without a template", () => {
    expect(WorkflowOverrideSchema.safeParse({ presentation: { naming: { title: { scheme: "custom-template" }, subtitle: { scheme: "trace-only" } } } }).success).toBe(false);
  });
  it("accepts a valid override", () => {
    expect(WorkflowOverrideSchema.safeParse({ label: "X", presentation: { naming: { title: { scheme: "custom-template", template: "{name}" }, subtitle: { scheme: "trace-only" } } } }).success).toBe(true);
  });
  it("accepts a partial naming override with trace only (no title/subtitle)", () => {
    expect(WorkflowOverrideSchema.safeParse({ presentation: { naming: { trace: { scheme: "code-time-runid" } } } }).success).toBe(true);
  });
  it("round-trips a partial-naming override via writeOverride/readOverride", () => {
    writeOverride(root, "wf", { presentation: { naming: { trace: { scheme: "code-time-runid" } } } });
    expect(readOverride(root, "wf")).toEqual({ presentation: { naming: { trace: { scheme: "code-time-runid" } } } });
  });
  it("rejects an unknown key nested inside naming", () => {
    expect(WorkflowOverrideSchema.safeParse({ presentation: { naming: { title: { scheme: "person-name" }, subtitle: { scheme: "trace-only" }, bogus: 1 } } }).success).toBe(false);
  });
  it("rejects an unknown key inside a naming part", () => {
    expect(WorkflowOverrideSchema.safeParse({ presentation: { naming: { title: { scheme: "person-name", bogus: 1 }, subtitle: { scheme: "trace-only" } } } }).success).toBe(false);
  });
});
