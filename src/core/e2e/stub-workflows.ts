import type { Page } from "playwright";
import type { Ctx } from "../kernel/types.js";
import type { AnyRegisteredWorkflow } from "../workflow-loaders.js";
import { log } from "../../utils/log.js";
import { awaitGateRelease, consumeFailGate, E2EScriptedFailError, waitWithSignal } from "./gates.js";
import { oathUploadHandler, type OathUploadHandlerOpts } from "../../workflows/oath-upload/handler.js";
import type { OathUploadInput } from "../../workflows/oath-upload/schema.js";

/**
 * E2E stub-daemon bridge (HRAUTO_E2E_STUBS=1) — mode C of the AI e2e test.
 *
 * Wraps selected workflows with SCRIPTED handlers so dashboard-spawned daemons
 * exercise the full queue/cancel/parallel/delegation machinery without
 * touching UCPath / ServiceNow / SharePoint / Duo:
 *
 * - The real `RegisteredWorkflow` is cloned (`cloneWithScript` pattern from
 *   the delegation harness): metadata, schema, steps, archetype, trace code,
 *   detailFields, and runtime policy stay REAL; only `config.systems` (→ `[]`,
 *   no browsers/auth) and `config.handler` change.
 * - Each scripted step honors the file-based hold gates in
 *   `core/e2e/gates.ts`, so the e2e driver can park runs mid-step
 *   (deterministic cancel-running / reassign tests) and release them.
 * - Stub steps stamp the same operator-facing data fields the real handler
 *   would (from the real input), so data-flow verification stays meaningful.
 * - Every stub run stamps `data.e2eStub: "true"` for provenance.
 *
 * oath-upload is special: its handler IS the cross-daemon wait machinery under
 * test (`wait-approval` → `subscribeToApproval`, `wait-signatures` →
 * `watchChildRuns`), so the REAL handler runs with only the ServiceNow legs
 * stubbed via its existing test seams.
 *
 * OCR is deliberately NOT stubbed (real Gemini + local PDF — read-only), and
 * sharepoint-download is live-lane only. Workflows with no wrapper here load
 * REAL even in stub mode — loudly logged — but the e2e never enqueues them.
 */

type AnyCtx = Ctx<readonly string[], unknown>;

const STUB_STEP_PAUSE_MS = 400;

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function compact(patch: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Per-step operator-data script, derived from the run's real input. */
type StepDataFn = (input: unknown) => Record<string, Record<string, string>>;

function cloneWithScriptedSteps(wf: AnyRegisteredWorkflow, stepData: StepDataFn): AnyRegisteredWorkflow {
  const handler = async (ctx: AnyCtx, input: unknown): Promise<void> => {
    const data = stepData(input);
    ctx.updateData({ e2eStub: "true" });
    for (const step of wf.config.steps) {
      await ctx.step(step, async () => {
        await awaitGateRelease({
          workflow: wf.config.name,
          step,
          ...(ctx.trackerDir !== undefined ? { trackerDir: ctx.trackerDir } : {}),
          signal: ctx.signal,
        });
        // Organic-failure injection (one-shot): if the driver armed a
        // `<wf>--fail-at--<step>.fail` gate, throw a non-cancel error so the
        // kernel writes a terminal `failed` row (red badge + Retry). The Retry
        // replays `tasks.original_input_json` and the consumed gate is gone, so
        // the replay passes. Checked AFTER the hold release (the driver can park
        // then arm) but BEFORE the success-data patch (a failed step stamps no
        // success data).
        if (consumeFailGate({
          workflow: wf.config.name,
          step,
          ...(ctx.trackerDir !== undefined ? { trackerDir: ctx.trackerDir } : {}),
        })) {
          throw new E2EScriptedFailError(wf.config.name, step);
        }
        const patch = data[step];
        if (patch && Object.keys(patch).length > 0) ctx.updateData(patch);
        await waitWithSignal(STUB_STEP_PAUSE_MS, ctx.signal);
      });
    }
  };
  return {
    ...wf,
    config: {
      ...wf.config,
      systems: [],
      handler: handler as unknown as AnyRegisteredWorkflow["config"]["handler"],
    },
  };
}

// ─── Per-workflow scripts ────────────────────────────────────────────────────

/** oath-signature: steps ["ucpath-auth", "transaction"]. */
const oathSignatureScript: StepDataFn = (input) => {
  const r = rec(input);
  return {
    "ucpath-auth": {},
    transaction: compact({
      emplId: str(r.emplId),
      name: str(r.name),
      date: str(r.date),
      ...(r.dryRun === true ? { status: "Dry Run Complete" } : {}),
    }),
  };
};

/** emergency-contact: steps ["navigation", "fill-form", "save"]; input is RecordSchema. */
const emergencyContactScript: StepDataFn = (input) => {
  const r = rec(input);
  const employee = rec(r.employee);
  const contact = rec(r.emergencyContact);
  const address = rec(contact.address);
  return {
    navigation: compact({
      employeeName: str(employee.name),
      emplId: str(employee.employeeId),
    }),
    "fill-form": compact({
      contactName: str(contact.name),
      relationship: str(contact.relationship),
      contactPhone: str(contact.cellPhone) ?? str(contact.homePhone) ?? str(contact.workPhone),
      contactAddress: str(address.street),
    }),
    save: compact(r.dryRun === true ? { status: "Dry Run Complete" } : {}),
  };
};

/**
 * Deterministic fake EID for a name-keyed stub lookup. A CONSTANT default
 * (the old "10000001") collided across records — every name-keyed lookup in a
 * batch "resolved" to the same person, masking identity bugs and clobbering
 * distinct paper EIDs through the verify patch (E2E-014). Hash the name into
 * a stable 1xxxxxxx EID instead so each identity stays distinct across runs.
 */
function stubEidForName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return `1${String(hash % 10_000_000).padStart(7, "0")}`;
}

