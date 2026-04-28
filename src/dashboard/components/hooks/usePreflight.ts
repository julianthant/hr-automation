import { useEffect, useRef } from "react";
import { toast } from "sonner";

interface PreflightCheck {
  name: string;
  passed: boolean;
  detail: string;
}

/**
 * Sonner-toast preflight result on dashboard mount.
 *
 * Quiet by design:
 *  - **Pass** path is silent. The operator doesn't need a "things are
 *    working" confirmation on every page reload — the live dot in the
 *    TopBar already conveys that.
 *  - **Fail** path fires a warning toast with the broken checks itemized,
 *    suppressed for the rest of the tab's session via sessionStorage so a
 *    reload doesn't re-toast the same problems. The signature combines
 *    every failed check name into a stable key so a NEW failure (different
 *    check) does fire even after a previous one was acknowledged.
 */
const SS_KEY = "preflight:lastFailureSig";

export function usePreflight(): void {
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    fetch("/api/preflight")
      .then((r) => r.json())
      .then(({ checks }: { checks: PreflightCheck[] }) => {
        const failed = checks.filter((c) => !c.passed);
        if (failed.length === 0) return; // pass → silent

        const sig = failed.map((c) => c.name).sort().join("|");
        try {
          if (sessionStorage.getItem(SS_KEY) === sig) return;
          sessionStorage.setItem(SS_KEY, sig);
        } catch {
          // sessionStorage may be blocked (private mode) — fall through
          // and just toast every reload in that case.
        }

        toast.warning(
          `Startup check: ${failed.length} issue${failed.length === 1 ? "" : "s"} found`,
          {
            description: failed.map((c) => c.detail).join(" · "),
            duration: 10_000,
          },
        );
      })
      .catch(() => {
        // Dashboard backend not running — ignore silently
      });
  }, []);
}
