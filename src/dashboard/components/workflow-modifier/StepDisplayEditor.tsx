import type { WorkflowPresentationDetail, WorkflowOverride } from "./useWorkflowPresentation.js";

export function StepDisplayEditor(props: {
  data: WorkflowPresentationDetail;
  draft: WorkflowOverride;
  onChange: (next: WorkflowOverride) => void;
}): JSX.Element {
  void props;
  return (
    <section className="rounded-md border border-border p-4">
      <p className="text-sm text-muted-foreground">Step display — built in 5.3</p>
    </section>
  );
}
