import * as React from "react";
import { GripVertical } from "lucide-react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from "react-resizable-panels";
import { cn } from "@/lib/utils";

/**
 * shadcn-style Resizable wrappers around `react-resizable-panels`, tokenized to
 * the dashboard theme (no raw colour — architecture-guarded). Replaces the
 * hand-rolled `shared/ColumnResizer.tsx` for the queue↔detail split. Panel
 * sizes persist via the group's `autoSaveId`.
 */

function ResizablePanelGroup({
  className,
  ...props
}: React.ComponentProps<typeof PanelGroup>) {
  return (
    <PanelGroup
      className={cn(
        "flex h-full w-full data-[panel-group-direction=vertical]:flex-col",
        className,
      )}
      {...props}
    />
  );
}

const ResizablePanel = Panel;

function ResizableHandle({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof PanelResizeHandle> & {
  /** Render the centered grip affordance (default true). */
  withHandle?: boolean;
}) {
  const showGrip = withHandle ?? true;
  return (
    <PanelResizeHandle
      className={cn(
        "group relative flex w-px shrink-0 items-center justify-center bg-border outline-none transition-colors",
        // Generous invisible hit area without taking layout width.
        "after:absolute after:inset-y-0 after:left-1/2 after:w-3 after:-translate-x-1/2",
        "hover:bg-info/60 focus-visible:bg-info/60 data-[resize-handle-state=drag]:bg-info",
        "data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-full",
        "data-[panel-group-direction=vertical]:after:left-0 data-[panel-group-direction=vertical]:after:h-3 data-[panel-group-direction=vertical]:after:w-full data-[panel-group-direction=vertical]:after:-translate-y-1/2 data-[panel-group-direction=vertical]:after:translate-x-0",
        className,
      )}
      {...props}
    >
      {showGrip && (
        <div className="z-10 flex h-8 w-3 items-center justify-center rounded-sm border border-border bg-secondary opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[resize-handle-state=drag]:opacity-100">
          <GripVertical aria-hidden className="h-3 w-3 text-muted-foreground" />
        </div>
      )}
    </PanelResizeHandle>
  );
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
