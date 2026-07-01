import { useState } from "react";
import {
  Sparkles,
  ShieldAlert,
  ClipboardCheck,
  MousePointerClick,
  FileText,
  Loader2,
  CircleAlert,
} from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * "AI Assist" settings section — on-demand LLM tools backed by the shared
 * free-tier pool (`/api/ai-assist/*`). Each tool takes a bit of pasted text and
 * returns a structured result; nothing runs automatically and no run state is
 * touched. A rate-limited provider transparently falls through to the next.
 */

type ToolId = "triage" | "sanity" | "selector" | "summarize";

interface ToolMeta {
  id: ToolId;
  label: string;
  icon: typeof Sparkles;
  blurb: string;
}

const TOOLS: ToolMeta[] = [
  { id: "triage", label: "Triage failure", icon: ShieldAlert, blurb: "Explain a cryptic error — category, cause, and a suggested recovery." },
  { id: "sanity", label: "Sanity check", icon: ClipboardCheck, blurb: "Flag implausible / malformed / inconsistent fields in a record before submit." },
  { id: "selector", label: "Suggest selector", icon: MousePointerClick, blurb: "Propose Playwright locators from a page accessibility snapshot." },
  { id: "summarize", label: "Summarize run", icon: FileText, blurb: "Turn a run's log lines into a plain-English digest." },
];

function apiUrl(path: string): string {
  // Backend is same-origin in prod; Vite dev (:5173) proxies /api to :3838.
  if (typeof window !== "undefined" && window.location.port === "5173") {
    return `${window.location.protocol}//${window.location.hostname}:3838${path}`;
  }
  return path;
}

// ── Small shared field primitives (token-compliant) ──────────────────────────

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

const inputClass =
  "w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring";

// ── Result rendering ─────────────────────────────────────────────────────────

interface TriageResult {
  category: string;
  cause: string;
  suggestedRecovery: string;
  retriable: boolean;
  confidence: number;
}
interface SanityIssue {
  field: string;
  severity: "error" | "warning";
  message: string;
  source: "rule" | "llm";
}
interface SelectorCandidate {
  selector: string;
  rationale: string;
  confidence: number;
}
interface RunSummary {
  summary: string;
  outcome: string;
  highlights: string[];
}

function ResultCard({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="rounded-lg border border-border bg-secondary/30 p-4 text-sm" aria-live="polite">
      {children}
    </div>
  );
}

// ── Section ──────────────────────────────────────────────────────────────────

