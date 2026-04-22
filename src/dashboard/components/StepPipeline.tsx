import { cn } from "../lib/utils";
import { formatStepName, formatStepDuration, type TrackerEntry } from "./types";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "./ui/tooltip";

interface StepPipelineProps {
  steps: string[];
  currentStep: string | null;
  status: string;
  /** Per-step durations in ms (from backend enrichment). */
  stepDurations?: Record<string, number>;
  /**
   * Full tracker entry for the active run — used to surface cache decoration
   * (steps whose result was reused from cache) and their historical averages.
   * Optional; absence simply means no cache decoration is drawn.
   */
  entry?: TrackerEntry;
}

// ── Auth-step grouping ────────────────────────────────────────────────────────

type StepStatus = "pending" | "running" | "completed" | "failed" | "cached";

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
  if (children.every((c) => c.status === "completed" || c.status === "cached")) return "completed";
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

/** Build a hover title string summarizing per-system auth status + timing. */
function buildAuthGroupTitle(children: StepView[]): string {
  return children
    .map((child) => {
      const systemId = child.name.startsWith("auth:") ? child.name.slice(5) : child.name;
      const statusGlyph =
        child.status === "completed" || child.status === "cached"
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
    case "cached":
      return { backgroundColor: "#3b82f6" };
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

  const isCached = groupStatus === "cached";
  const isComplete = groupStatus === "completed";
  const isActive = groupStatus === "running";
  const isFailedStep = groupStatus === "failed";
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
              !isCached && isComplete && "text-[#4ade80] font-medium",
              !isCached && isActive && "text-primary font-semibold",
              !isCached && isFailedStep && "text-destructive font-semibold",
              !isCached && isPending && "text-muted-foreground/50 font-medium",
              isCached && "font-medium",
            )}
            style={isCached ? { color: "#3b82f6" } : undefined}
          >
            Authenticating ({children.length})
          </span>

          {/* Rail */}
          <div
            className="relative w-full h-[3px] rounded-full"
            style={isCached ? { backgroundColor: "#3b82f6", boxShadow: "0 0 0 3px rgba(59,130,246,0.15)" } : undefined}
          >
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
                )}
                style={authRailStyle(groupStatus)}
              />
            )}
            {isActive && (
              <div
                aria-hidden
                className="absolute inset-y-0 left-0 w-1/2 rounded-full bg-primary animate-[pulse_1.6s_ease-in-out_infinite]"
              />
            )}
          </div>

          {/* Duration / state label */}
          <span
            className={cn(
              "text-[10px] font-mono tabular-nums leading-none h-[10px] transition-colors",
              !isCached && isComplete && (durationLabel ? "text-[#4ade80]/70" : "text-[#4ade80]/40"),
              !isCached && isFailedStep && (durationLabel ? "text-destructive/70" : "text-destructive/40"),
              !isCached && isActive && "text-primary/70",
              !isCached && isPending && "text-muted-foreground/35",
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
              child.status === "completed" || child.status === "cached"
                ? "✓"
                : child.status === "failed"
                  ? "✗"
                  : child.status === "running"
                    ? "…"
                    : "–";
            const glyphColor =
              child.status === "completed" || child.status === "cached"
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
 *   • Pending steps use a dashed rail so "not yet run" reads visually
 *     distinct from "ran quickly" (solid green).
 *   • Consecutive steps matching `auth:*` are collapsed into a single
 *     "Authenticating (N)" super-chip. Hover reveals per-system detail
 *     (Radix popover), no click / expansion state.
 */
export function StepPipeline({ steps, currentStep, status, stepDurations, entry }: StepPipelineProps) {
  if (steps.length === 0) return null;

  const isDone = status === "done";
  const isFailed = status === "failed";
  const cacheHits = entry?.cacheHits ?? [];
  const cacheStepAvgs = entry?.cacheStepAvgs ?? {};
  const cachedSet = new Set(cacheHits);

  // Strip ":failed:<reason>" suffix while preserving the "auth:<id>" prefix.
  // The previous implementation used .split(":")[0] which incorrectly mapped
  // "auth:kuali" → "auth", causing auth-step highlighting to always fall back
  // to index 0.
  const normalizedStep = currentStep ? normalizeStepName(currentStep) : null;
  const resolvedIdx = normalizedStep ? steps.indexOf(normalizedStep) : -1;
  // Failed workflow with no reported step (or an unrecognized one) → mark
  // the first step as failed so the user sees *something* is red, not a
  // row of indistinguishable pending.
  const currentIdx = isFailed && resolvedIdx < 0 ? 0 : resolvedIdx;

  // Build StepView array for all steps
  const stepViews: StepView[] = steps.map((step, i) => {
    const isComplete = isDone || i < currentIdx;
    const isActive = !isDone && !isFailed && i === currentIdx;
    const isFailedStep = isFailed && i === currentIdx;
    const isPending = !isComplete && !isActive && !isFailedStep;
    const isCached = cachedSet.has(step);

    let derivedStatus: StepStatus;
    if (isCached) derivedStatus = "cached";
    else if (isComplete) derivedStatus = "completed";
    else if (isActive) derivedStatus = "running";
    else if (isFailedStep) derivedStatus = "failed";
    else derivedStatus = "pending";

    const durationMs = isPending || isCached ? undefined : stepDurations?.[step];
    return { name: step, status: derivedStatus, durationMs };
  });

  // Group auth steps into super-chips
  const nodes = groupAuthSteps(stepViews);

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
          const isCached = stepStatus === "cached";
          const isComplete = stepStatus === "completed";
          const isActive = stepStatus === "running";
          const isFailedStep = stepStatus === "failed";
          const isPending = stepStatus === "pending";

          const durationLabel =
            typeof durationMs === "number" ? formatStepDuration(durationMs) : "";
          const cacheAvg = cacheStepAvgs[step];
          const cacheTooltip =
            isCached && typeof cacheAvg === "number" && cacheAvg > 0
              ? `${step} · normally ~${formatStepDuration(cacheAvg)}`
              : undefined;

          return (
            <div
              key={step}
              className="flex-1 min-w-[86px] flex flex-col justify-center items-start gap-1.5"
              data-state={
                isCached
                  ? "cached"
                  : isActive
                    ? "active"
                    : isFailedStep
                      ? "failed"
                      : isComplete
                        ? "complete"
                        : "pending"
              }
            >
              <span
                className={cn(
                  "text-[11.5px] tracking-tight leading-none truncate w-full transition-colors",
                  !isCached && isComplete && "text-[#4ade80] font-medium",
                  !isCached && isActive && "text-primary font-semibold",
                  !isCached && isFailedStep && "text-destructive font-semibold",
                  !isCached && isPending && "text-muted-foreground/50 font-medium",
                  isCached && "font-medium",
                )}
                style={isCached ? { color: "#3b82f6" } : undefined}
                title={formatStepName(step)}
              >
                {formatStepName(step)}
              </span>

              <div
                data-testid={`step-dot-${step}`}
                title={cacheTooltip}
                className="relative w-full h-[3px] rounded-full"
                style={
                  isCached
                    ? {
                        backgroundColor: "#3b82f6",
                        boxShadow: "0 0 0 3px rgba(59, 130, 246, 0.15)",
                      }
                    : undefined
                }
              >
                {isCached ? (
                  <span
                    aria-hidden
                    style={{
                      position: "absolute",
                      top: "50%",
                      left: "50%",
                      transform: "translate(-50%, -50%)",
                      color: "#ffffff",
                      fontSize: 9,
                      lineHeight: 1,
                      pointerEvents: "none",
                    }}
                  >
                    {"\u2744"}
                  </span>
                ) : isPending ? (
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
                    )}
                  />
                )}
                {!isCached && isActive && (
                  <div
                    aria-hidden
                    className="absolute inset-y-0 left-0 w-1/2 rounded-full bg-primary animate-[pulse_1.6s_ease-in-out_infinite]"
                  />
                )}
              </div>

              <span
                className={cn(
                  "text-[10px] font-mono tabular-nums leading-none h-[10px] transition-colors",
                  !isCached && isComplete && (durationLabel ? "text-[#4ade80]/70" : "text-[#4ade80]/40"),
                  !isCached && isFailedStep && (durationLabel ? "text-destructive/70" : "text-destructive/40"),
                  !isCached && isActive && "text-primary/70",
                  !isCached && isPending && "text-muted-foreground/35",
                )}
                aria-hidden={isCached || (!durationLabel && !isPending)}
              >
                {isCached ? "" : durationLabel || (isPending ? "—" : isActive ? "…" : "—")}
              </span>
            </div>
          );
        })}
      </div>

      {cacheHits.length > 0 && (
        <div
          style={{
            marginTop: 16,
            marginLeft: 24,
            marginRight: 24,
            marginBottom: 12,
            padding: "10px 14px",
            background: "rgba(59, 130, 246, 0.06)",
            border: "1px solid rgba(59, 130, 246, 0.2)",
            borderRadius: 4,
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontFamily: "system-ui, sans-serif",
            fontSize: 11,
          }}
          className="text-foreground"
        >
          <span style={{ fontSize: 14, color: "#3b82f6", lineHeight: 1 }}>{"\u2744"}</span>
          <span>
            {cacheHits.length} of {steps.length} steps reused from cache
          </span>
        </div>
      )}
    </div>
  );
}
