import { defineWorkflow, runWorkflow } from "../../core/index.js";
import type { Ctx } from "../../core/kernel/types.js";
import { buildOperatorSubject } from "../../domain/operator-subject.js";
import { personMatchStatusExtensions } from "../../domain/person-match-status.js";
import { DEFAULT_WORKFLOW_RUNTIME_POLICY } from "../../domain/workflow-runtime/default-policy.js";
import type { WorkflowRuntimePolicy } from "../../domain/workflow-runtime/types.js";
import { loginToUCPath } from "../../infra/auth/login.js";
import { requireLogin } from "../../infra/auth/require-login.js";
import { searchPerson } from "../../systems/ucpath/navigate.js";
import { PersonMatchInputSchema, type PersonMatchInput } from "./schema.js";

/**
 * Person Match runtime policy.
 *
 * Delegated-only subworkflow — each row is one person, titled by name.
 * When fanned out from a parent (e.g. an I-9 OCR run), rows carry
 * `parentRunId` and group under the parent; scope never changes the row's
 * `single` shape.
 *
 * `alwaysOperationDelegatedMembers` keeps even a lone delegated match as a
 * one-member batch surface, consistent with person-lookup and i9-lookup.
 */
const PERSON_MATCH_WORKFLOW_RUNTIME_POLICY: WorkflowRuntimePolicy = {
  ...DEFAULT_WORKFLOW_RUNTIME_POLICY,
  memberRow: {
    titleSource: "person",
  },
  delegation: {
    ...DEFAULT_WORKFLOW_RUNTIME_POLICY.delegation,
    alwaysOperationDelegatedMembers: true,
  },
};

const personMatchSteps = ["search"] as const;

type PersonMatchCtx = Pick<
  Ctx<typeof personMatchSteps, PersonMatchInput>,
  "page" | "screenshot" | "step" | "updateData"
>;

export async function handlePersonMatch(
  ctx: PersonMatchCtx,
  input: PersonMatchInput,
  searchImpl: typeof searchPerson = searchPerson,
): Promise<void> {
  const page = await ctx.page("ucpath");
  await ctx.step("search", async () => {
    const result = await searchImpl(
      page,
      input.ssn ?? "",
      input.firstName,
      input.lastName,
      input.dob ?? "",
    );
    const match = result.matches?.[0];
    ctx.updateData({
      found: result.found ? "true" : "false",
      matchedEmplId: match?.emplId ?? "",
      matchedName: match
        ? [match.firstName, match.lastName].filter(Boolean).join(" ")
        : "",
    });
    await ctx.screenshot({
      kind: "form",
      label: "person-match-search-result",
      systems: ["ucpath"],
    });
  });
}

/**
 * Person Match workflow — **delegated-only**.
 *
 * Checks whether a person already exists in UCPath by running the same
 * HR-Tasks person search onboarding uses to discriminate new hires from
 * rehires (`searchPerson`, the pluggable UCPath module in
 * `src/systems/ucpath/navigate.ts`): fills legal name + SSN + DOB, races the
 * results grid (found) against the "no matching person" dialog (not found),
 * and fails loud on an ambiguous outcome.
 *
 * Output data fields: `found` (`"true"` | `"false"`), plus `matchedEmplId` /
 * `matchedName` from the first results-grid row when found (empty otherwise).
 * A completed not-found run promotes to the shared `notFound` display status
 * (`src/domain/person-match-status.ts`).
 *
 * This workflow has NO dashboard start surface. It is invoked only by
 * parent workflows via `ctx.delegateTo` / `ctx.delegateToAll` — today the
 * `i9` OCR form spec fans one match out per extracted I-9 record.
 */
export const personMatchWorkflow = defineWorkflow({
  name: "person-match",
  label: "Person Match",
  archetype: "single",
  inputSubject: "name",
  code: "pm",
  category: "Search",
  iconName: "UserSearch",
  systems: [
    {
      id: "ucpath",
      // Single-system launch, so the kernel authenticates eagerly at session
      // launch (one Duo prompt, no stagger) — same shape as i9-lookup.
      login: requireLogin(loginToUCPath, "UCPath authentication failed"),
    },
  ],
  steps: personMatchSteps,
  schema: PersonMatchInputSchema,
  runtimePolicy: PERSON_MATCH_WORKFLOW_RUNTIME_POLICY,
  statusExtensions: personMatchStatusExtensions,
  detailFields: [
    { key: "found", label: "Found in UCPath" },
    { key: "matchedEmplId", label: "Matched Empl ID" },
    { key: "matchedName", label: "Matched Name" },
  ],
  operatorSubject: (input) =>
    buildOperatorSubject({
      kind: "person",
      value: `${input.lastName}, ${input.firstName}`,
    }),
  handler: handlePersonMatch,
});

export async function runPersonMatchWorkflow(input: PersonMatchInput): Promise<void> {
  await runWorkflow(personMatchWorkflow, input);
}
