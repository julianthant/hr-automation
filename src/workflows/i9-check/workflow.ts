/**
 * I-9 Check workflow — the search-only half of the separations family
 * (category "Separations", beside the Kuali termination workflow).
 *
 * One task = one person from a scanned I-9 packet, fanned out by the
 * "Run I-9 Check" upload's OCR run (`enqueueI9CheckMemberTasks`). The daemon
 * runs ONE UCPath browser (no Kuali, no Kronos — this workflow's whole job is
 * a read-only person search):
 *   person-match (SSN/DOB HR-Tasks search) →
 *   person-lookup (optional; name + I-9 hire-date ±7d vs Last Hire) →
 *   roster-match (Action History by Empl ID + retention tracker append).
 *
 * Split out of the separations workflow 2026-07-17: it previously ran as a
 * `mode: "i9-check"` input variant inside the separations daemon, which spun
 * 3 browsers (Kuali/Kronos/UCPath) and rendered the 7 termination steps as
 * skipped on every member row. As its own workflow the retry-safety guard map
 * is STRUCTURAL — there is no termination handler here to reach.
 */
import { defineWorkflow } from "../../core/index.js";
import { DEFAULT_WORKFLOW_RUNTIME_POLICY } from "../../domain/workflow-runtime/default-policy.js";
import type { Ctx } from "../../core/kernel/types.js";
import { buildOperatorSubject } from "../../domain/operator-subject.js";
import { i9CheckStatusExtensions } from "../../domain/i9-check-status.js";
import { requireLogin } from "../../infra/auth/require-login.js";
import { loginToUCPath } from "../../infra/auth/login.js";
import { UCPATH_SMART_HR_URL } from "../../config.js";
import { I9CheckMemberInputSchema, type I9CheckMemberInput } from "./schema.js";
import { runI9CheckMember } from "./check.js";

const i9CheckSteps = ["person-match", "person-lookup", "roster-match"] as const;

export const i9CheckWorkflow = defineWorkflow({
  name: "i9-check",
  label: "I-9 Check",
  archetype: "single",
  inputSubject: "name",
  // "ic" matches the i9 OCR form spec's traceCode ("i9" is taken by i9-lookup).
  code: "ic",
  category: "Separations",
  iconName: "FileSearch",
  statusExtensions: i9CheckStatusExtensions,
  systems: [
    {
      id: "ucpath",
      login: requireLogin(loginToUCPath, "UCPath authentication failed"),
      resetUrl: UCPATH_SMART_HR_URL,
    },
  ],
  authSteps: true,
  steps: i9CheckSteps,
  schema: I9CheckMemberInputSchema,
  runtimePolicy: DEFAULT_WORKFLOW_RUNTIME_POLICY,
  batch: {
    mode: "sequential",
    betweenItems: ["reset"],
  },
  detailFields: [
    { key: "name",              label: "Employee" },
    // Always shown beside PPS ID — blank "—" when UCPath did not resolve an Empl ID.
    { key: "eid",               label: "EID",                  inputKind: "id" },
    // Always shown: Action History "Employee PPS ID Current" (or OCR 5-digit seed).
    { key: "ppsEid",            label: "PPS ID",               inputKind: "id" },
    { key: "i9HireDate",        label: "Hire Date (from I-9)", inputKind: "date" },
    { key: "separationDate",    label: "Separation Date",      inputKind: "date" },
    { key: "ucpathFoundLabel",  label: "Found in UCPath?" },
    // Each employee has BOTH an I-9 Section 1 and a Section 2, filed apart in
    // the packet. Say which pages actually backed this row: a "not found" from
    // a single uncorroborated page is much weaker evidence than one where the
    // employer's own sheet agreed.
    { key: "section1Present",   label: "Section 1 present" },
    { key: "section2Present",   label: "Section 2 present" },
  ],
  getName: (d) => d.name ?? "",
  getId: (d) => d.eid ?? "",
  operatorSubject: (input) =>
    buildOperatorSubject({ kind: "person", value: input.person.name }),
  handler: async (ctx: Ctx<typeof i9CheckSteps, I9CheckMemberInput>, input) => {
    await runI9CheckMember(ctx, input);
  },
});
