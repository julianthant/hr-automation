import { useEffect, useRef } from "react";
import { toast } from "sonner";

interface PreflightCheck {
  name: string;
  passed: boolean;
  detail: string;
}

/** Fetch /api/preflight on mount and show a toast with results. */
export function usePreflight(): void {
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    fetch("/api/preflight")
      .then((r) => r.json())
      .then(({ checks }: { checks: PreflightCheck[] }) => {
        const allPassed = checks.every((c) => c.passed);
        const desc = checks.map((c) => `${c.passed ? "\u2713" : "\u2717"} ${c.detail}`).join(" \u00b7 ");
        if (allPassed) {
          toast.info("Pre-flight checks passed", { description: desc, duration: 5000 });
        } else {
          toast.warning("Pre-flight issues", { description: desc, duration: 8000 });
        }
      })
      .catch(() => {
        // Dashboard backend not running — ignore silently
      });
  }, []);
}
