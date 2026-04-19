import { cn } from "@/lib/utils";
import { formatStepName, formatStepDuration, type TrackerEntry } from "./types";

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
 */
export function StepPipeline({ steps, currentStep, status, stepDurations, entry }: StepPipelineProps) {
  if (steps.length === 0) return null;

  const isDone = status === "done";
  const isFailed = status === "failed";
  const cacheHits = entry?.cacheHits ?? [];
  const cacheStepAvgs = entry?.cacheStepAvgs ?? {};
  const cachedSet = new Set(cacheHits);
  // Step names from failed runs sometimes carry a ":failed:<reason>" suffix
  // (e.g. "i9-creation:failed:Timed out waiting for element"). Strip to the
  // root before matching against the registry's declared step names, so
  // failed runs highlight the correct step instead of falling back to 0.
  const normalizedStep = currentStep ? currentStep.split(":")[0] : null;
  const resolvedIdx = normalizedStep ? steps.indexOf(normalizedStep) : -1;
  // Failed workflow with no reported step (or an unrecognized one) → mark
  // the first step as failed so the user sees *something* is red, not a
  // row of indistinguishable pending.
  const currentIdx = isFailed && resolvedIdx < 0 ? 0 : resolvedIdx;

  return (
    <div className="border-b border-border">
      <div
        className="flex items-stretch px-6 gap-3 overflow-x-auto"
        style={{ height: "69.5px" }}
      >
        {steps.map((step, i) => {
          const isComplete = isDone || i < currentIdx;
          const isActive = !isDone && !isFailed && i === currentIdx;
          const isFailedStep = isFailed && i === currentIdx;
          const isPending = !isComplete && !isActive && !isFailedStep;
          const isCached = cachedSet.has(step);
          // A pending step (workflow failed before reaching it, or it simply
          // hasn't run yet) must NEVER display a duration, even if stepDurations
          // happens to carry a stale value for that step name from a previous
          // run that did complete it. Only complete / active / the failed step
          // itself may show a duration — where "failed" = "how long it ran
          // before failing".
          // Cached steps also omit the duration chip — the snowflake glyph
          // carries the meaning, and the hover tooltip shows the historical
          // avg instead.
          const durationMs = isPending || isCached ? undefined : stepDurations?.[step];
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
