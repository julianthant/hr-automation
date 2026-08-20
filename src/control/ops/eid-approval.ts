/**
 * Identity-approval review — workflow-agnostic approve / dismiss handlers.
 *
 * When a workflow's identity resolution finds a DIFFERENT valid person than the
 * one on the input record, the run PAUSES into the EID-approval review
 * (`data.eidApproval = "pending"`, see `src/domain/identity-approval.ts`). The
 * operator then either:
 *
 *   - **approves** a chosen EID (the input record's, the resolved one, or a
 *     manually-typed one) → we RE-ENQUEUE the item as a FRESH run carrying ONLY
 *     `prefilledData.eidApproved = <chosen>`. The handler forces that EID, skips
 *     the identity gate (no re-pause), and otherwise runs fully fresh. We
 *     deliberately do NOT merge the paused run's accumulated tracker strings (the
 *     way `/api/run-with-data` does): that would prefill downstream values and
 *     carry the stale `eidApproval=pending` forward.
 *
 *   - **dismisses** it → we stamp the paused row `eidApproval = "dismissed"` (a
 *     neutral terminal, NOT a failure) and re-queue nothing; the operator fixes
 *     the input record by hand.
 *
 * These are the SAME handlers separations uses (via the separations-named facade
 * in `separations-eid-approval.ts`); the workflow now rides the request payload
 * instead of being baked into the builder, so onboarding (and future adopters)
 * reuse them by adding the workflow to `EID_APPROVAL_WORKFLOWS`.
 */
import { enqueueFromHttp } from "../../core/daemon/enqueue-dispatch.js";
import { isUcpathEmployeeId, normalizeEid } from "../../domain/identity/eid.js";
import { findEntryInput } from "./retry.js";
import { emitInheritedRow, PriorTrackerRowNotFoundError } from "./emit-inherited.js";
import { errorMessage } from "../../utils/errors.js";
import { log } from "../../utils/log.js";

/**
 * Workflows that adopt the identity-approval gate. A re-enqueue drives a REAL
 * transaction, so an unknown/forged workflow name must fail loud rather than
 * enqueue into an arbitrary daemon. Add a workflow here when it adopts the gate.
 */
export const EID_APPROVAL_WORKFLOWS = new Set<string>(["separations", "onboarding"]);

export interface ApproveEidRequest {
  workflow: string;
  id: string;
  runId?: string;
  /** The EID the operator chose to proceed with (original / proposed / manual). */
  eid: string;
  date?: string;
}

export interface DismissEidRequest {
  workflow: string;
  id: string;
  runId?: string;
  date?: string;
}

export interface EidApprovalResult {
  ok: boolean;
  error?: string;
}

/** Approve a chosen EID and re-enqueue the item as a fresh, gate-skipping run. */
export function buildApproveEidHandler(dir: string) {
  return async (req: ApproveEidRequest): Promise<EidApprovalResult> => {
    if (!EID_APPROVAL_WORKFLOWS.has(req.workflow)) {
      return { ok: false, error: `approve-eid: unsupported workflow "${req.workflow}"` };
    }
    const eid = normalizeEid(req.eid ?? "");
    if (!isUcpathEmployeeId(eid)) {
      return { ok: false, error: `approve-eid: "${req.eid}" is not a valid 8-digit UCPath EID` };
    }
    if (!req.id) return { ok: false, error: "approve-eid: id is required" };

    // Read the pristine original input (docId/email, dryRun, …) for this paused run.
    const lookup = findEntryInput(req.workflow, req.id, req.runId, dir, req.date);
    if ("error" in lookup) return { ok: false, error: lookup.error };

    // Fresh run = original input + ONLY the approved-EID marker (no accumulated
    // merge). The handler reads `prefilledData.eidApproved`, forces the EID, and
    // skips the gate.
    const input = { ...lookup.input, prefilledData: { eidApproved: eid } };
    const result = await enqueueFromHttp(req.workflow, [input], { trackerDir: dir });
    if (!result.ok) return { ok: false, error: result.error ?? "approve-eid: enqueue failed" };

    log.step(
      `[approve-eid] re-queued ${req.workflow} item id=${req.id} with operator-approved EID ${eid}`,
    );
    return { ok: true };
  };
}

export interface NotThisPersonRequest {
  workflow: string;
  id: string;
  runId?: string;
  /** The UCPath EID the operator reviewed and confirmed is NOT this person (the proposed match). */
  eid: string;
  date?: string;
}

/**
 * Workflows whose handler honours `prefilledData.notMatchEids` ("these UCPath
 * persons were reviewed and are NOT this hire") — onboarding's person-search
 * identity gate proceeds as a NEW hire when every Search/Match hit is a
 * reviewed EID, and its submit-time Person Match page excludes reviewed EIDs
 * (2026-08-20). Separations is deliberately NOT here: a "not this person"
 * answer there means the input record is wrong, not "proceed".
 */
