/**
 * Read-only SYSTEM REFERENCE panels for the Settings page — the "what exists in
 * the system" surface (row archetypes, queue-row kinds, trace-id format, OCR
 * forms/steps, browser-health verdicts, daemon states, and the live workflow
 * index). These are display-only: nothing here edits operator settings, so the
 * sections render no Save/Revert footer.
 *
 * Content comes from `src/domain/settings/reference.ts` (client-safe, drift-
 * protected against the real domain unions) plus the live `/api/workflow-
 * definitions` registry via `useWorkflows()` for the workflow index.
 */
import type { ComponentType } from "react";
import { BookOpen, Keyboard, Layers, Network } from "lucide-react";

import { useWorkflows } from "@/lib/workflows-context";
import { ShortcutList } from "@/components/shared/ShortcutList";
import {
  BROWSER_HEALTH_VERDICTS,
  DAEMON_HEALTH_BUCKETS,
  DAEMON_PHASES,
  IDLE_REFRESH_SYSTEM_IDS,
  INPUT_SUBJECTS,
  KEYBOARD_SHORTCUTS,
  LEGACY_ARCHETYPE_ALIASES,
  LOGIN_URL_FRAGMENTS,
  OCR_FORM_SPECS,
  OCR_STEPS_LIVE,
  OCR_STEPS_RETIRED,
  QUEUE_ROW_KINDS,
  QUEUE_STATUSES,
  ROW_ARCHETYPES,
  TRACE_ID_FORMAT,
  TRACE_ID_PARTS,
  WORKFLOW_ARCHETYPES,
  type ReferenceItem,
} from "../../../domain/settings/reference.js";

type RefSectionId = "ref-rows" | "ref-workflows" | "ref-system" | "ref-shortcuts";

// ── Primitives ──────────────────────────────────────────────────────────────

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <header className="mb-4">
        <h3 className="text-[13.5px] font-semibold tracking-tight text-foreground">{title}</h3>
        {subtitle && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{subtitle}</p>}
      </header>
      {children}
    </section>
  );
}

