import { describe, it, expect } from "vitest";
import type {
  WorkflowPresentationConfig,
  WorkflowOverride,
  TitleSchemeId,
} from "../../../../src/domain/workflow-presentation/types.js";

describe("workflow-presentation types", () => {
  it("accepts a full presentation config literal", () => {
    const cfg: WorkflowPresentationConfig = {
      naming: {
        title: { scheme: "person-name" },
        subtitle: { scheme: "eid-else-trace" },
        trace: { scheme: "code-time-runid" },
      },
      steps: {
        order: ["auth:ucpath", "transaction"],
        rules: [{ step: "transaction", label: "Run transaction" }],
      },
      delegation: {
        memberTitle: { scheme: "person-name" },
        coordinatorLabelSuffix: "Operation",
      },
    };
    expect(cfg.naming?.title?.scheme).toBe("person-name");
  });

  it("accepts a sparse override literal", () => {
    const ov: WorkflowOverride = {
      label: "HC Onboarding",
      presentation: { naming: { title: { scheme: "custom-template", template: "{name} ({emplId})" } } },
    };
    const id: TitleSchemeId = "custom-template";
    expect(ov.label).toBe("HC Onboarding");
    expect(id).toBe("custom-template");
  });
});