export const NOT_THIS_PERSON_WORKFLOWS = new Set<string>(["onboarding"]);

/**
 * Pure: append one reviewed EID to an existing `notMatchEids` list (comma /
 * semicolon / whitespace separated), de-duplicated, comma-joined. A second
 * review on a later run ACCUMULATES rather than replaces — the earlier reviewed
 * EIDs must keep their pass or the next run would re-pause on them. Non-string
 * prior → just the new EID.
 */
export function mergeNotMatchEids(prior: unknown, eid: string): string {
  const priorList = typeof prior === "string" ? prior : "";
  return Array.from(new Set([...priorList.split(/[\s,;]+/).filter(Boolean), eid])).join(",");
}

/**
 * "Not this person — run as a new hire": the operator reviewed the proposed
 * UCPath match and rejected it. Re-enqueues the item with the reviewed EID in
 * `prefilledData.notMatchEids` (merged into any EIDs already on the row, so a
 * second review on a later run accumulates rather than replaces) and stamps the
 * paused row dismissed. Dismiss alone would only stamp the row — the DOB-keyed
 * fuzzy Search/Match recurs deterministically, so a plain re-run re-pauses on
 * the same false match (live 2026-08-20: Mia Perez→Mia McKrell, Juliana
 * Romano→Julian Davey, Maria Renee Santos→Mariana Herrera).
 */
export function buildNotThisPersonHandler(dir: string) {
  return async (req: NotThisPersonRequest): Promise<EidApprovalResult> => {
    if (!NOT_THIS_PERSON_WORKFLOWS.has(req.workflow)) {
      return { ok: false, error: `not-this-person: unsupported workflow "${req.workflow}"` };
    }
    const eid = normalizeEid(req.eid ?? "");
    if (!isUcpathEmployeeId(eid)) {
      return { ok: false, error: `not-this-person: "${req.eid}" is not a valid 8-digit UCPath EID` };
    }
    if (!req.id) return { ok: false, error: "not-this-person: id is required" };
    const lookup = findEntryInput(req.workflow, req.id, req.runId, dir, req.date);
    if ("error" in lookup) return { ok: false, error: lookup.error };
    const prior: Record<string, unknown> = lookup.input;
    const priorPrefilled = (prior.prefilledData && typeof prior.prefilledData === "object")
      ? (prior.prefilledData as Record<string, unknown>)
      : {};
    const merged = mergeNotMatchEids(priorPrefilled.notMatchEids, eid);
    const input = { ...prior, prefilledData: { ...priorPrefilled, notMatchEids: merged } };
    const result = await enqueueFromHttp(req.workflow, [input], { trackerDir: dir });
    if (!result.ok) return { ok: false, error: result.error ?? "not-this-person: enqueue failed" };
    try {
      emitInheritedRow({
        workflow: req.workflow,
        trackerDir: dir,
        id: req.id,
        runId: req.runId,
        status: "done",
        data: {
          eidApproval: "dismissed",
          status: "EID Approval Dismissed",
          notMatchEids: merged,
        },
      });
    } catch (err) {
      // The re-enqueue already happened; a missing prior row only loses the stamp.
      if (!(err instanceof PriorTrackerRowNotFoundError)) throw err;
    }
    log.step(
      `[not-this-person] ${req.workflow} item id=${req.id}: EID ${eid} reviewed as NOT this person — ` +
      `re-queued as a new hire with notMatchEids=${merged}`,
    );
    return { ok: true };
  };
}

/** Dismiss the review: mark the paused row dismissed (neutral terminal); no re-queue. */
export function buildDismissEidHandler(dir: string) {
  return (req: DismissEidRequest): Promise<EidApprovalResult> => {
    if (!EID_APPROVAL_WORKFLOWS.has(req.workflow)) {
      return Promise.resolve({ ok: false, error: `dismiss-eid: unsupported workflow "${req.workflow}"` });
    }
    if (!req.id) return Promise.resolve({ ok: false, error: "dismiss-eid: id is required" });
    try {
      emitInheritedRow({
        workflow: req.workflow,
        trackerDir: dir,
        id: req.id,
        runId: req.runId,
        status: "done",
        data: {
          eidApproval: "dismissed",
          status: "EID Approval Dismissed",
        },
      });
      log.step(`[dismiss-eid] dismissed EID-approval review for ${req.workflow} item id=${req.id}`);
      return Promise.resolve({ ok: true });
    } catch (err) {
      if (err instanceof PriorTrackerRowNotFoundError) {
        return Promise.resolve({ ok: false, error: errorMessage(err) });
      }
      throw err;
    }
  };
}