function SectionHead({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
  title: string;
  subtitle: string;
}): JSX.Element {
  return (
    <div className="flex items-start gap-3.5">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-accent text-foreground">
        <Icon aria-hidden className="h-5 w-5" />
      </div>
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-foreground">{title}</h2>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  );
}

/** A definition list of reference items: mono value (+ optional tag) → label + description. */
function RefList({ items }: { items: ReferenceItem[] }): JSX.Element {
  return (
    <dl className="flex flex-col divide-y divide-border/60">
      {items.map((item, i) => (
        <div key={item.value + i} className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 py-2.5 first:pt-0 last:pb-0">
          <dt className="flex flex-col items-start gap-1">
            <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11.5px] text-foreground">
              {item.value}
            </code>
            {item.tag && (
              <span className="rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {item.tag}
              </span>
            )}
          </dt>
          <dd className="min-w-0">
            <p className="text-[13px] font-medium text-foreground">{item.label}</p>
            {item.description && (
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{item.description}</p>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A wrapping list of mono chips (for flat value sets — login patterns, idle systems). */
function ChipList({ values }: { values: readonly string[] }): JSX.Element {
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((v) => (
        <code key={v} className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11.5px] text-foreground">
          {v}
        </code>
      ))}
    </div>
  );
}

// ── Workflow index (live from /api/workflow-definitions) ──────────────────────

function WorkflowIndex(): JSX.Element {
  const workflows = useWorkflows();
  const sorted = [...workflows].sort((a, b) => (a.category ?? "~").localeCompare(b.category ?? "~") || a.label.localeCompare(b.label));
  const th = "px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";
  const td = "px-3 py-2 align-top text-[12.5px] text-foreground";
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">Registered workflows with their trace code, category, archetype, systems, and step count.</caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className={th}>Code</th>
            <th scope="col" className={th}>Workflow</th>
            <th scope="col" className={th}>Category</th>
            <th scope="col" className={th}>Shape</th>
            <th scope="col" className={th}>Systems</th>
            <th scope="col" className={th}>Steps</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((w) => (
            <tr key={w.name} className="border-b border-border/50">
              <td className={td}>
                <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11.5px]">{w.code ?? "—"}</code>
              </td>
              <td className={`${td} font-medium`}>{w.label}</td>
              <td className={`${td} text-muted-foreground`}>{w.category ?? "—"}</td>
              <td className={`${td} text-muted-foreground`}>{w.archetype ?? "—"}</td>
              <td className={`${td} text-muted-foreground`}>{w.systems.length ? w.systems.join(", ") : "—"}</td>
              <td className={`${td} text-muted-foreground`}>{w.steps.length}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Panels ────────────────────────────────────────────────────────────────────

function RowsAndQueuePanel(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SectionHead
        icon={Layers}
        title="Row & queue model"
        subtitle="The orthogonal axes every queue row carries — shape, kind, status — plus the trace-id format. Read-only reference."
      />
      <Card title="Row archetypes — shape" subtitle="Stamped on every row as data.archetype.">
        <RefList items={ROW_ARCHETYPES} />
      </Card>
      <Card title="Workflow archetypes" subtitle="Declared on defineWorkflow; the kernel derives the row archetype from this + parentRunId.">
        <RefList items={WORKFLOW_ARCHETYPES} />
      </Card>
      <Card title="Legacy archetype aliases" subtitle="Old JSONL stamps still normalized on read.">
        <RefList items={LEGACY_ARCHETYPE_ALIASES} />
      </Card>
      <Card title="Queue-row kinds — title/subtitle" subtitle="data.queueRowKind. Drives ONLY the row title + subtitle.">
        <RefList items={QUEUE_ROW_KINDS} />
      </Card>
      <Card title="Input subjects → kind" subtitle="Declared as inputSubject; the kernel funnels it onto a queue-row kind.">
        <RefList items={INPUT_SUBJECTS} />
      </Card>
      <Card title="Statuses" subtitle="The 5 universal tracker statuses, the cancelled override, and the per-workflow derived statuses.">
        <RefList items={QUEUE_STATUSES} />
      </Card>
      <Card title="Trace id" subtitle={`Format: ${TRACE_ID_FORMAT} — frozen once at pre-emit, on every row.`}>
        <RefList items={TRACE_ID_PARTS} />
      </Card>
    </div>
  );
}

function WorkflowsPanel(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SectionHead
        icon={BookOpen}
        title="Workflows & OCR"
        subtitle="The registered workflows (live from the kernel registry) and the OCR form/step model. Read-only reference."
      />
      <Card title="Workflow index" subtitle="Every registered workflow with its trace code, category, archetype, systems, and step count.">
        <WorkflowIndex />
      </Card>
      <Card title="OCR form specs" subtitle="The registered OCR form types and what each one's approval fans out to.">
        <RefList items={OCR_FORM_SPECS} />
      </Card>
      <Card title="OCR steps — live" subtitle="Pipeline phases the OCR orchestrator emits today (in order).">
        <RefList items={OCR_STEPS_LIVE} />
      </Card>
      <Card title="OCR steps — retired" subtitle="Legacy sub-phases folded onto a live step for display.">
        <RefList items={OCR_STEPS_RETIRED} />
      </Card>
    </div>
  );
}

function SystemPanel(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SectionHead
        icon={Network}
        title="System reference"
        subtitle="Per-browser health verdicts and recovery ladder, daemon states, and idle-refresh systems. Read-only reference."
      />
      <Card title="Browser health verdicts" subtitle="What the health monitor classifies a browser as, and how it recovers each (the tag).">
        <RefList items={BROWSER_HEALTH_VERDICTS} />
      </Card>
      <Card title="Session-expiry URL fragments" subtitle="A page whose URL contains one of these is treated as on an SSO/login surface (session expired → re-auth).">
        <ChipList values={LOGIN_URL_FRAGMENTS} />
      </Card>
      <Card title="Daemon phases" subtitle="The lifecycle phase a daemon reports via daemon_phase events.">
        <RefList items={DAEMON_PHASES} />
      </Card>
      <Card title="Daemon health buckets" subtitle="How the terminal-drawer rolls up daemons across sessions.">
        <RefList items={DAEMON_HEALTH_BUCKETS} />
      </Card>
      <Card title="Idle-refresh systems" subtitle="Systems whose long-lived sessions are kept warm by periodic page reloads.">
        {IDLE_REFRESH_SYSTEM_IDS.length ? (
          <ChipList values={IDLE_REFRESH_SYSTEM_IDS} />
        ) : (
          <p className="text-sm text-muted-foreground">None.</p>
        )}
      </Card>
    </div>
  );
}

function KeyboardShortcutsPanel(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SectionHead
        icon={Keyboard}
        title="Keyboard shortcuts"
        subtitle="Global dashboard shortcuts for queue navigation, workflow switching, and the session drawer. Read-only reference."
      />
      <Card title="Shortcuts" subtitle="Press ? anywhere on the dashboard to toggle the shortcuts guide.">
        <ShortcutList shortcuts={KEYBOARD_SHORTCUTS} />
      </Card>
    </div>
  );
}

export function ReferencePanel({ section }: { section: RefSectionId }): JSX.Element {
  if (section === "ref-rows") return <RowsAndQueuePanel />;
  if (section === "ref-workflows") return <WorkflowsPanel />;
  if (section === "ref-shortcuts") return <KeyboardShortcutsPanel />;
  return <SystemPanel />;
}
