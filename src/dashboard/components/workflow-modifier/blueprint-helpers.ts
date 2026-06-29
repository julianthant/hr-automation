// Pure helpers for the Workflow Modifier "Live Blueprint" surface.
//
// Two jobs:
//  1) Sparse-override mutation. The draft override holds ONLY the leaves the
//     operator has actually changed (so unconfigured fields round-trip through
//     Save untouched and defaults never get baked in). Every setter routes
//     through `prune` so a fully-default block collapses to undefined — naming,
//     steps, AND delegation alike. (The legacy editors only collapsed naming;
//     collapsing all three is the correct reading of the sparse contract and
//     keeps dirty-tracking honest.)
//  2) Client-side preview. The row/tree text is resolved with the SAME domain
//     functions the server `/preview` endpoint uses (resolveTitle/Subtitle/
//     Trace), so the blueprint updates instantly and byte-identically — no
//     debounce, no "Press Preview" round-trip.

import type {
  WorkflowOverride,
  NamingPartTitle,
  NamingPartSubtitle,
  NamingPartTrace,
  NamingConfig,
  StepDisplayConfig,
  StepDisplayRule,
  DelegationDisplayConfig,
} from "../../../domain/workflow-presentation/types.js";
import {
  resolveTitle,
  resolveSubtitle,
  resolveTrace,
} from "../../../domain/workflow-presentation/schemes.js";

// ── Defaults (mirror SchemePartSelect's options[0] fallback + server defaults) ──
export const DEFAULT_TITLE_SCHEME = "person-name";
export const DEFAULT_SUBTITLE_SCHEME = "eid-else-trace";
export const DEFAULT_TRACE_SCHEME = "code-time-runid";
// Preview-only fallbacks for unset (allow-unset) delegation parts.
export const DEFAULT_MEMBER_TITLE_SCHEME = "person-name";
export const DEFAULT_MEMBER_SUBTITLE_SCHEME = "trace-only";
export const DEFAULT_PREP_TITLE_SCHEME = "person-name";

// Token chips offered in the custom-template editor (curated from KNOWN_TOKENS).
export const TOKEN_PALETTE = [
  "name",
  "emplId",
  "email",
  "code",
  "HHMMSS",
  "runId4",
  "traceId",
] as const;

// Workflows that fan out to delegated children / operation members. Drives
// whether the Delegation plate is an editor or a quiet inert state.
const DELEGATING_WORKFLOWS = new Set([
  "ocr",
  "oath-signature",
  "emergency-contact",
  "onbase",
  "oath-upload",
]);

export function isDelegatingWorkflow(name: string): boolean {
  return DELEGATING_WORKFLOWS.has(name);
}

// ── Sample data ───────────────────────────────────────────────────────────────
// Matches the server preview record (Jane Doe / 10012345) so the blueprint reads
// the same as a real row would.
export function buildSampleVars(label: string): Record<string, string> {
  return {
    name: "Jane Doe",
    employeeName: "Jane Doe",
    searchName: "Jane Doe",
    __name: "Jane Doe",
    __subject: "Jane Doe",
    emplId: "10012345",
    employeeId: "10012345",
    eid: "10012345",
    email: "jane.doe@ucsd.edu",
    pdfOriginalName: "Onboarding_Packet.pdf",
    label,
    code: "oa",
    HHMMSS: "143012",
    runId4: "a3f1",
    traceId: "oa-143012-a3f1",
    __traceId: "oa-143012-a3f1",
    id: "a3f1c9e2",
  };
}

// A second sample person for the "applies to every member" ghost card.
export function buildSecondMemberVars(label: string): Record<string, string> {
  return {
    ...buildSampleVars(label),
    name: "John Roe",
    employeeName: "John Roe",
    searchName: "John Roe",
    __name: "John Roe",
    __subject: "John Roe",
    emplId: "10067890",
    employeeId: "10067890",
    eid: "10067890",
    email: "john.roe@ucsd.edu",
    runId4: "b7d2",
    traceId: "oa-143012-b7d2",
    __traceId: "oa-143012-b7d2",
    id: "b7d24f10",
  };
}

// ── Client-side preview resolvers ──────────────────────────────────────────────
export function previewTitle(vars: Record<string, string>, part: NamingPartTitle): string {
  return resolveTitle(vars, part);
}
export function previewSubtitle(vars: Record<string, string>, part: NamingPartSubtitle): string {
  return resolveSubtitle(vars, part);
}
export function previewTrace(vars: Record<string, string>, part: NamingPartTrace): string {
  return resolveTrace(vars, part);
}

// ── Scheme label lookup ────────────────────────────────────────────────────────
export interface SchemeMetaLike {
  id: string;
  label: string;
  description?: string;
}

export function schemeLabel(
  scheme: string | undefined,
  pool: SchemeMetaLike[],
  fallback = "—",
): string {
  if (!scheme) return fallback;
  return pool.find((s) => s.id === scheme)?.label ?? scheme;
}

// ── Override counting (rolls up to plate headers + the left picker) ─────────────
export function countNaming(draft: WorkflowOverride): number {
  const n = draft.presentation?.naming;
  if (!n) return 0;
  return (
    (n.title !== undefined ? 1 : 0) +
    (n.subtitle !== undefined ? 1 : 0) +
    (n.trace !== undefined ? 1 : 0)
  );
}

export function countSteps(draft: WorkflowOverride): number {
  const s = draft.presentation?.steps;
  if (!s) return 0;
  return (s.order !== undefined ? 1 : 0) + (s.rules?.length ?? 0);
}

