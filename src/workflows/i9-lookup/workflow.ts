import { defineWorkflow, runWorkflow } from "../../core/index.js";
import { buildOperatorSubject } from "../../domain/operator-subject.js";
import { DEFAULT_WORKFLOW_RUNTIME_POLICY } from "../../domain/workflow-runtime/default-policy.js";
import type { WorkflowRuntimePolicy } from "../../domain/workflow-runtime/types.js";
import { loginToI9 } from "../../systems/i9/login.js";
import { lookupSection2Signer } from "../../systems/i9/signer.js";
import { I9LookupInputSchema, type I9LookupInput } from "./schema.js";

/**
 * I9 Lookup runtime policy.
 *
 * Delegated-only subworkflow — each row is one person, titled by name.
 * When fanned out from a parent (e.g. an OCR run), rows carry `parentRunId`
 * and group under the parent; scope never changes the row's `single` shape.
 *
 * `alwaysBatchDelegatedMembers` keeps even a lone delegated lookup as a
 * one-member batch surface, consistent with how person-lookup handles this.
 */
const I9_LOOKUP_WORKFLOW_RUNTIME_POLICY: WorkflowRuntimePolicy = {
  ...DEFAULT_WORKFLOW_RUNTIME_POLICY,
  memberRow: {
    titleSource: "person",
  },
  delegation: {
    ...DEFAULT_WORKFLOW_RUNTIME_POLICY.delegation,
    alwaysBatchDelegatedMembers: true,
  },
};

const i9LookupSteps = ["lookup"] as const;

/**
 * I9 Lookup workflow — **delegated-only**.
 *
 * Resolves who signed Section 2 of an employee's I-9 form (the "authorized
 * representative" / oath signer). This is the same underlying primitive used
 * by the onboarding flow, wrapped as a first-class workflow so other workflows
 * (e.g. oath-signature, OCR fan-outs) can delegate to it via `ctx.delegateTo`.
 *
 * Input is a person identified by name (I-9 Complete's search is name-based).
 * The kernel auto-prepends an `auth:i9` step from the `systems` declaration.
 *
 * Output data fields: `signerName` (who signed), `i9Status` (signed |
 * unsigned | historical | not-found | error), and optionally `profileId`.
 *
 * This workflow has NO dashboard start surface. It is invoked only by
 * parent workflows via `ctx.delegateTo` / `ctx.delegateToAll`.
 */
export const i9LookupWorkflow = defineWorkflow({
  name: "i9-lookup",
  label: "I9 Lookup",
  archetype: "single",
  inputSubject: "name",
  code: "i9",
  category: "Utils",
  iconName: "ShieldCheck",
  systems: [
    {
      id: "i9",
      // I9 Complete uses email + password auth (no Duo). Login is fast enough
      // that deferring it to a handler step is not needed — let the kernel
      // authenticate eagerly at session launch.
      login: async (page) => {
        const ok = await loginToI9(page);
        if (!ok) throw new Error("I9 authentication failed");
      },
    },
  ],
  steps: i9LookupSteps,
  schema: I9LookupInputSchema,
  runtimePolicy: I9_LOOKUP_WORKFLOW_RUNTIME_POLICY,
  detailFields: [
    { key: "signerName", label: "Signed By" },
    { key: "i9Status", label: "I-9 Status" },
  ],
  operatorSubject: (input) =>
    buildOperatorSubject({
      kind: "person",
      value: `${input.lastName}, ${input.firstName}`,
      prefix: "I9 Lookup",
    }),
  handler: async (ctx, input) => {
    const page = await ctx.page("i9");
    await ctx.step("lookup", async () => {
      const result = await lookupSection2Signer(page, {
        lastName: input.lastName,
        firstName: input.firstName,
        ...(input.ssn ? { ssn: input.ssn } : {}),
      });
      ctx.updateData({
        signerName: result.signerName ?? "",
        i9Status: result.status,
        ...(result.profileId ? { profileId: result.profileId } : {}),
      });
    });
  },
});

export async function runI9LookupWorkflow(input: I9LookupInput): Promise<void> {
  await runWorkflow(i9LookupWorkflow, input);
}
