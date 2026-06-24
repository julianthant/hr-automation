import { cn } from "@/lib/utils";
import { formatStepName, formatStepDuration, type TrackerEntry } from "@/components/shared/types";
import {
  OCR_CANONICAL_STEP_ORDER as _OCR_CANONICAL_STEP_ORDER,
  OCR_RETIRED_STEP_FOLD as _OCR_RETIRED_STEP_FOLD,
} from "../../../domain/ocr-steps.js";
import { applyStepDisplay } from "../../../domain/workflow-presentation/step-display.js";
import type { StepDisplayConfig } from "../../../domain/workflow-presentation/types.js";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";

interface StepPipelineProps {
  steps: string[];
  currentStep: string | null;
  status: string;
  /** Per-step durations in ms (from backend enrichment). */
  stepDurations?: Record<string, number>;
  /** Full tracker entry for the active run. Reserved for future decoration. */
  entry?: TrackerEntry;
  /**
   * The workflow's effective `presentation.steps` config (from
   * `/api/workflow-definitions`). Drives the displayed step ORDER, visibility
   * (hide), and per-step label overrides via `applyStepDisplay`. Generic
   * plumbing for the Workflow Modifier — no workflow declares it yet, so today
   * this is always undefined and the timeline renders the declared steps in
   * order with default (`formatStepName`) labels, byte-identical to before.
   * (NOT OCR's `matching`/`disambiguating` fold — that is the backend `ocrSteps`
   * drop + the run-conditional `computeOcrPipelineView` remap, not this config.)
   * Phase-5 caveat: hiding a step a run is actively parked at would orphan the
   * `currentStep` highlight (all chips read pending); guard when that ships.
   */
  stepDisplay?: StepDisplayConfig;
}

// ── Auth-step grouping ────────────────────────────────────────────────────────

type StepStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

interface StepView {
  name: string;
  status: StepStatus;
  durationMs?: number;
}

interface AuthGroupNode {
  kind: "auth-group";
  children: StepView[];
}

type PipelineNode = StepView | AuthGroupNode;

function isAuthGroup(node: PipelineNode): node is AuthGroupNode {
  return "kind" in node && node.kind === "auth-group";
}

/**
 * Group any run of consecutive steps whose names start with "auth:" into one
 * super-chip node. Non-auth steps pass through unchanged.
 */
function groupAuthSteps(steps: StepView[]): PipelineNode[] {
  const out: PipelineNode[] = [];
  let buffer: StepView[] = [];
  for (const s of steps) {
    if (s.name.startsWith("auth:")) {
      buffer.push(s);
    } else {
      if (buffer.length > 0) {
        out.push({ kind: "auth-group", children: buffer });
        buffer = [];
      }
      out.push(s);
    }
  }
  if (buffer.length > 0) out.push({ kind: "auth-group", children: buffer });
  return out;
}

/** Derive a collapsed status from the children of an auth-group super-chip. */
function authGroupStatus(children: StepView[]): StepStatus {
  if (children.some((c) => c.status === "failed")) return "failed";
  if (children.some((c) => c.status === "cancelled")) return "cancelled";
  if (children.every((c) => c.status === "completed")) return "completed";
  if (children.some((c) => c.status === "running")) return "running";
  return "pending";
}

/**
 * Strip a ":failed:<reason>" suffix from a step name, while preserving the
 * "auth:<id>" prefix that is part of the canonical step name.
 *
 * The previous implementation used .split(":")[0] which incorrectly mapped
 * "auth:kuali" → "auth", causing auth steps to never match in steps.indexOf().
 *
 * Examples:
 *   "auth:kuali:failed:Timed out" → "auth:kuali"
 *   "kuali-extraction:failed:Network error" → "kuali-extraction"
 *   "auth:kuali" → "auth:kuali"
 *   "ucpath-transaction" → "ucpath-transaction"
 */
function normalizeStepName(step: string): string {
  const failedIdx = step.indexOf(":failed:");
  if (failedIdx === -1) return step;
  return step.slice(0, failedIdx);
}

