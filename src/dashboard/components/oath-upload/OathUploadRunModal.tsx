import { useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DuplicateBanner } from "./DuplicateBanner";
import type { PriorRunSummary } from "../types";

interface OathUploadRunModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitted?: (sessionId: string) => void;
}

async function sha256OfFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const hashBuf = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function OathUploadRunModal({
  open,
  onOpenChange,
  onSubmitted,
}: OathUploadRunModalProps) {
  const [file, setFile] = useState<File | null>(null);
  const [priors, setPriors] = useState<PriorRunSummary[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFileSelect = async (f: File | null) => {
    setFile(f);
    setPriors([]);
    setError(null);
    if (!f) return;
    try {
      const hash = await sha256OfFile(f);
      const r = await fetch(
        `/api/oath-upload/check-duplicate?hash=${encodeURIComponent(hash)}`,
      );
      const j = (await r.json()) as
        | { ok: true; priorRuns: PriorRunSummary[] }
        | { ok: false; error: string };
      if (j.ok) setPriors(j.priorRuns ?? []);
    } catch (err) {
      setError(
        `Duplicate check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const onSubmit = async () => {
    if (!file) return;
    setSubmitting(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("pdf", file);
      const r = await fetch("/api/oath-upload/start", { method: "POST", body: fd });
      const j = (await r.json()) as
        | { ok: true; sessionId: string }
        | { ok: false; error: string };
      if (!j.ok) throw new Error(j.error ?? "upload failed");
      toast.success(`Oath upload queued — session ${j.sessionId.slice(0, 8)}`);
      onSubmitted?.(j.sessionId);
      onOpenChange(false);
      setFile(null);
      setPriors([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Upload Oath PDF</DialogTitle>
          <DialogDescription>
            Pick a scanned oath PDF. We&apos;ll OCR it, fan out signatures, and file the HR ticket.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <input
            type="file"
            accept="application/pdf"
            onChange={(e) => void onFileSelect(e.target.files?.[0] ?? null)}
            className="block w-full text-sm file:mr-3 file:rounded file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm file:hover:bg-accent"
          />
          {file && (
            <div className="text-xs text-muted-foreground font-mono">
              {file.name} &middot; {(file.size / 1024 / 1024).toFixed(2)} MB
            </div>
          )}
          {priors.length > 0 && <DuplicateBanner priorRuns={priors} />}
          {error && <div className="text-destructive text-sm">{error}</div>}
        </div>
        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded border border-input bg-background px-3 py-1.5 text-sm hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!file || submitting}
            onClick={() => void onSubmit()}
            className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50 hover:bg-primary/90"
          >
            {submitting ? "Uploading…" : "Upload"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
