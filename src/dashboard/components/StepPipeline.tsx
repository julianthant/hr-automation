import { cn } from "@/lib/utils";
import { formatStepName, formatStepDuration } from "./types";

interface StepPipelineProps {
  steps: string[];
  currentStep: string | null;
  status: string;
  /** Per-step durations in ms (from backend enrichment). */
  stepDurations?: Record<string, number>;
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
export function StepPipeline({ steps, currentStep, status, stepDurations }: StepPipelineProps) {
  if (steps.length === 0) return null;

  const isDone = status === "done";
  const isFailed = status === "failed";
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
    <div
      className="flex items-stretch px-6 gap-3 border-b border-border overflow-x-auto"
      style={{ height: "69.5px" }}
    >
      {steps.map((step, i) => {
        const isComplete = isDone || i < currentIdx;
        const isActive = !isDone && !isFailed && i === currentIdx;
        const isFailedStep = isFailed && i === currentIdx;
        const isPending = !isComplete && !isActive && !isFailedStep;
        // A pending step (workflow failed before reaching it, or it simply
        // hasn't run yet) must NEVER display a duration, even if stepDurations
        // happens to carry a stale value for that step name from a previous
        // run that did complete it. Only complete / active / the failed step
        // itself may show a duration — where "failed" = "how long it ran
        // before failing".
        const durationMs = isPending ? undefined : stepDurations?.[step];
        const durationLabel =
          typeof durationMs === "number" ? formatStepDuration(durationMs) : "";

        return (
          <div
            key={step}
            className="flex-1 min-w-[86px] flex flex-col justify-center items-start gap-1.5"
            data-state={
              isActive ? "active" : isFailedStep ? "failed" : isComplete ? "complete" : "pending"
            }
          >
            <span
              className={cn(
                "text-[11.5px] tracking-tight leading-none truncate w-full transition-colors",
                isComplete && "text-[#4ade80] font-medium",
                isActive && "text-primary font-semibold",
                isFailedStep && "text-destructive font-semibold",
                isPending && "text-muted-foreground/50 font-medium",
              )}
              title={formatStepName(step)}
            >
              {formatStepName(step)}
            </span>

            <div className="relative w-full h-[3px] rounded-full overflow-hidden">
              {isPending ? (
                // Dashed rail — "not yet run". Made with a repeating linear
                // gradient so the dashes read clearly at 3 px without
                // needing a border (which would also violate the
                // no-border-top convention).
                <div
                  aria-hidden
                  className="absolute inset-0 rounded-full opacity-70"
                  style={{
                    backgroundImage:
                      "repeating-linear-gradient(to right, hsl(var(--border)) 0 4px, transparent 4px 8px)",
                  }}
                />
              ) : (
                <div
                  className={cn(
                    "absolute inset-0 rounded-full transition-colors",
                    isComplete && "bg-[#4ade80]/80",
                    isActive && "bg-primary/25",
                    isFailedStep && "bg-destructive/80",
                  )}
                />
              )}
              {isActive && (
                <div
                  aria-hidden
                  className="absolute inset-y-0 left-0 w-1/2 rounded-full bg-primary animate-[pulse_1.6s_ease-in-out_infinite]"
                />
              )}
            </div>

            <span
              className={cn(
                "text-[10px] font-mono tabular-nums leading-none h-[10px] transition-colors",
                isComplete && (durationLabel ? "text-[#4ade80]/70" : "text-[#4ade80]/40"),
                isFailedStep && (durationLabel ? "text-destructive/70" : "text-destructive/40"),
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
  );
}
