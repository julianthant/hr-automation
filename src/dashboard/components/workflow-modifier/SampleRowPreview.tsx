import type { PreviewResult, WorkflowPresentationDetail } from "./useWorkflowPresentation.js";

export function SampleRowPreview(props: {
  previewResult: PreviewResult | null;
  data: WorkflowPresentationDetail | null;
}): JSX.Element {
  const { previewResult } = props;
  const sample = previewResult?.sample ?? null;

  return (
    <section className="h-full" aria-label="Sample row preview">
      <h3 className="text-sm font-semibold mb-3 text-foreground">Preview</h3>

      {sample != null ? (
        <div className="rounded-md border border-border bg-card p-3 space-y-2">
          {/* Title */}
          {sample.title ? (
            <p className="text-base font-semibold text-foreground leading-snug">
              {sample.title}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground italic">
              (no title — count/preview identifies the row)
            </p>
          )}

          {/* Subtitle */}
          {sample.subtitle != null ? (
            <p className="text-sm text-muted-foreground">{sample.subtitle}</p>
          ) : null}

          {/* Step chips */}
          {sample.steps.length > 0 ? (
            <div className="flex flex-wrap gap-1 pt-1" aria-label="Workflow steps">
              {sample.steps.map((step) => (
                <span
                  key={step.step}
                  className="rounded border border-border bg-secondary/40 px-2 py-0.5 text-xs text-foreground"
                >
                  {step.label}
                  {step.foldedSteps.length > 0 ? (
                    <span
                      className="ml-1 text-muted-foreground"
                      title={step.foldedSteps.join(", ")}
                    >
                      +{step.foldedSteps.length}
                    </span>
                  ) : null}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Edit a field and click Preview to see how the row will read.
        </p>
      )}
    </section>
  );
}
