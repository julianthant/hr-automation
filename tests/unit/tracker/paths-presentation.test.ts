import { describe, it, expect } from "vitest";
import { workflowPresentationDir, workflowPresentationFile } from "../../../src/tracker/paths.js";

describe("workflow presentation paths", () => {
  it("dir resolves under config/workflow-presentation", () => {
    expect(workflowPresentationDir("/repo")).toBe("/repo/config/workflow-presentation");
  });
  it("file resolves <workflow>.json", () => {
    expect(workflowPresentationFile("/repo", "onboarding")).toBe("/repo/config/workflow-presentation/onboarding.json");
  });
});