/** person-lookup: steps ["searching", "cross-verification", "active-status", "crm-dates"]. */
const personLookupScript: StepDataFn = (input) => {
  const r = rec(input);
  const emplId = str(r.emplId) ?? stubEidForName(str(r.name) ?? "unknown");
  return {
    searching: compact({
      searchName: str(r.name) ?? emplId,
    }),
    "cross-verification": compact({
      emplId,
      name: str(r.name),
      department: "E2E Department",
      payrollTitle: "E2E Analyst",
    }),
    "active-status": {
      hrStatus: "Active",
      // Canonical person-lookup ActiveCheckStatus value ("active"|"inactive"|
      // "non-hdh"|...), NOT the dashboard A/IA display-chip label. computeOcrVerification
      // lower-cases and matches this exactly; "A" fell through to lookup-failed, so OCR
      // records never verified and the review pane deselected every signed record (VP-001).
      activeStatus: "active",
      isActive: "true",
    },
    "crm-dates": compact(
      r.includeCrmDates === true
        ? { startDate: "01/05/2026", employmentDate: "01/05/2026", oathDate: "01/06/2026" }
        : { startDate: "01/05/2026" },
    ),
  };
};

/** i9-lookup: steps ["lookup"]. */
const i9LookupScript: StepDataFn = (input) => {
  const r = rec(input);
  return {
    lookup: compact({
      signerName: "E2E Authorized Official",
      i9Status: "Section 2 Complete (E2E)",
      ...(str(r.lastName) && str(r.firstName)
        ? { employeeName: `${str(r.lastName)}, ${str(r.firstName)}` }
        : {}),
    }),
  };
};

/**
 * oath-upload: run the REAL handler (wait-approval / wait-signatures /
 * dup-probe logic is the machinery under test) with the ServiceNow legs
 * stubbed through its existing test seams. The `servicenow-auth` step honors
 * hold gates via the login override (the only override that receives the
 * run's signal).
 */
function cloneOathUploadWithStubbedServiceNow(wf: AnyRegisteredWorkflow): AnyRegisteredWorkflow {
  const handler = async (ctx: AnyCtx, input: unknown): Promise<void> => {
    ctx.updateData({ e2eStub: "true" });
    const stubOpts: OathUploadHandlerOpts = {
      _pageOverride: async () => ({}) as unknown as Page,
      _loginOverride: async (_page, _userDataDir, signal) => {
        await awaitGateRelease({
          workflow: wf.config.name,
          step: "servicenow-auth",
          ...(ctx.trackerDir !== undefined ? { trackerDir: ctx.trackerDir } : {}),
          signal: signal ?? ctx.signal,
        });
        return true;
      },
      _gotoOverride: async () => {},
      _verifyOverride: async () => {},
      _fillFormOverride: async () => {},
      _submitOverride: async () => "HRC0E2E001",
    };
    await oathUploadHandler(
      ctx as unknown as Parameters<typeof oathUploadHandler>[0],
      input as OathUploadInput,
      stubOpts,
    );
  };
  return {
    ...wf,
    config: {
      ...wf.config,
      systems: [],
      handler: handler as unknown as AnyRegisteredWorkflow["config"]["handler"],
    },
  };
}

// ─── Registry ────────────────────────────────────────────────────────────────

const STUB_WRAPPERS: Record<string, (wf: AnyRegisteredWorkflow) => AnyRegisteredWorkflow> = {
  "oath-signature": (wf) => cloneWithScriptedSteps(wf, oathSignatureScript),
  "emergency-contact": (wf) => cloneWithScriptedSteps(wf, emergencyContactScript),
  "person-lookup": (wf) => cloneWithScriptedSteps(wf, personLookupScript),
  "i9-lookup": (wf) => cloneWithScriptedSteps(wf, i9LookupScript),
  "oath-upload": (wf) => cloneOathUploadWithStubbedServiceNow(wf),
};

const announced = new Set<string>();

/**
 * Wrap `wf` with its scripted stub when one is registered. Called by
 * `loadWorkflow` only when HRAUTO_E2E_STUBS=1. Unmapped workflows return REAL
 * — loudly — so dashboard metadata loading and sweeps keep working; the e2e
 * driver never enqueues them.
 */
export function maybeWrapE2EStub(name: string, wf: AnyRegisteredWorkflow): AnyRegisteredWorkflow {
  const wrap = STUB_WRAPPERS[name];
  if (!wrap) {
    if (!announced.has(name)) {
      announced.add(name);
      log.error(
        `[e2e-stubs] no stub wrapper for workflow "${name}" — it would run its REAL handler. Do not enqueue it while HRAUTO_E2E_STUBS=1.`,
      );
    }
    return wf;
  }
  if (!announced.has(name)) {
    announced.add(name);
    log.warn(
      `[e2e-stubs] workflow "${name}" running with SCRIPTED handler (HRAUTO_E2E_STUBS=1) — no external systems will be touched`,
    );
  }
  return wrap(wf);
}

export function isE2EStubMode(): boolean {
  return process.env.HRAUTO_E2E_STUBS === "1";
}
