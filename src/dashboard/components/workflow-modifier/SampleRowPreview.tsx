import type { PreviewResult, WorkflowPresentationDetail } from "./useWorkflowPresentation.js";

export function SampleRowPreview(props: {
  previewResult: PreviewResult | null;
  data: WorkflowPresentationDetail | null;
}): JSX.Element {
  void props;
  return (
    <section className="rounded-md border border-border p-4 h-full">
      <p className="text-sm text-muted-foreground">Sample row preview — built in 5.4</p>
    </section>
  );
}