export function countDelegation(draft: WorkflowOverride): number {
  const d = draft.presentation?.delegation;
  if (!d) return 0;
  return (
    (d.memberTitle !== undefined ? 1 : 0) +
    (d.memberSubtitle !== undefined ? 1 : 0) +
    (d.prepTitle !== undefined ? 1 : 0) +
    (d.coordinatorLabelSuffix !== undefined ? 1 : 0)
  );
}

export function countTotal(draft: WorkflowOverride): number {
  return countNaming(draft) + countSteps(draft) + countDelegation(draft);
}

export function isDirty(draft: WorkflowOverride, persisted: WorkflowOverride | null): boolean {
  return JSON.stringify(draft) !== JSON.stringify(persisted ?? {});
}

// ── Sparse-prune core ──────────────────────────────────────────────────────────
function objHasKeys(obj: object | undefined): boolean {
  return !!obj && Object.keys(obj).length > 0;
}

function stepsHaveContent(s: StepDisplayConfig | undefined): boolean {
  if (!s) return false;
  return (s.order?.length ?? 0) > 0 || (s.rules?.length ?? 0) > 0;
}

/** Collapse empty blocks → undefined, empty presentation → removed key. */
export function prune(ov: WorkflowOverride): WorkflowOverride {
  const p = ov.presentation;
  const next: WorkflowOverride = { ...ov };
  if (!p) {
    delete next.presentation;
    return next;
  }
  const naming = objHasKeys(p.naming) ? p.naming : undefined;
  const steps = stepsHaveContent(p.steps) ? p.steps : undefined;
  const delegation = objHasKeys(p.delegation) ? p.delegation : undefined;
  if (!naming && !steps && !delegation) {
    delete next.presentation;
    return next;
  }
  next.presentation = {
    ...(naming ? { naming } : {}),
    ...(steps ? { steps } : {}),
    ...(delegation ? { delegation } : {}),
  };
  return next;
}

// ── Naming setters ─────────────────────────────────────────────────────────────
type NamingPart = "title" | "subtitle" | "trace";
type NamingValue = NamingPartTitle | NamingPartSubtitle | NamingPartTrace;

export function setNamingPart(
  draft: WorkflowOverride,
  part: NamingPart,
  value: NamingValue | undefined,
): WorkflowOverride {
  const naming: NamingConfig = { ...(draft.presentation?.naming ?? {}) };
  if (value === undefined) {
    delete naming[part];
  } else {
    // The runtime field types are exact unions; the value matches by construction
    // at each call site (part ⟺ value variant), so a single cast is safe here.
    (naming as Record<string, NamingValue>)[part] = value;
  }
  return prune({ ...draft, presentation: { ...(draft.presentation ?? {}), naming } });
}

// ── Delegation setters ─────────────────────────────────────────────────────────
type DelegationField = keyof DelegationDisplayConfig;

export function setDelegationField(
  draft: WorkflowOverride,
  field: DelegationField,
  value: DelegationDisplayConfig[DelegationField] | undefined,
): WorkflowOverride {
  const del: DelegationDisplayConfig = { ...(draft.presentation?.delegation ?? {}) };
  if (value === undefined) {
    delete del[field];
  } else {
    (del as Record<string, unknown>)[field] = value;
  }
  return prune({ ...draft, presentation: { ...(draft.presentation ?? {}), delegation: del } });
}

// ── Step setters ───────────────────────────────────────────────────────────────
function setStepsConfig(draft: WorkflowOverride, cfg: StepDisplayConfig): WorkflowOverride {
  return prune({ ...draft, presentation: { ...(draft.presentation ?? {}), steps: cfg } });
}

export function setStepOrder(draft: WorkflowOverride, order: string[]): WorkflowOverride {
  const cfg = { ...(draft.presentation?.steps ?? {}) };
  return setStepsConfig(draft, { ...cfg, order });
}

export function resetStepOrder(draft: WorkflowOverride): WorkflowOverride {
  const cfg = { ...(draft.presentation?.steps ?? {}) };
  delete cfg.order;
  return setStepsConfig(draft, cfg);
}

export function updateStepRule(
  draft: WorkflowOverride,
  step: string,
  patch: Partial<StepDisplayRule>,
): WorkflowOverride {
  const cfg = draft.presentation?.steps ?? {};
  const existing: StepDisplayRule =
    (cfg.rules ?? []).find((r) => r.step === step) ?? { step };
  const merged: StepDisplayRule = { ...existing, ...patch };
  if (!merged.hidden) delete merged.hidden;
  if (!merged.label) delete merged.label;
  if (!merged.foldInto) delete merged.foldInto;
  const meaningful = Object.keys(merged).some((k) => k !== "step");
  const rules = (cfg.rules ?? []).filter((r) => r.step !== step);
  if (meaningful) rules.push(merged);
  return setStepsConfig(draft, { ...cfg, rules });
}

export function resetStepRule(draft: WorkflowOverride, step: string): WorkflowOverride {
  const cfg = draft.presentation?.steps ?? {};
  const rules = (cfg.rules ?? []).filter((r) => r.step !== step);
  return setStepsConfig(draft, { ...cfg, rules });
}

/** Pure array reorder used by both drag-drop and the keyboard chevrons. */
export function moveInOrder(order: string[], from: number, to: number): string[] {
  if (to < 0 || to >= order.length || from === to) return order;
  const next = [...order];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
