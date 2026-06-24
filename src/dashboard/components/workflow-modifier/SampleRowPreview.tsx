import type { PreviewResult, WorkflowPresentationDetail } from "./useWorkflowPresentation.js";

export function SampleRowPreview(props: {
  previewResult: PreviewResult | null;
  data: WorkflowPresentationDetail | null;
}): JSX.Element {
  const { previewResult, data } = props;
  const sample = previewResult?.sample ?? null;

  return (
    <section aria-label="Sample row preview" className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Preview
      </h3>

      {data == null ? (
        <p className="text-sm text-muted-foreground">
          Select a workflow to configure how its rows are named.
        </p>
      ) : sample != null ? (
        <>
          {/* "With your changes" card */}
          <div className="rounded-md border border-border bg-card p-3 space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              With your changes
            </p>
            {/* Title */}
            {sample.title ? (
              <p className="text-sm font-medium text-foreground leading-snug">
                {sample.title}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground italic">
                (no title — count/preview identifies the row)
              </p>
            )}

            {/* Subtitle */}
            {sample.subtitle != null ? (
              <p className="text-xs text-muted-foreground">{sample.subtitle}</p>
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
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Press Preview to see how a sample row will read.
        </p>
      )}
    </section>
  );
}
