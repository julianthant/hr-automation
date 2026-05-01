import { useState } from "react";
import { Loader2, AlertCircle, RefreshCw, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { FailedPage } from "./types";

export interface FailedPageCardProps {
  failedPage: FailedPage;
  totalPages: number;
  sessionId: string;
  runId: string;
  onRetryComplete?: () => void;
}

const PROVIDER_LABELS: Record<string, string> = {
  gemini: "Gemini",
  mistral: "Mistral",
  groq: "Groq",
  sambanova: "Sambanova",
};

function providerFamily(keyId: string): string {
  const dash = keyId.indexOf("-");
  return dash >= 0 ? keyId.slice(0, dash) : keyId;
}

export function FailedPageCard({ failedPage, totalPages, sessionId, runId, onRetryComplete }: FailedPageCardProps) {
  const [retrying, setRetrying] = useState(false);
  const [skipped, setSkipped] = useState(false);

  async function handleRetry() {
    if (retrying) return;
    setRetrying(true);
    try {
      const r = await fetch("/api/ocr/retry-page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, runId, pageNum: failedPage.page }),
      });
      const body = await r.json() as { ok: boolean; recordsAdded?: number; stillFailed?: boolean; error?: string };
      if (!r.ok || !body.ok) {
        toast.error(`Page ${failedPage.page} retry failed`, { description: body.error ?? `HTTP ${r.status}` });
      } else if (body.stillFailed) {
        toast.warning(`Page ${failedPage.page} retry still failed`, { description: body.error ?? "All providers exhausted" });
      } else {
        toast.success(`Page ${failedPage.page} OCR succeeded`, {
          description: `${body.recordsAdded} record${body.recordsAdded === 1 ? "" : "s"} added`,
        });
        onRetryComplete?.();
      }
    } catch (err) {
      toast.error(`Page ${failedPage.page} retry failed`, {
        description: err instanceof Error ? err.message : "Network error",
      });
    } finally {
      setRetrying(false);
    }
  }

  const triedFamilies = Array.from(new Set(failedPage.attemptedKeys.map(providerFamily)));

  return (
    <div className={cn(
      "mx-4 my-3 rounded-md border bg-card p-4",
      skipped ? "border-border/40 opacity-50" : "border-destructive/40",
    )}>
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold">
              Page {failedPage.page} of {totalPages} in pile · OCR failed
            </span>
            <span className="font-mono text-[10px] text-muted-foreground">
              Tried {failedPage.attempts}×
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{failedPage.error}</p>
          {triedFamilies.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {triedFamilies.map((family) => (
                <span
                  key={family}
                  className="rounded-md border border-border bg-secondary px-1.5 py-px font-mono text-[10px] uppercase text-muted-foreground"
                >
                  {PROVIDER_LABELS[family] ?? family}
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={handleRetry}
              disabled={retrying || skipped}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-md border border-primary bg-primary px-3 text-xs font-semibold text-primary-foreground",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              {retrying ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              {retrying ? "Retrying…" : "Retry page"}
            </button>
            <button
              type="button"
              onClick={() => setSkipped((s) => !s)}
              disabled={retrying}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <EyeOff className="h-3 w-3" />
              {skipped ? "Unskip" : "Skip page"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
