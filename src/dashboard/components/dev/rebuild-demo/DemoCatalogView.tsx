import { useMemo } from "react";
import { ArrowRight, Layers, LayoutList, Link2, PanelRight, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";
import { CONTAINMENT_KINDS, DENSITY_LADDER, PANEL_KINDS, ROLLUP_STEPS, ROW_VARIANTS, type RowVariantSpec } from "./demo-catalog";
import { DEMO_ROWS } from "./demo-data";

/**
 * DEV-ONLY — the catalog view of `?view=rebuild-demo`.
 *
 * The ratified model gives us three row types and one Log Panel. That is the
 * right structure but the wrong vocabulary to plan with: it cannot answer
 * "what does an oath packet look like versus a 50-person I-9 roster", and it
 * cannot tell you which tabs you get. This view is the missing layer — every
 * named row variant and Log Panel kind, what makes it different, which
 * workflows use it, and a jump straight to a live example in the demo.
 */

const TYPE_TONE: Record<RowVariantSpec["rowType"], string> = {
  "Run Row": "border-info/40 bg-info/10 text-info",
  "Group Row": "border-log-violet/40 bg-log-violet/10 text-log-violet",
  "Member Row": "border-log-teal/40 bg-log-teal/10 text-log-teal",
};

function SectionHead({ icon: Icon, title, blurb }: { icon: typeof LayoutList; title: string; blurb: string }) {
  return (
    <div className="mb-3 flex items-start gap-2.5">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-secondary/40">
        <Icon aria-hidden className="size-3.5 text-muted-foreground" />
      </span>
      <div className="min-w-0">
        <h2 className="text-[14px] font-semibold text-foreground">{title}</h2>
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">{blurb}</p>
      </div>
    </div>
  );
}

export function DemoCatalogView({ onOpenExample }: { onOpenExample: (id: string) => void }) {
  // invert the variant→workflows mapping so the operator can also read it
  // the way they think about it: "what do MY workflows produce?"
  const byWorkflow = useMemo(() => {
    const map = new Map<string, { code: string; label: string; uses: { variant: string; note: string }[] }>();
    for (const v of ROW_VARIANTS) {
      for (const w of v.workflows) {
        const entry = map.get(w.code) ?? { code: w.code, label: w.label, uses: [] };
        entry.uses.push({ variant: v.name, note: w.note });
        map.set(w.code, entry);
      }
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, []);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-5 py-5">
        {/* ---- row variants ---- */}
        <section>
          <SectionHead
            icon={LayoutList}
            title="Queue Rows — 8 named variants over the 3 ratified types"
            blurb="The row TYPE is structural (Run / Group / Member). The variant is what it is about, and it decides the title rule, what the row body carries, and which Log Panel you land in."
          />
          <div className="grid gap-2.5 min-[1100px]:grid-cols-2">
            {ROW_VARIANTS.map((v) => (
              <article key={v.key} className="flex flex-col rounded-lg border border-border bg-card p-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-[13px] font-semibold text-foreground">{v.name}</h3>
                  <span className={cn("rounded border px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wider", TYPE_TONE[v.rowType])}>
                    {v.rowType}
                  </span>
                  {v.exampleId && (
                    <button
                      type="button"
                      onClick={() => onOpenExample(v.exampleId as string)}
                      className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-primary/45 bg-primary/12 px-2 py-0.5 text-[10.5px] font-semibold text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      See {DEMO_ROWS[v.exampleId]?.title.slice(0, 22) ?? "example"}
                      <ArrowRight aria-hidden className="size-3" />
                    </button>
                  )}
                </div>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-secondary-foreground">{v.subject}</p>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{v.titleRule}</p>

                <ul className="mt-2 flex flex-col gap-0.5">
                  {v.carries.map((c) => (
                    <li key={c} className="flex gap-1.5 text-[11px] text-muted-foreground">
                      <span aria-hidden className="mt-[6px] size-1 shrink-0 rounded-full bg-muted-foreground/60" />
                      <span className="min-w-0">{c}</span>
                    </li>
                  ))}
                </ul>

                <p className="mt-2 rounded-md border border-warning/30 bg-warning/6 px-2.5 py-1.5 text-[11px] leading-relaxed text-warning">
                  {v.gotcha}
                </p>

                <div className="mt-2 flex flex-wrap gap-1">
                  {v.workflows.map((w) => (
                    <span
                      key={w.code}
                      title={w.note}
                      className="inline-flex items-center gap-1 rounded border border-border bg-secondary/40 px-1.5 py-px text-[10px] text-secondary-foreground"
                    >
                      <span className="font-mono text-muted-foreground">{w.code}</span>
                      {w.label}
                    </span>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </section>

        {/* ---- containment ---- */}
        <section>
          <SectionHead
            icon={Link2}
            title="Containment — the one field that decides where a child lives"
            blurb="Not every child of a row is a member. Getting this wrong is what makes the same run appear in two panels and the badges disagree with the rows."
          />
          <div className="grid gap-2.5 min-[1100px]:grid-cols-3">
            {CONTAINMENT_KINDS.map((c) => (
              <article key={c.key} className="flex flex-col rounded-lg border border-border bg-card p-3">
                <div className="flex items-baseline gap-2">
                  <h3 className="text-[13px] font-semibold text-foreground">{c.name}</h3>
                  <span className="font-mono text-[10px] text-muted-foreground">{c.key}</span>
                </div>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-secondary-foreground">{c.rule}</p>
                <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  <span className="text-secondary-foreground">Lives:</span> {c.lives}
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  <span className="text-secondary-foreground">Counts:</span> {c.counts}
                </p>
                <ul className="mt-2 flex flex-col gap-0.5">
                  {c.examples.map((e) => (
                    <li key={e} className="flex gap-1.5 text-[11px] text-muted-foreground">
                      <span aria-hidden className="mt-[6px] size-1 shrink-0 rounded-full bg-muted-foreground/60" />
                      <span className="min-w-0">{e}</span>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </section>

        {/* ---- rollup + density ---- */}
        <section>
          <SectionHead
            icon={Layers}
            title="Rollup precedence and the density ladder"
            blurb="A group's status is never authored — it is rolled up from its members through one shared function. Its shape is never a new row type — it is a rung on a ladder driven by member count."
          />
          <div className="rounded-lg border border-border bg-card p-3">
            <div className="text-[11.5px] font-semibold text-foreground">Rollup precedence</div>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
              First match wins. A rejected member is excluded entirely — but an otherwise-verified group holding one drops to Done with warnings, so a
              packet with an unreadable page can never read as clean.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1">
              {ROLLUP_STEPS.map((s, i) => (
                <span key={s} className="inline-flex items-center gap-1">
                  {i > 0 && <ArrowRight aria-hidden className="size-3 text-muted-foreground/60" />}
                  <span className="rounded-md border border-border bg-secondary/40 px-2 py-0.5 text-[11px] text-secondary-foreground">{s}</span>
                </span>
              ))}
            </div>
          </div>
          <div className="mt-2.5 grid gap-2.5 min-[1100px]:grid-cols-2">
            {DENSITY_LADDER.map((d) => (
              <article key={d.key} className="flex flex-col rounded-lg border border-border bg-card p-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-[13px] font-semibold text-foreground">{d.range}</h3>
                  <button
                    type="button"
                    onClick={() => onOpenExample(d.exampleId)}
                    className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-primary/45 bg-primary/12 px-2 py-0.5 text-[10.5px] font-semibold text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    See {DEMO_ROWS[d.exampleId]?.title.slice(0, 22) ?? "example"}
                    <ArrowRight aria-hidden className="size-3" />
                  </button>
                </div>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">{d.what}</p>
              </article>
            ))}
          </div>
        </section>

        {/* ---- panel kinds ---- */}
        <section>
          <SectionHead
            icon={PanelRight}
            title="Log Panels — 4 kinds, tabs derived not fixed"
            blurb="One Log Panel surface, but the tab set comes from the row you selected. Screenshots is not a tab — evidence is a bar above the tabs. Review exists only where records exist."
          />
          <div className="grid gap-2.5 min-[1100px]:grid-cols-2">
            {PANEL_KINDS.map((p) => (
              <article key={p.key} className="flex flex-col rounded-lg border border-border bg-card p-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-[13px] font-semibold text-foreground">{p.name}</h3>
                  {p.exampleId && (
                    <button
                      type="button"
                      onClick={() => onOpenExample(p.exampleId as string)}
                      className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-primary/45 bg-primary/12 px-2 py-0.5 text-[10.5px] font-semibold text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      Open it
                      <ArrowRight aria-hidden className="size-3" />
                    </button>
                  )}
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">{p.forRows}</p>

                <div className="mt-2 flex flex-wrap items-center gap-1">
                  {p.tabs.map((t, i) => (
                    <span
                      key={t}
                      className={cn(
                        "rounded-md px-2 py-0.5 text-[11px]",
                        i === 0 ? "bg-accent font-semibold text-foreground" : "border border-border text-muted-foreground",
                      )}
                    >
                      {t}
                    </span>
                  ))}
                </div>
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  <span className="text-secondary-foreground">Opens on:</span> {p.defaultTab}
                </p>

                <span className="mt-2 text-[10px] uppercase tracking-wider text-muted-foreground">Always visible</span>
                <ul className="mt-0.5 flex flex-col gap-0.5">
                  {p.pinned.map((c) => (
                    <li key={c} className="flex gap-1.5 text-[11px] text-muted-foreground">
                      <span aria-hidden className="mt-[6px] size-1 shrink-0 rounded-full bg-info/60" />
                      <span className="min-w-0">{c}</span>
                    </li>
                  ))}
                </ul>

                <span className="mt-2 text-[10px] uppercase tracking-wider text-muted-foreground">Specifics</span>
                <ul className="mt-0.5 flex flex-col gap-0.5">
                  {p.specifics.map((c) => (
                    <li key={c} className="flex gap-1.5 text-[11px] text-secondary-foreground">
                      <span aria-hidden className="mt-[6px] size-1 shrink-0 rounded-full bg-muted-foreground/60" />
                      <span className="min-w-0">{c}</span>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </section>

        {/* ---- workflow map ---- */}
        <section>
          <SectionHead
            icon={Workflow}
            title="Every workflow, and the rows it produces"
            blurb="The same table read the other way — pick your workflow, see which row variants it puts in the queue and what is specific about each."
          />
          <div className="overflow-hidden rounded-lg border border-border">
            {byWorkflow.map((w, i) => (
              <div key={w.code} className={cn("flex gap-3 px-3 py-2", i > 0 && "border-t border-border/60")}>
                <span className="flex w-40 shrink-0 items-baseline gap-1.5">
                  <span className="font-mono text-[10.5px] text-muted-foreground">{w.code}</span>
                  <span className="text-[12.5px] font-medium text-foreground">{w.label}</span>
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  {w.uses.map((u) => (
                    <div key={u.variant} className="flex min-w-0 gap-2 text-[11.5px]">
                      <span className="w-40 shrink-0 text-secondary-foreground">{u.variant}</span>
                      <span className="min-w-0 flex-1 text-muted-foreground">{u.note}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