/**
 * Display label for a pipeline step. The OCR-exclusive `awaiting-approval`
 * terminal phase reads "Awaiting Approval" only for a DELEGATED run — one a
 * target workflow (oath-signature / oath-upload / emergency-contact) consumes,
 * so it carries `parentRunId` and a real operator-approval gate. A STANDALONE
 * OCR run (no `parentRunId`) is inspect-and-discard: nothing downstream awaits
 * approval, so its terminal phase reads "Review" instead. Mirrors the
 * `OcrReviewPane` Approve-button gate (approval ≡ delegation). This
 * run-conditional override stays in the component (config can't express it).
 *
 * The static base label comes from `displayLabels` (built by `applyStepDisplay`
 * over the workflow's `presentation.steps`, formatted with `formatStepName`):
 * a config `rule.label` wins, else `formatStepName(step)` — byte-identical to
 * the prior direct `formatStepName` call when no override is declared.
 * (`awaiting-approval` is unique to OCR's step list, so the Review override
 * never affects another workflow's timeline.)
 */
function pipelineStepLabel(
  step: string,
  entry: TrackerEntry | undefined,
  displayLabels: Map<string, string>,
): string {
  if (step === "awaiting-approval" && !entry?.parentRunId) return "Review";
  return displayLabels.get(step) ?? formatStepName(step);
}

/** Build a hover title string summarizing per-system auth status + timing. */
function buildAuthGroupTitle(children: StepView[]): string {
  return children
    .map((child) => {
      const systemId = child.name.startsWith("auth:") ? child.name.slice(5) : child.name;
      const statusGlyph =
        child.status === "completed"
          ? "✓"
          : child.status === "failed"
            ? "✗"
            : child.status === "running"
              ? "…"
              : "–";
      const timing =
        child.durationMs !== undefined ? formatStepDuration(child.durationMs) : "–";
      return `${statusGlyph} ${systemId}  ${timing}`;
    })
    .join("\n");
}

// ── Auth super-chip rail style helper ─────────────────────────────────────────

function authRailStyle(status: StepStatus): React.CSSProperties {
  switch (status) {
    case "completed":
      return { backgroundColor: "rgba(74, 222, 128, 0.8)" };
    case "failed":
      return {};  // uses className
    case "running":
      return {};  // uses className
    default:
      return {};
  }
}

/**
 * Aggregate child durations for an auth super-chip timer.
 *
 * Graceful degradation: if any children are still running (no duration yet),
 * we still render the total of known durations with a "partial" flag so the
 * caller can append a "+" suffix ("3.4s+") rather than hiding the timer
 * entirely. Returns undefined only when no child has a known duration.
 */
export function computeAuthGroupDuration(
  children: StepView[],
): { totalMs: number; partial: boolean } | undefined {
  const known = children.filter((c) => c.durationMs !== undefined);
  if (known.length === 0) return undefined;
  const totalMs = known.reduce((sum, c) => sum + (c.durationMs ?? 0), 0);
  return { totalMs, partial: known.length < children.length };
}

// ── AuthSuperChip ─────────────────────────────────────────────────────────────

interface AuthSuperChipProps {
  children: StepView[];
}

