import { useMemo, type ReactNode } from "react";
import { ArrowRight, Layers, LayoutList, Link2, PanelRight, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";
import { CONTAINMENT_KINDS, DENSITY_LADDER, PANEL_KINDS, ROLLUP_STEPS, ROW_VARIANTS, type RowVariantSpec } from "./demo-catalog";
import { DEMO_ROWS } from "./demo-data";
import { Button, CardBase, dsBorder, dsIcon, dsRadius, dsSurface, dsText } from "./demo-ui";

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

/**
 * Three row types, one treatment. These chips used to be three hues (info /
 * violet / teal) for three CATEGORIES — and a category is exactly what a hue
 * must not be spent on here, because the same screen uses hue for status. The
 * chip already carries the type's name; weight is all the separation it needs.
 */
const TYPE_TONE: Record<RowVariantSpec["rowType"], string> = {
  "Run Row": "border-[color:var(--ds-border-loud)] bg-[var(--ds-surface-2)] text-[color:var(--ds-fg)]",
  "Group Row": "border-[color:var(--ds-border)] bg-[var(--ds-surface-2)] text-[color:var(--ds-fg-secondary)]",
  "Member Row": "border-[color:var(--ds-border-subtle)] bg-[var(--ds-surface-2)] text-[color:var(--ds-fg-muted)]",
};

/**
 * One specimen card — every section builds the same object.
 *
 * It is a flex COLUMN because the cards sit in grids and stretch to their row's
 * tallest sibling; whatever must land on the row's bottom edge goes in a
 * `CardBase` inside it. Without that, a specimen whose prose ran a line longer
 * than its neighbour's pushed its own trailing block a line lower, and a page
 * whose whole job is to be compared across cannot be read across.
 */
const specimenCard = cn("flex flex-col border p-[var(--ds-space-cozy)]", dsRadius.lg, dsBorder.base, dsSurface.card);

/**
 * `Lives` and `Counts` are the two facts an operator reads STRAIGHT ACROSS the
 * three containment kinds — "where does this child render" against "does it
 * count". They were two prose paragraphs with the label inlined and a different
 * `mt-*` on each, so neither the labels nor the values lined up with anything.
 * One row shape, one label column, so the pair reads as a matched pair.
 */
function FactRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={cn(dsText.meta, "flex min-w-0 gap-[var(--ds-space-base)] leading-relaxed")}>
      <span className="w-11 shrink-0 text-[color:var(--ds-fg-secondary)]">{label}</span>
      <span className="min-w-0 flex-1 text-[color:var(--ds-fg-muted)]">{children}</span>
    </div>
  );
}

/** the neutral fact chip this page uses everywhere a code or a step is named */
const catalogChip = cn(
  "inline-flex items-center border",
  "h-[var(--ds-h-xs)] gap-[var(--ds-space-tight)] px-[var(--ds-space-snug)]",
  dsRadius.sm,
  dsText.micro,
  "border-[color:var(--ds-border)] bg-[var(--ds-surface-2)] text-[color:var(--ds-fg-secondary)]",
);

/** the bullet a spec list hangs on — 6px down so it sits on the x-height */
const specBullet = "mt-[var(--ds-space-snug)] size-1 shrink-0 rounded-full";

function SectionHead({ icon: Icon, title, blurb }: { icon: typeof LayoutList; title: string; blurb: string }) {
  return (
    <div className="mb-[var(--ds-space-cozy)] flex items-start gap-[var(--ds-space-cozy)]">
      <span
        className={cn(
          "mt-px flex size-7 shrink-0 items-center justify-center border",
          dsRadius.md,
          dsBorder.base,
          "bg-[var(--ds-surface-2)]",
        )}
      >
        <Icon aria-hidden className={cn(dsIcon.md, "text-[color:var(--ds-fg-muted)]")} />
      </span>
      <div className="min-w-0">
        <h2 className={cn(dsText.section, "font-semibold text-[color:var(--ds-fg)]")}>{title}</h2>
        <p className={cn(dsText.body, "leading-relaxed text-[color:var(--ds-fg-muted)]")}>{blurb}</p>
      </div>
    </div>
  );
}

