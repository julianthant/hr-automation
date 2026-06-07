import { useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ConfirmDialog } from "./ConfirmDialog";

interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "destructive";
  icon?: ReactNode;
}

/**
 * Promise-based replacement for `window.confirm`. Returns `confirm(opts)` —
 * which resolves true/false — plus a `confirmDialog` node to render once in the
 * component. Lets existing `if (!window.confirm(msg)) return;` sites become
 * `if (!(await confirm({...}))) return;` with an on-theme dialog instead of OS
 * chrome.
 */
export function useConfirm() {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback((options: ConfirmOptions) => {
    setOpts(options);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const settle = useCallback((ok: boolean) => {
    resolverRef.current?.(ok);
    resolverRef.current = null;
    setOpts(null);
  }, []);

  const confirmDialog = (
    <ConfirmDialog
      open={opts !== null}
      onOpenChange={(open) => {
        if (!open) settle(false);
      }}
      title={opts?.title ?? ""}
      description={opts?.description}
      confirmLabel={opts?.confirmLabel}
      cancelLabel={opts?.cancelLabel}
      tone={opts?.tone}
      icon={opts?.icon}
      onConfirm={() => settle(true)}
    />
  );

  return { confirm, confirmDialog };
}