function AuthSuperChip({ children }: AuthSuperChipProps) {
  const groupStatus = authGroupStatus(children);

  const aggregate = computeAuthGroupDuration(children);
  const totalDurationMs = aggregate?.totalMs;
  const partial = aggregate?.partial ?? false;
  const durationLabel = totalDurationMs !== undefined
    ? `${formatStepDuration(totalDurationMs)}${partial ? "+" : ""}`
    : "";

  const isComplete = groupStatus === "completed";
  const isActive = groupStatus === "running";
  const isFailedStep = groupStatus === "failed";
  const isCancelledStep = groupStatus === "cancelled";
  const isPending = groupStatus === "pending";

  const hoverTitle = buildAuthGroupTitle(children);

  return (
    <TooltipProvider delayDuration={100} skipDelayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={hoverTitle}
          className="flex-1 min-w-[86px] flex flex-col justify-center items-start gap-1.5 cursor-default focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm"
          style={{ background: "none", border: "none", padding: 0, textAlign: "left" }}
        >
          {/* Label */}
          <span
            className={cn(
              "text-[11.5px] tracking-tight leading-none truncate w-full transition-colors",
              isComplete && "text-[#4ade80] font-medium",
              isActive && "text-primary font-semibold",
              isFailedStep && "text-destructive font-semibold",
              isCancelledStep && "text-warning font-semibold",
              isPending && "text-muted-foreground/50 font-medium",
            )}
          >
            Authenticating ({children.length})
          </span>

          {/* Rail */}
          <div className="relative w-full h-[3px] rounded-full">

            {isPending ? (
              <div
                aria-hidden
                className="absolute inset-0 rounded-full opacity-70 overflow-hidden"
                style={{
                  backgroundImage:
                    "repeating-linear-gradient(to right, hsl(var(--border)) 0 4px, transparent 4px 8px)",
                }}
              />
            ) : (
              <div
                className={cn(
                  "absolute inset-0 rounded-full overflow-hidden transition-colors",
                  isComplete && "bg-[#4ade80]/80",
                  isActive && "bg-primary/25",
                  isFailedStep && "bg-destructive/80",
                  isCancelledStep && "bg-warning/80",
                )}
                style={authRailStyle(groupStatus)}
              />
            )}
            {isActive && (
              <div
                aria-hidden
                className="absolute inset-y-0 left-0 w-1/2 rounded-full bg-primary motion-safe:animate-pulse"
              />
            )}
          </div>

          {/* Duration / state label */}
          <span
            className={cn(
              "text-[10px] font-mono tabular-nums leading-none h-[10px] transition-colors",
              isComplete && (durationLabel ? "text-[#4ade80]/70" : "text-[#4ade80]/40"),
              isFailedStep && (durationLabel ? "text-destructive/70" : "text-destructive/40"),
              isCancelledStep && (durationLabel ? "text-warning/70" : "text-warning/40"),
              isActive && "text-primary/70",
              isPending && "text-muted-foreground/35",
            )}
            aria-hidden={!durationLabel && !isPending}
          >
            {durationLabel || (isPending ? "—" : isActive ? "…" : "—")}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="center"
        sideOffset={8}
        className="w-auto p-2"
      >
        <div className="flex flex-col gap-1.5 text-xs">
          {children.map((child) => {
            const systemId = child.name.startsWith("auth:") ? child.name.slice(5) : child.name;
            const statusGlyph =
              child.status === "completed"
                ? "✓"
                : child.status === "failed"
                  ? "✗"
                  : child.status === "running"
                    ? "…"
                    : "–";
            const glyphColor =
              child.status === "completed"
                ? "text-[#4ade80]"
                : child.status === "failed"
                  ? "text-destructive"
                  : child.status === "running"
                    ? "text-primary"
                    : "text-muted-foreground";
            return (
              <div key={child.name} className="flex items-center gap-3 min-w-[180px]">
                <span className={cn("w-3 text-center", glyphColor)}>{statusGlyph}</span>
                <span className="font-mono text-[11px]">{systemId}</span>
                <span className="ml-auto font-mono text-[10px] text-muted-foreground tabular-nums">
                  {child.durationMs !== undefined ? formatStepDuration(child.durationMs) : "—"}
                </span>
              </div>
            );
          })}
        </div>
      </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Pure derivation of per-step view state from the run's reported step/status.
 * Exported for unit testing — the component renders whatever this returns.
 *
 * Cancellation is the subtle case. A cancelled run is `status="failed"` with
 * the `step="cancelled"` sentinel, so `currentStep` no longer names the step
 * it was sitting on — without recovery it falls into the "failed + unknown
 * step → step 0" path and the highlight snaps back to the first step. We
 * recover the reached step from `stepDurations`: every COMPLETED step has a
 * recorded duration, so the step it was stopped on is the one just after the
 * furthest step that has one (clamped to the last step). That step is marked
 * `cancelled` (amber), matching the row's "Cancelled" badge, rather than a
 * misleading red `failed`.
 */
export function computeStepViews(
  steps: string[],
  currentStep: string | null,
  status: string,
  stepDurations?: Record<string, number>,
): StepView[] {
  const isDone = status === "done";
  const isFailed = status === "failed";
  const isCancelled = isFailed && currentStep === "cancelled";

  // Strip ":failed:<reason>" suffix while preserving the "auth:<id>" prefix.
  // The previous implementation used .split(":")[0] which incorrectly mapped
  // "auth:kuali" → "auth", causing auth-step highlighting to always fall back
  // to index 0.
  const normalizedStep = currentStep ? normalizeStepName(currentStep) : null;
  const resolvedIdx = normalizedStep ? steps.indexOf(normalizedStep) : -1;

  // Furthest step with a recorded duration = furthest COMPLETED step; the run
  // was stopped on the next one (clamped to the last step).
  const lastTimedIdx = steps.reduce(
    (max, step, i) => (stepDurations?.[step] !== undefined ? i : max),
    -1,
  );
  const cancelledAtIdx = Math.min(lastTimedIdx + 1, steps.length - 1);

  // Which step the rail highlights:
  //   • cancelled → the recovered cancellation point (above)
  //   • failed with an unknown/missing step (workflow died before emitting a
  //     `running` event) → step 0, so *something* reads as the failure point
  //   • otherwise → the reported step
  const currentIdx = isCancelled
    ? cancelledAtIdx
    : isFailed && resolvedIdx < 0
      ? 0
      : resolvedIdx;

  const awaitingIdx = steps.indexOf("awaiting-approval");
  // New approval contract (2026-05-25): OCR awaiting-approval is
  // `status="running" step="awaiting-approval"`. Old contract emitted
  // `status="done"` at that step; legacy rows may still surface that
  // shape, so accept both.
  const gateAwaitingApproval =
    awaitingIdx >= 0 &&
    normalizedStep === "awaiting-approval" &&
    (status === "running" || status === "done");

  return steps.map((step, i) => {
    const isComplete = gateAwaitingApproval ? i < awaitingIdx : isDone || i < currentIdx;
    const isCancelStep = isCancelled && i === currentIdx;
    const isActive = !isDone && !isFailed && i === currentIdx;
    const isFailedStep = isFailed && !isCancelled && i === currentIdx;
    const isPending = !isComplete && !isActive && !isFailedStep && !isCancelStep;

    let derivedStatus: StepStatus;
    if (isComplete) derivedStatus = "completed";
    else if (isCancelStep) derivedStatus = "cancelled";
    else if (isActive) derivedStatus = "running";
    else if (isFailedStep) derivedStatus = "failed";
    else derivedStatus = "pending";

    const durationMs = isPending ? undefined : stepDurations?.[step];
    return { name: step, status: derivedStatus, durationMs };
  });
}

/**
 * Canonical full ordering of OCR phases, INCLUDING the retired/merged step
 * names that the live `ocrSteps` list no longer carries. Used ONLY to POSITION
 * a parked legacy `currentStep` relative to the visible live steps when
 * remapping — never rendered. (`matching` + `disambiguating` are now folded
 * into the single `ocr` step; `verification` was absorbed by `person-lookup`.)
 *
 * Sourced from `src/domain/ocr-steps.ts` — the single source of truth shared
 * with the orchestrator-contract guard test.
 */
const OCR_CANONICAL_STEP_ORDER: string[] = [..._OCR_CANONICAL_STEP_ORDER];

/**
 * Retired sub-phases that fold ONTO a surviving live step (rather than
 * advancing past it). `matching` + `disambiguating` are part of the merged
 * `ocr` step, so a row reported at either lights up `ocr`. (`verification` is
 * NOT here — it sat AFTER person-lookup, so it advances past it via the
 * order-based remap below.)
 *
 * Sourced from `src/domain/ocr-steps.ts` — the single source of truth shared
 * with the orchestrator-contract guard test.
 */
const OCR_RETIRED_STEP_FOLD: Record<string, string> = { ..._OCR_RETIRED_STEP_FOLD };

/**
 * Cosmetic OCR pipeline filter. The live OCR step list is
 * `loading-roster → ocr → person-lookup → awaiting-approval` — `matching` +
 * `disambiguating` were merged into `ocr` (operator-facing: one "OCR" step
 * covers read → match → disambiguate). A STANDALONE run completes `done` at
 * person-lookup (no approval gate — approval ≡ delegation), so its
 * `awaiting-approval` chip is hidden; a DELEGATED ("approve") run keeps it
 * ("Awaiting Approval").
 *
 * Two remap concerns:
 *   1. A row reported at a folded sub-phase (`matching`/`disambiguating`, or a
 *      legacy persisted row) lights up the merged `ocr` step — a failure there
 *      surfaces on `ocr`.
 *   2. A row PARKED on a hidden/retired step (a standalone run at
 *      `awaiting-approval`, or any legacy `verification` row) would otherwise
 *      leave `currentStep` unmatched → `computeStepViews` shows every chip
 *      pending. We position it via {@link OCR_CANONICAL_STEP_ORDER} and remap:
 *      no visible step after it → all visible complete (`done`); a visible step
 *      still ahead → advance the highlight; a FAILURE → surface on the last
 *      visible step before it. Non-OCR workflows pass through untouched.
 *
 * Pure + exported for unit testing.
 */
export function computeOcrPipelineView(
  registeredSteps: string[],
  currentStep: string | null,
  status: string,
  isDelegated: boolean,
): { steps: string[]; currentStep: string | null; status: string } {
  // Standalone runs hide the delegated-only `awaiting-approval` gate.
  const hidden = new Set<string>();
  if (!isDelegated) hidden.add("awaiting-approval");
  const visible = registeredSteps.filter((s) => !hidden.has(s));

  const normalized = currentStep ? normalizeStepName(currentStep) : null;
  if (!normalized) return { steps: visible, currentStep, status };

  // A retired sub-phase folds onto its surviving live step (matching/
  // disambiguating → ocr). Keep `status` so a failure there surfaces on it.
  const folded = OCR_RETIRED_STEP_FOLD[normalized];
  if (folded && visible.includes(folded)) {
    return { steps: visible, currentStep: folded, status };
  }

  // A live, visible step passes through unchanged (preserving any
  // ":failed:<reason>" suffix for computeStepViews).
  if (visible.includes(normalized)) {
    return { steps: visible, currentStep, status };
  }

  // Otherwise the step is hidden (awaiting-approval on a standalone run) or a
  // retired step that sat AFTER the live work (`verification`). Position it via
  // the canonical order and remap to the nearest visible step.
  const pos = OCR_CANONICAL_STEP_ORDER.indexOf(normalized);
  if (status === "failed") {
    const before = visible.filter((s) => OCR_CANONICAL_STEP_ORDER.indexOf(s) < pos);
    return { steps: visible, currentStep: before[before.length - 1] ?? visible[0] ?? null, status };
  }
  const after = visible.filter((s) => OCR_CANONICAL_STEP_ORDER.indexOf(s) > pos);
  if (after.length === 0) {
    return { steps: visible, currentStep: null, status: "done" };
  }
  return { steps: visible, currentStep: after[0]!, status };
}

/**
 * Segmented progress rail — one flex-1 column per step, equal horizontal
 * space. Each column stacks (left-aligned, vertically centered in the
 * 69.5 px band):
 *
 *   step label       state-colored
 *   ─────────        3 px solid rail (complete/active/failed) OR a dashed
 *                    pattern (pending / not yet run)
 *   duration         mono, state-colored, shows "—" for steps that never ran
 *
 * State resolution:
 *   • If status is "failed" but no currentStep is reported (workflow died
 *     before emitting a `running` event), we treat step 0 as the failed
 *     step so the failure marker is always visible.
 *   • A cancelled run is `status="failed" step="cancelled"` — the sentinel
 *     loses the reached step, so we recover it from `stepDurations` and mark
 *     that step `cancelled` (amber) instead of snapping the highlight back to
 *     step 0. See `computeStepViews`.
 *   • Pending steps use a dashed rail so "not yet run" reads visually
 *     distinct from "ran quickly" (solid green).
 *   • Consecutive steps matching `auth:*` are collapsed into a single
 *     "Authenticating (N)" super-chip. Hover reveals per-system detail
 *     (Radix popover), no click / expansion state.
 */
export function StepPipeline({ steps, currentStep, status, stepDurations, entry, stepDisplay }: StepPipelineProps) {
  if (steps.length === 0) return null;

  // presentation.steps drives the displayed step ORDER, visibility (hidden), and
  // labels; formatStepName is injected as the base formatter so labels stay
  // byte-identical to today when no override is declared. No config →
  // applyStepDisplay returns the steps in declared order unchanged (no-op). The
  // RUN-CONDITIONAL currentStep/status remap + standalone awaiting-approval hide
  // stay upstream in computeOcrPipelineView.
  const displaySteps = applyStepDisplay(steps, stepDisplay, formatStepName);
  const displayLabels = new Map(displaySteps.map((d) => [d.step, d.label]));

  // Group auth steps into super-chips
  const nodes = groupAuthSteps(
    computeStepViews(displaySteps.map((d) => d.step), currentStep, status, stepDurations),
  );

  return (
    <div className="border-b border-border">
      {/* Main pipeline rail */}
      <div
        className="flex items-stretch px-6 gap-3 overflow-x-auto"
        style={{ height: "69.5px" }}
      >
        {nodes.map((node) => {
          if (isAuthGroup(node)) {
            const groupKey = node.children[0]?.name ?? "auth-group";
            return <AuthSuperChip key={groupKey} children={node.children} />;
          }

          // Normal chip — unchanged from original
          const { name: step, status: stepStatus, durationMs } = node;
          const isComplete = stepStatus === "completed";
          const isActive = stepStatus === "running";
          const isFailedStep = stepStatus === "failed";
          const isCancelledStep = stepStatus === "cancelled";
          const isPending = stepStatus === "pending";

          const durationLabel =
            typeof durationMs === "number" ? formatStepDuration(durationMs) : "";

          const stepLabel = pipelineStepLabel(step, entry, displayLabels);

          return (
            <div
              key={step}
              className="flex-1 min-w-[86px] flex flex-col justify-center items-start gap-1.5"
              data-state={
                isActive
                    ? "active"
                    : isFailedStep
                      ? "failed"
                      : isCancelledStep
                        ? "cancelled"
                        : isComplete
                          ? "complete"
                          : "pending"
              }
            >
              <span
                className={cn(
                  "text-[11.5px] tracking-tight leading-none truncate w-full transition-colors",
                  isComplete && "text-[#4ade80] font-medium",
                  isActive && "text-primary font-semibold",
                  isFailedStep && "text-destructive font-semibold",
                  isCancelledStep && "text-warning font-semibold",
                  isPending && "text-muted-foreground/50 font-medium",
                )}
                title={stepLabel}
              >
                {stepLabel}
              </span>

              <div
                data-testid={`step-dot-${step}`}
                className="relative w-full h-[3px] rounded-full"
              >
                {isPending ? (
                  // Dashed rail — "not yet run". Made with a repeating linear
                  // gradient so the dashes read clearly at 3 px without
                  // needing a border (which would also violate the
                  // no-border-top convention).
                  <div
                    aria-hidden
                    className="absolute inset-0 rounded-full opacity-70 overflow-hidden"
                    style={{
                      backgroundImage:
                        "repeating-linear-gradient(to right, hsl(var(--border)) 0 4px, transparent 4px 8px)",
                    }}
                  />
                ) : (
                  <div
                    className={cn(
                      "absolute inset-0 rounded-full overflow-hidden transition-colors",
                      isComplete && "bg-[#4ade80]/80",
                      isActive && "bg-primary/25",
                      isFailedStep && "bg-destructive/80",
                      isCancelledStep && "bg-warning/80",
                    )}
                  />
                )}
                {isActive && (
                  <div
                    aria-hidden
                    className="absolute inset-y-0 left-0 w-1/2 rounded-full bg-primary motion-safe:animate-pulse"
                  />
                )}
              </div>

              <span
                className={cn(
                  "text-[10px] font-mono tabular-nums leading-none h-[10px] transition-colors",
                  isComplete && (durationLabel ? "text-[#4ade80]/70" : "text-[#4ade80]/40"),
                  isFailedStep && (durationLabel ? "text-destructive/70" : "text-destructive/40"),
                  isCancelledStep && (durationLabel ? "text-warning/70" : "text-warning/40"),
                  isActive && "text-primary/70",
                  isPending && "text-muted-foreground/35",
                )}
                aria-hidden={!durationLabel && !isPending}
              >
                {durationLabel || (isPending ? "—" : isActive ? "…" : "—")}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