/** the "See <a live row> →" jump. It was three copies of one button. */
function ExampleButton({ id, label, onOpen }: { id: string; label?: string; onOpen: (id: string) => void }) {
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={() => onOpen(id)}
      className="ml-auto"
      iconAfter={<ArrowRight aria-hidden className={dsIcon.sm} />}
    >
      {label ?? `See ${DEMO_ROWS[id]?.title.slice(0, 22) ?? "example"}`}
    </Button>
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
      <div className="mx-auto flex max-w-6xl flex-col gap-[var(--ds-space-page)] px-[var(--ds-space-section)] py-[var(--ds-space-section)]">
        {/* ---- row variants ---- */}
        <section>
          <SectionHead
            icon={LayoutList}
            title="Queue Rows — 8 named variants over the 3 ratified types"
            blurb="The row TYPE is structural (Run / Group / Member). The variant is what it is about, and it decides the title rule, what the row body carries, and which Log Panel you land in."
          />
          <div className="grid gap-[var(--ds-space-cozy)] min-[1100px]:grid-cols-2">
            {ROW_VARIANTS.map((v) => (
              <article key={v.key} className={specimenCard}>
                <div className="flex items-center gap-[var(--ds-space-base)]">
                  <h3 className={cn(dsText.title, "font-semibold text-[color:var(--ds-fg)]")}>{v.name}</h3>
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center border px-[var(--ds-space-snug)]",
                      "h-[var(--ds-h-xs)]",
                      dsRadius.sm,
                      dsText.caps,
                      TYPE_TONE[v.rowType],
                    )}
                  >
                    {v.rowType}
                  </span>
                  {v.exampleId && <ExampleButton id={v.exampleId} onOpen={onOpenExample} />}
                </div>
                <p className={cn(dsText.body, "mt-[var(--ds-space-snug)] leading-relaxed text-[color:var(--ds-fg-secondary)]")}>{v.subject}</p>
                <p className={cn(dsText.meta, "mt-[var(--ds-space-tight)] leading-relaxed text-[color:var(--ds-fg-muted)]")}>{v.titleRule}</p>

                <ul className="mt-[var(--ds-space-base)] flex flex-col gap-[var(--ds-space-hair)]">
                  {v.carries.map((c) => (
                    <li key={c} className={cn(dsText.meta, "flex gap-[var(--ds-space-snug)] text-[color:var(--ds-fg-muted)]")}>
                      <span aria-hidden className={cn(specBullet, "bg-[var(--ds-fg-faint)]")} />
                      <span className="min-w-0">{c}</span>
                    </li>
                  ))}
                </ul>

                {/* The gotcha and the workflows that hit it are ONE trailing
                    block on the card's bottom edge: they are the two things
                    read across the pair of cards, and the `carries` list above
                    them is a different length in every variant. */}
                <CardBase className="gap-[var(--ds-space-base)] pt-[var(--ds-space-base)]">
                  <p
                    className={cn(
                      dsText.meta,
                      "border px-[var(--ds-space-base)] py-[var(--ds-space-snug)] leading-relaxed",
                      dsRadius.md,
                      "border-[color:var(--ds-status-waiting-border)] bg-[var(--ds-status-waiting-bg)] text-[color:var(--ds-status-waiting-fg)]",
                    )}
                  >
                    {v.gotcha}
                  </p>

                  <div className="flex flex-wrap gap-[var(--ds-space-tight)]">
                    {v.workflows.map((w) => (
                      <span key={w.code} title={w.note} className={catalogChip}>
                        <span className={cn(dsText.nums, "text-[color:var(--ds-fg-muted)]")}>{w.code}</span>
                        {w.label}
                      </span>
                    ))}
                  </div>
                </CardBase>
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
          <div className="grid gap-[var(--ds-space-cozy)] min-[1100px]:grid-cols-3">
            {CONTAINMENT_KINDS.map((c) => (
              <article key={c.key} className={specimenCard}>
                <div className="flex items-baseline gap-[var(--ds-space-base)]">
                  <h3 className={cn(dsText.title, "font-semibold text-[color:var(--ds-fg)]")}>{c.name}</h3>
                  <span className={cn(dsText.micro, dsText.nums, "text-[color:var(--ds-fg-muted)]")}>{c.key}</span>
                </div>
                <p className={cn(dsText.body, "mt-[var(--ds-space-snug)] leading-relaxed text-[color:var(--ds-fg-secondary)]")}>{c.rule}</p>
                {/* The comparable pair, kept directly under the rule rather
                    than pushed to the base: the three `rule` paragraphs differ
                    by at most one line, so this is where the two facts land
                    closest to level across the three cards. Pinning them to the
                    bottom instead would hang them off `examples` lists of three,
                    two and two items — a much larger drift. */}
                <div className="mt-[var(--ds-space-snug)] flex flex-col gap-[var(--ds-space-tight)]">
                  <FactRow label="Lives">{c.lives}</FactRow>
                  <FactRow label="Counts">{c.counts}</FactRow>
                </div>
                {/* Examples are the trailing block, so the three cards end on
                    one line however many each kind has. */}
                <CardBase className="pt-[var(--ds-space-base)]">
                  <ul className="flex flex-col gap-[var(--ds-space-hair)]">
                    {c.examples.map((e) => (
                      <li key={e} className={cn(dsText.meta, "flex gap-[var(--ds-space-snug)] text-[color:var(--ds-fg-muted)]")}>
                        <span aria-hidden className={cn(specBullet, "bg-[var(--ds-fg-faint)]")} />
                        <span className="min-w-0">{e}</span>
                      </li>
                    ))}
                  </ul>
                </CardBase>
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
          <div className={specimenCard}>
            <div className={cn(dsText.ui, "font-semibold text-[color:var(--ds-fg)]")}>Rollup precedence</div>
            <p className={cn(dsText.meta, "mt-[var(--ds-space-tight)] leading-relaxed text-[color:var(--ds-fg-muted)]")}>
              First match wins. A rejected member is excluded entirely — but an otherwise-verified group holding one drops to Done with warnings, so a
              packet with an unreadable page can never read as clean.
            </p>
            <div className="mt-[var(--ds-space-base)] flex flex-wrap items-center gap-[var(--ds-space-tight)]">
              {ROLLUP_STEPS.map((s, i) => (
                <span key={s} className="inline-flex items-center gap-[var(--ds-space-tight)]">
                  {i > 0 && <ArrowRight aria-hidden className={cn(dsIcon.sm, "text-[color:var(--ds-fg-faint)]")} />}
                  <span className={catalogChip}>{s}</span>
                </span>
              ))}
            </div>
          </div>
          <div className="mt-[var(--ds-space-cozy)] grid gap-[var(--ds-space-cozy)] min-[1100px]:grid-cols-2">
            {DENSITY_LADDER.map((d) => (
              <article key={d.key} className={specimenCard}>
                <div className="flex items-center gap-[var(--ds-space-base)]">
                  <h3 className={cn(dsText.title, "font-semibold text-[color:var(--ds-fg)]")}>{d.range}</h3>
                  <ExampleButton id={d.exampleId} onOpen={onOpenExample} />
                </div>
                <p className={cn(dsText.body, "mt-[var(--ds-space-snug)] leading-relaxed text-[color:var(--ds-fg-muted)]")}>{d.what}</p>
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
              <article key={p.key} className={specimenCard}>
                <div className="flex items-center gap-[var(--ds-space-base)]">
                  <h3 className={cn(dsText.title, "font-semibold text-[color:var(--ds-fg)]")}>{p.name}</h3>
                  {p.exampleId && <ExampleButton id={p.exampleId} label="Open it" onOpen={onOpenExample} />}
                </div>
                <p className={cn(dsText.meta, "mt-[var(--ds-space-tight)] text-[color:var(--ds-fg-muted)]")}>{p.forRows}</p>

                {/* The SAME tab treatment the real panel uses — an underline on
                    the default tab, not a filled pill. A specimen that shows a
                    control the product does not have teaches the wrong thing. */}
                <div className={cn("mt-[var(--ds-space-base)] flex flex-wrap items-center border-b", dsBorder.subtle)}>
                  {p.tabs.map((t, i) => (
                    <span
                      key={t}
                      className={cn(
                        "-mb-px inline-flex items-center border-b-2 border-transparent px-[var(--ds-space-base)] py-[var(--ds-space-tight)]",
                        dsText.meta,
                        i === 0
                          ? "border-b-[color:var(--ds-accent)] font-semibold text-[color:var(--ds-fg)]"
                          : "text-[color:var(--ds-fg-muted)]",
                      )}
                    >
                      {t}
                    </span>
                  ))}
                </div>
                <p className={cn(dsText.meta, "mt-[var(--ds-space-snug)] text-[color:var(--ds-fg-muted)]")}>
                  <span className="text-[color:var(--ds-fg-secondary)]">Opens on:</span> {p.defaultTab}
                </p>

                <span className={cn(dsText.caps, "mt-[var(--ds-space-cozy)] text-[color:var(--ds-fg-muted)]")}>Always visible</span>
                <ul className="mt-[var(--ds-space-tight)] flex flex-col gap-[var(--ds-space-hair)]">
                  {p.pinned.map((c) => (
                    <li key={c} className={cn(dsText.meta, "flex gap-[var(--ds-space-snug)] text-[color:var(--ds-fg-muted)]")}>
                      <span aria-hidden className={cn(specBullet, "bg-[var(--ds-info-fg)] opacity-60")} />
                      <span className="min-w-0">{c}</span>
                    </li>
                  ))}
                </ul>

                {/* Only the LAST section takes the base. Pinning the whole
                    trailing group put the card's slack directly under the tab
                    specimen, where a 90px hole reads as something that failed
                    to render; between two labelled sections it reads as what it
                    is — this kind has less to say. Bottoms still land on one
                    line, which is the defect that mattered. */}
                <CardBase className="gap-[var(--ds-space-tight)] pt-[var(--ds-space-cozy)]">
                  <span className={cn(dsText.caps, "text-[color:var(--ds-fg-muted)]")}>Specifics</span>
                  <ul className="flex flex-col gap-[var(--ds-space-hair)]">
                    {p.specifics.map((c) => (
                      <li key={c} className={cn(dsText.meta, "flex gap-[var(--ds-space-snug)] text-[color:var(--ds-fg-secondary)]")}>
                        <span aria-hidden className={cn(specBullet, "bg-[var(--ds-fg-faint)]")} />
                        <span className="min-w-0">{c}</span>
                      </li>
                    ))}
                  </ul>
                </CardBase>
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
          <div className={cn("overflow-hidden border", dsRadius.lg, dsBorder.base)}>
            {byWorkflow.map((w, i) => (
              <div
                key={w.code}
                className={cn(
                  "flex gap-[var(--ds-space-cozy)] px-[var(--ds-space-cozy)] py-[var(--ds-space-base)]",
                  i > 0 && cn("border-t", dsBorder.subtle),
                )}
              >
                <span className="flex w-40 shrink-0 items-baseline gap-[var(--ds-space-snug)]">
                  <span className={cn(dsText.meta, dsText.nums, "text-[color:var(--ds-fg-muted)]")}>{w.code}</span>
                  <span className={cn(dsText.ui, "font-medium text-[color:var(--ds-fg)]")}>{w.label}</span>
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-[var(--ds-space-tight)]">
                  {w.uses.map((u) => (
                    <div key={u.variant} className={cn(dsText.body, "flex min-w-0 gap-[var(--ds-space-base)]")}>
                      <span className="w-40 shrink-0 text-[color:var(--ds-fg-secondary)]">{u.variant}</span>
                      <span className="min-w-0 flex-1 text-[color:var(--ds-fg-muted)]">{u.note}</span>
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