export function AiAssistSection(): React.ReactElement {
  const [tool, setTool] = useState<ToolId>("triage");

  // Per-tool inputs (kept independently so switching tools preserves them).
  const [triageError, setTriageError] = useState("");
  const [triageWorkflow, setTriageWorkflow] = useState("");
  const [triageStep, setTriageStep] = useState("");
  const [triageSystem, setTriageSystem] = useState("");

  const [sanityRecord, setSanityRecord] = useState("");
  const [sanityWorkflow, setSanityWorkflow] = useState("");

  const [selSnapshot, setSelSnapshot] = useState("");
  const [selIntent, setSelIntent] = useState("");
  const [selCurrent, setSelCurrent] = useState("");

  const [sumLog, setSumLog] = useState("");
  const [sumWorkflow, setSumWorkflow] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const [emptyResult, setEmptyResult] = useState(false);

  const active = TOOLS.find((t) => t.id === tool)!;

  async function run(path: string, body: Record<string, unknown>): Promise<void> {
    setLoading(true);
    setError(null);
    setResult(null);
    setEmptyResult(false);
    try {
      const res = await fetch(apiUrl(path), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; result?: unknown };
      if (!res.ok || !data.ok) {
        setError(data.error ?? `Request failed (${res.status})`);
        return;
      }
      if (data.result == null) {
        setEmptyResult(true);
        return;
      }
      setResult(data.result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function submit(): void {
    if (tool === "triage") {
      void run("/api/ai-assist/triage", {
        error: triageError,
        workflow: triageWorkflow || undefined,
        step: triageStep || undefined,
        systemId: triageSystem || undefined,
      });
    } else if (tool === "sanity") {
      let record: unknown;
      try {
        record = JSON.parse(sanityRecord);
      } catch {
        setError("Record must be valid JSON.");
        setResult(null);
        setEmptyResult(false);
        return;
      }
      void run("/api/ai-assist/sanity", { record, workflow: sanityWorkflow || undefined });
    } else if (tool === "selector") {
      void run("/api/ai-assist/selector", {
        snapshot: selSnapshot,
        intent: selIntent,
        current: selCurrent || undefined,
      });
    } else {
      void run("/api/ai-assist/summarize", { logText: sumLog, workflow: sumWorkflow || undefined });
    }
  }

  const canRun =
    tool === "triage" ? triageError.trim().length > 0
    : tool === "sanity" ? sanityRecord.trim().length > 0
    : tool === "selector" ? selSnapshot.trim().length > 0 && selIntent.trim().length > 0
    : sumLog.trim().length > 0;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
          <Sparkles aria-hidden className="h-4 w-4 text-primary" />
          AI Assist
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          On-demand tools backed by the shared free-tier model pool. Paste input and run — nothing fires automatically.
        </p>
      </div>

      {/* Tool picker */}
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="AI assist tools">
        {TOOLS.map((t) => {
          const Icon = t.icon;
          const selected = t.id === tool;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => {
                setTool(t.id);
                setResult(null);
                setError(null);
                setEmptyResult(false);
              }}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selected
                  ? "border-primary/40 bg-primary/12 font-medium text-foreground"
                  : "border-border bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" />
              {t.label}
            </button>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">{active.blurb}</p>

      {/* Per-tool form */}
      <div className="flex flex-col gap-3">
        {tool === "triage" && (
          <>
            <Field id="triage-error" label="Error text">
              <textarea id="triage-error" rows={4} className={inputClass} placeholder="page.goto: Timeout 30000ms exceeded…" value={triageError} onChange={(e) => setTriageError(e.target.value)} />
            </Field>
            <div className="grid grid-cols-3 gap-2">
              <Field id="triage-wf" label="Workflow"><input id="triage-wf" className={inputClass} placeholder="separations" value={triageWorkflow} onChange={(e) => setTriageWorkflow(e.target.value)} /></Field>
              <Field id="triage-step" label="Step"><input id="triage-step" className={inputClass} placeholder="transaction" value={triageStep} onChange={(e) => setTriageStep(e.target.value)} /></Field>
              <Field id="triage-sys" label="System"><input id="triage-sys" className={inputClass} placeholder="ucpath" value={triageSystem} onChange={(e) => setTriageSystem(e.target.value)} /></Field>
            </div>
          </>
        )}
        {tool === "sanity" && (
          <>
            <Field id="sanity-record" label="Record (JSON)">
              <textarea id="sanity-record" rows={6} className={cn(inputClass, "font-mono text-xs")} placeholder={'{"name":"Doe, Jane","workEmail":"jane@ucsd","employeeId":"123"}'} value={sanityRecord} onChange={(e) => setSanityRecord(e.target.value)} />
            </Field>
            <Field id="sanity-wf" label="Workflow"><input id="sanity-wf" className={inputClass} placeholder="onboarding" value={sanityWorkflow} onChange={(e) => setSanityWorkflow(e.target.value)} /></Field>
          </>
        )}
        {tool === "selector" && (
          <>
            <Field id="sel-snapshot" label="Accessibility snapshot">
              <textarea id="sel-snapshot" rows={6} className={cn(inputClass, "font-mono text-xs")} placeholder="- button 'Save' [ref=e12]&#10;- textbox 'Employee ID' [ref=e5]" value={selSnapshot} onChange={(e) => setSelSnapshot(e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field id="sel-intent" label="Target (what to find)"><input id="sel-intent" className={inputClass} placeholder="the Save button" value={selIntent} onChange={(e) => setSelIntent(e.target.value)} /></Field>
              <Field id="sel-current" label="Broken selector (optional)"><input id="sel-current" className={inputClass} placeholder="button.oldSave" value={selCurrent} onChange={(e) => setSelCurrent(e.target.value)} /></Field>
            </div>
          </>
        )}
        {tool === "summarize" && (
          <>
            <Field id="sum-log" label="Run log lines">
              <textarea id="sum-log" rows={6} className={cn(inputClass, "font-mono text-xs")} placeholder="Paste a .tracker/logs/*.jsonl slice for one run…" value={sumLog} onChange={(e) => setSumLog(e.target.value)} />
            </Field>
            <Field id="sum-wf" label="Workflow"><input id="sum-wf" className={inputClass} placeholder="separations" value={sumWorkflow} onChange={(e) => setSumWorkflow(e.target.value)} /></Field>
          </>
        )}

        <div>
          <button
            type="button"
            onClick={submit}
            disabled={loading || !canRun}
            aria-disabled={loading || !canRun}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? <Loader2 aria-hidden className="h-3.5 w-3.5 shrink-0 motion-safe:animate-spin" /> : <Sparkles aria-hidden className="h-3.5 w-3.5 shrink-0" />}
            {loading ? "Running…" : "Run"}
          </button>
        </div>
      </div>

      {/* Result */}
      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/12 p-3 text-sm text-foreground">
          <CircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <span>{error}</span>
        </div>
      )}
      {emptyResult && !error && (
        <ResultCard>
          <span className="text-muted-foreground">No result — the model pool is exhausted, returned an unusable answer, or no provider keys are configured.</span>
        </ResultCard>
      )}
      {result != null && !error && <ToolResult tool={tool} result={result} />}
    </div>
  );
}

function ToolResult({ tool, result }: { tool: ToolId; result: unknown }): React.ReactElement {
  if (tool === "triage") {
    const t = result as TriageResult;
    return (
      <ResultCard>
        <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5">
          <dt className="text-muted-foreground">Category</dt>
          <dd className="text-foreground">{t.category} <span className="text-muted-foreground">({t.retriable ? "retriable" : "not retriable"})</span></dd>
          <dt className="text-muted-foreground">Cause</dt>
          <dd className="text-foreground">{t.cause}</dd>
          <dt className="text-muted-foreground">Recovery</dt>
          <dd className="text-foreground">{t.suggestedRecovery}</dd>
          <dt className="text-muted-foreground">Confidence</dt>
          <dd className="text-foreground">{Math.round(t.confidence * 100)}%</dd>
        </dl>
      </ResultCard>
    );
  }
  if (tool === "sanity") {
    const issues = (result as { issues: SanityIssue[] }).issues;
    if (issues.length === 0) return <ResultCard><span className="text-foreground">✓ No sanity issues found.</span></ResultCard>;
    return (
      <ResultCard>
        <ul className="flex flex-col gap-1.5">
          {issues.map((i, idx) => (
            <li key={idx} className="flex items-start gap-2">
              <span className={cn("shrink-0 font-medium", i.severity === "error" ? "text-destructive" : "text-warning")}>{i.severity === "error" ? "✗" : "⚠"}</span>
              <span className="text-foreground"><span className="font-medium">{i.field}</span> — {i.message} <span className="text-muted-foreground">[{i.source}]</span></span>
            </li>
          ))}
        </ul>
      </ResultCard>
    );
  }
  if (tool === "selector") {
    const candidates = (result as { candidates: SelectorCandidate[] | null }).candidates;
    if (!candidates || candidates.length === 0) return <ResultCard><span className="text-muted-foreground">Nothing in the snapshot plausibly matches. Rephrase the target or re-check the snapshot.</span></ResultCard>;
    return (
      <ResultCard>
        <ol className="flex flex-col gap-2">
          {candidates.map((c, idx) => (
            <li key={idx} className="flex flex-col gap-0.5">
              <code className="font-mono text-xs text-foreground">{c.selector} <span className="text-muted-foreground">({Math.round(c.confidence * 100)}%)</span></code>
              <span className="text-xs text-muted-foreground">{c.rationale}</span>
            </li>
          ))}
        </ol>
      </ResultCard>
    );
  }
  const s = result as RunSummary;
  return (
    <ResultCard>
      <p className="text-foreground"><span className="text-muted-foreground">Outcome:</span> {s.outcome}</p>
      <p className="mt-1.5 text-foreground">{s.summary}</p>
      {s.highlights.length > 0 && (
        <ul className="mt-2 flex list-disc flex-col gap-0.5 pl-5 text-foreground">
          {s.highlights.map((h, idx) => <li key={idx}>{h}</li>)}
        </ul>
      )}
    </ResultCard>
  );
}
