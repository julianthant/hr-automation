import type { ReactElement, ReactNode } from "react";
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TerminalDrawerProvider } from "@/components/hooks/useTerminalDrawer";
import { BatchQueueParentRunIdProvider } from "@/components/hooks/useBatchQueueContext";

/**
 * Wrap a component under test in the minimal React context the dashboard's
 * shared chrome requires, then render it with `@testing-library/react`.
 *
 * Providers supplied (and why):
 *   - `TooltipProvider` (Radix) — every footer action button is wrapped in a
 *     `<Tooltip>`; rendering one outside a provider throws.
 *   - `TerminalDrawerProvider` — `WorkflowBox` calls `useTerminalDrawer()`,
 *     which throws when no provider is present.
 *   - `BatchQueueParentRunIdProvider` — `RetryButton` / `RowCancelButton`
 *     read `useOptionalBatchQueueParentRunId()`. It has a `null` default so
 *     it's technically optional, but supplying it (and letting callers override
 *     `batchParentRunId`) keeps the harness explicit.
 *
 * `WorkflowsContext` is intentionally NOT provided here — only `WorkflowBox`
 * needs `useWorkflow`, and that test file mocks the module directly (the
 * context object isn't exported, so a provider can't be built around it).
 */
export interface ProviderOptions {
  /** Scope footer actions to a batch queue (default: none / null). */
  batchParentRunId?: string | null;
}

function Providers({
  children,
  batchParentRunId = null,
}: {
  children: ReactNode;
  batchParentRunId?: string | null;
}) {
  return (
    <TooltipProvider>
      <TerminalDrawerProvider>
        <BatchQueueParentRunIdProvider parentRunId={batchParentRunId}>
          {children}
        </BatchQueueParentRunIdProvider>
      </TerminalDrawerProvider>
    </TooltipProvider>
  );
}

export function renderWithProviders(
  ui: ReactElement,
  options: ProviderOptions & Omit<RenderOptions, "wrapper"> = {},
): RenderResult {
  const { batchParentRunId, ...renderOptions } = options;
  return render(ui, {
    wrapper: ({ children }) => (
      <Providers batchParentRunId={batchParentRunId}>{children}</Providers>
    ),
    ...renderOptions,
  });
}
