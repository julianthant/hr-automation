import type { JSX } from "react";
import { ChevronLeft } from "lucide-react";
import { WorkflowModifierPage } from "./WorkflowModifierPage.js";

interface WorkflowEditorScreenProps {
  /** Leave the editor and return to the dashboard (guarded against unsaved edits by the host). */
  onBack: () => void;
  /** Reports the editor's unsaved-draft state up to the host for the leave guard. */
  onDirtyChange?: (dirty: boolean) => void;
}

/**
 * Full-page takeover host for the Workflow Editor. Launched from the Settings
 * dialog ("Workflow Editor →"), it hides the global top bar + workflow rail +
 * session drawer and gives the editor the whole screen, with a slim header
 * carrying the "Back to dashboard" affordance. The editor's own Save / Generate
 * controls live inside {@link WorkflowModifierPage}; this host only owns the
 * takeover chrome.
 */
export function WorkflowEditorScreen({
  onBack,
  onDirtyChange,
}: WorkflowEditorScreenProps): JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-border px-3.5">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-secondary pl-2 pr-3 text-[13px] font-medium text-secondary-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronLeft aria-hidden className="h-4 w-4 shrink-0" />
          Dashboard
        </button>
        <h1 className="text-[15px] font-semibold tracking-tight text-foreground">Workflow Editor</h1>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        <WorkflowModifierPage onDirtyChange={onDirtyChange} />
      </div>
    </div>
  );
}
