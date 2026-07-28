import { useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  Camera,
  ChevronsUp,
  ClipboardList,
  Inbox,
  Info,
  Pencil,
  Play,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Badge,
  Banner,
  BulletList,
  Button,
  Card,
  CardBase,
  CompareCard,
  CompareGrid,
  CardBody,
  CardFooter,
  CardHeader,
  Checkbox,
  Chip,
  ChipRow,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  CountBadge,
  MetaLine,
  Refusal,
  DS_STATUS,
  DS_STATUS_ORDER,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  Drawer,
  DrawerContent,
  EmptyState,
  Field,
  IconButton,
  Input,
  Kbd,
  KeyValueList,
  Panel,
  PanelBody,
  PanelFooter,
  PanelHeader,
  PanelToolbar,
  ProgressBar,
  RadioGroup,
  SearchInput,
  ValueField,
  LockedValue,
  SectionLabel,
  Select,
  Separator,
  Skeleton,
  Spinner,
  StatusDot,
  StatusPill,
  Switch,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Tab,
  TabList,
  TabPanel,
  Table,
  Tabs,
  Textarea,
  TimelineSteps,
  ToastProvider,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipProvider,
  Well,
  dsBorder,
  dsFocus,
  dsIcon,
  dsRadius,
  dsText,
  useToasts,
  type DsStatus,
} from "./demo-ui";

/**
 * DEV-ONLY — the design-system specimen page.
 *
 * Every primitive in `demo-ui.tsx`, in every state, on one scrollable page.
 * Two jobs: it is the visual proof that the system renders, and it is the
 * catalogue a builder agent skims before choosing a component.
 *
 * Not wired into the demo's view switch (that lives in files this pass may not
 * touch) — render `<DemoUiKit />` from anywhere, or open `kit.html` on the
 * Vite dev server.
 */

const KIT_SECTIONS = [
  "Status",
  "Actions",
  "Display",
  "Containers",
  "Forms",
  "Overlays",
  "Foundations",
] as const;

export function DemoUiKit() {
  return (
    <TooltipProvider delayDuration={250}>
      <ToastProvider>
        <div className="flex min-h-screen flex-col bg-[var(--ds-surface-page)] text-[color:var(--ds-fg)]">
          <KitHeader />
          <main className="mx-auto flex w-full max-w-[1180px] flex-col gap-[var(--ds-space-page)] px-[var(--ds-space-section)] py-[var(--ds-space-section)]">
            <StatusSection />
            <ActionsSection />
            <DisplaySection />
            <ContainersSection />
            <FormsSection />
            <OverlaysSection />
            <FoundationsSection />
          </main>
        </div>
      </ToastProvider>
    </TooltipProvider>
  );
}

function KitHeader() {
  return (
    <header className="sticky top-0 z-10 flex h-[var(--ds-h-topbar)] shrink-0 items-center gap-[var(--ds-space-cozy)] border-b border-[color:var(--ds-border)] bg-[var(--ds-surface-1)] px-[var(--ds-space-cozy)]">
      <span className="flex items-center gap-[var(--ds-space-base)]">
        <span className="flex size-6 items-center justify-center rounded-[var(--ds-radius-md)] bg-[var(--ds-accent-quiet)]">
          <ShieldCheck aria-hidden className="size-3.5 text-[color:var(--ds-accent-mark)]" />
        </span>
        <span className={cn(dsText.ui, "font-semibold")}>Rebuild demo — design system</span>
      </span>
      <Badge tone="info">dev only · specimen page</Badge>
      <nav aria-label="Sections" className="ml-auto flex items-center gap-[var(--ds-space-tight)]">
        {KIT_SECTIONS.map((section) => (
          <a
            key={section}
            href={`#${section.toLowerCase()}`}
            className={cn(
              dsText.meta,
              "ds-focus ds-motion rounded-[var(--ds-radius-sm)] px-[var(--ds-space-snug)] py-[var(--ds-space-hair)] outline-none",
              "text-[color:var(--ds-fg-muted)] hover:bg-[var(--ds-surface-3)] hover:text-[color:var(--ds-fg)]",
            )}
          >
            {section}
          </a>
        ))}
      </nav>
    </header>
  );
}

function Section({
  id,
  title,
  note,
  children,
}: {
  id: string;
  title: string;
  note: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="flex flex-col gap-[var(--ds-space-cozy)]">
      <div className="flex flex-col gap-[var(--ds-space-hair)] border-b border-[color:var(--ds-border-subtle)] pb-[var(--ds-space-base)]">
        <h2 className={cn(dsText.section, "font-semibold")}>{title}</h2>
        <p className={cn(dsText.body, "max-w-[80ch] text-[color:var(--ds-fg-muted)]")}>{note}</p>
      </div>
      {children}
    </section>
  );
}

/** five facts of five different widths — the case a bare `flex-wrap` gets wrong */
const CHIP_ROW_SPECIMEN: { label: string; value: string }[] = [
  { label: "wage", value: "$18.50/hr" },
  { label: "effective", value: "07/01" },
  { label: "dept", value: "000482" },
  { label: "txn", value: "TXN-0891245" },
  { label: "EID", value: "10084412" },
];

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-[var(--ds-space-cozy)] py-[var(--ds-space-snug)]">
      <SectionLabel className="w-[130px] shrink-0">{label}</SectionLabel>
      <div className="flex flex-wrap items-center gap-[var(--ds-space-base)]">{children}</div>
    </div>
  );
}

/* ---------------------------------------------------------------- Status */

const QUEUE_SAMPLE: { name: string; trace: string; status: DsStatus; age?: string }[] = [
  { name: "Alvarez, Marisol", trace: "se-140211-9f3a", status: "waiting", age: "12m" },
  { name: "oath-batch-07.pdf", trace: "ou-134455-2c1d", status: "failed", age: "3m" },
  { name: "Nguyen, Trang", trace: "ec-131002-77ab", status: "parked", age: "48m" },
  { name: "Okonkwo, Ada", trace: "ic-125518-4e90", status: "doneWarnings" },
  { name: "Bauer, Jonas", trace: "se-125001-b120", status: "running" },
  { name: "Silva, Renata", trace: "pl-124430-cc31", status: "queued" },
  { name: "Duval, Henri", trace: "ws-120911-8fa2", status: "cancelled" },
  { name: "Petrov, Iryna", trace: "on-115502-de44", status: "verifiedDone" },
];

function StatusSection() {
  return (
    <Section
      id="status"
      title="The eight statuses"
      note="Four separating channels per status: hue, emphasis tier, icon and label. Waiting on you and Failed are the only solid fills — the two loudest things the product can show. Done has no chip at all."
    >
      <div className="grid grid-cols-2 gap-[var(--ds-space-base)]">
        {DS_STATUS_ORDER.map((status) => (
          <div
            key={status}
            className="flex items-start gap-[var(--ds-space-cozy)] rounded-[var(--ds-radius-md)] border border-[color:var(--ds-border-subtle)] p-[var(--ds-space-base)]"
          >
            <StatusPill status={status} age={status === "waiting" ? "12m" : undefined} />
            <span className={cn(dsText.meta, "min-w-0 flex-1 text-[color:var(--ds-fg-muted)]")}>
              {DS_STATUS[status].meaning}
            </span>
            <span className={cn(dsText.micro, "shrink-0 uppercase text-[color:var(--ds-fg-faint)]")}>
              {DS_STATUS[status].tier}
            </span>
          </div>
        ))}
      </div>

      <Panel>
        <PanelHeader
          title="In a dense queue"
          subtitle="the only view that proves the mapping works"
          meta={<span className={dsText.nums}>8 rows</span>}
        />
        <div>
          {QUEUE_SAMPLE.map((row) => (
            <div
              key={row.trace}
              className="flex h-[var(--ds-h-row)] items-center gap-[var(--ds-space-base)] border-b border-[color:var(--ds-border-subtle)] px-[var(--ds-space-cozy)] last:border-b-0"
            >
              <StatusDot status={row.status} />
              <span className={cn(dsText.ui, "min-w-0 flex-1 truncate")}>{row.name}</span>
              <span className={cn(dsText.meta, dsText.nums, "shrink-0 text-[color:var(--ds-fg-muted)]")}>
                {row.trace}
              </span>
              <StatusPill status={row.status} age={row.age} size="sm" />
            </div>
          ))}
        </div>
        <PanelFooter>
          <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
            Scan it with your eyes half-closed: two blocks of light, everything else recedes.
          </span>
        </PanelFooter>
      </Panel>
    </Section>
  );
}

/* --------------------------------------------------------------- Actions */

function ActionsSection() {
  const [loading, setLoading] = useState(false);
  return (
    <Section
      id="actions"
      title="Actions"
      note="One primary per surface, one danger per surface. Variant is semantic, not decorative — outline for peers in a toolbar, ghost for anything that must not compete."
    >
      <Row label="Variants">
        <Button variant="primary" icon={<Play aria-hidden className="size-3.5" />}>
          Run
        </Button>
        <Button variant="secondary">Cancel</Button>
        <Button variant="outline" icon={<Upload aria-hidden className="size-3.5" />}>
          Upload
        </Button>
        <Button variant="ghost" iconAfter={<ArrowUpRight aria-hidden className="size-3.5" />}>
          Open receipt
        </Button>
        <Button variant="danger" icon={<Trash2 aria-hidden className="size-3.5" />}>
          Delete run
        </Button>
        <Button variant="dangerGhost">Remove</Button>
      </Row>
      <Row label="Sizes">
        <Button size="sm">Small</Button>
        <Button size="md">Medium</Button>
        <Button size="lg" variant="primary">
          Large
        </Button>
      </Row>
      <Row label="States">
        <Button disabled>Disabled</Button>
        <Button variant="primary" loading={loading} onClick={() => setLoading((v) => !v)}>
          {loading ? "Submitting" : "Toggle loading"}
        </Button>
        <Button variant="danger" disabled>
          Danger disabled
        </Button>
      </Row>
      <Row label="Icon buttons">
        <Tooltip content="Replays the same input">
          <IconButton label="Retry" icon={<RotateCcw aria-hidden className="size-3.5" />} />
        </Tooltip>
        <IconButton label="Bump to front" variant="outline" icon={<ChevronsUp aria-hidden className="size-3.5" />} />
        <IconButton label="Delete" variant="danger" icon={<Trash2 aria-hidden className="size-3.5" />} />
        <IconButton label="Peek" size="sm" icon={<Camera aria-hidden className="size-3" />} />
        <IconButton label="Working" loading icon={<Camera aria-hidden className="size-3.5" />} />
      </Row>
    </Section>
  );
}

/* --------------------------------------------------------------- Display */

const SAMPLE_STEPS = [
  { label: "Kuali extraction", state: "done" as const, detail: "4.1s" },
  { label: "Identity check", state: "done" as const, detail: "2.8s" },
  { label: "UCPath transaction", state: "current" as const, detail: "running 41s" },
  { label: "Kronos search", state: "pending" as const },
  { label: "Kuali finalization", state: "pending" as const },
];

function DisplaySection() {
  return (
    <Section
      id="display"
      title="Display"
      note="Small parts that carry a value: counts, facts, progress and where a run is. Every number is tabular so a ticking value never reflows the row."
    >
      <Row label="Badges">
        <Badge>neutral</Badge>
        <Badge tone="info">delegated</Badge>
        <Badge tone="success">verified</Badge>
        <Badge tone="warning">gate</Badge>
        <Badge tone="danger">write parked</Badge>
        <Badge tone="attention">3 need you</Badge>
      </Row>
      <Row label="Counts">
        <CountBadge value={0} />
        <CountBadge value={12} />
        <CountBadge value={1240} />
        <CountBadge value={3} tone="attention" />
      </Row>
      <Row label="Chips">
        <Chip label="EID">100844120</Chip>
        <Chip label="file">oath-batch-07.pdf</Chip>
        <Chip tone="warning" label="rate">
          18.50 → 21.00
        </Chip>
        <Chip tone="danger" label="page">
          4 rejected
        </Chip>
        <Chip onRemove={() => undefined}>Separations</Chip>
        <Chip selected onSelect={() => undefined}>
          Needs you
        </Chip>
      </Row>
      <Row label="Keys">
        <Kbd>j</Kbd>
        <Kbd>k</Kbd>
        <Kbd>⌘K</Kbd>
        <Kbd>Esc</Kbd>
      </Row>
      <Row label="Loading">
        <Spinner />
        <span className="flex w-[220px] flex-col gap-[var(--ds-space-tight)]">
          <Skeleton className="w-1/2" />
          <Skeleton />
          <Skeleton className="w-3/4" />
        </span>
      </Row>

      <div className="grid grid-cols-2 gap-[var(--ds-space-cozy)]">
        <Card>
          <CardHeader>
            <span className={cn(dsText.title, "font-semibold")}>Progress</span>
          </CardHeader>
          <CardBody grow className="flex flex-col gap-[var(--ds-space-cozy)]">
            <ProgressBar label="Records approved" value={64} showValue />
            <ProgressBar label="Pages verified" value={100} tone="success" showValue />
            <ProgressBar label="Retries used" value={80} tone="warning" showValue />
            <ProgressBar label="Failed writes" value={22} tone="danger" showValue />
            <ProgressBar label="Waiting on UCPath" />
            {/* The caveat belongs to the CARD, so it sits on the card's bottom
                edge rather than floating in the middle of it beside a taller
                neighbour. */}
            <CardBase>
              <span className={cn(dsText.meta, "text-[color:var(--ds-fg-faint)]")}>
                The last bar is indeterminate — never fake a denominator you do not have.
              </span>
            </CardBase>
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <span className={cn(dsText.title, "font-semibold")}>Timeline</span>
          </CardHeader>
          <CardBody grow className="flex flex-col gap-[var(--ds-space-cozy)]">
            <TimelineSteps steps={SAMPLE_STEPS} variant="compact" />
            <Separator />
            <TimelineSteps steps={SAMPLE_STEPS} variant="full" />
          </CardBody>
        </Card>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------ Containers */

function ContainersSection() {
  const [tab, setTab] = useState("log");
  return (
    <Section
      id="containers"
      title="Containers"
      note="Depth comes from surface plus a hairline, never from a shadow. A Panel sits on the page, a Card sits in a Panel, a Well sits in a Card. Anything with a shadow is floating."
    >
      <div className="grid grid-cols-2 gap-[var(--ds-space-cozy)]">
        <Panel className="h-[320px]">
          <PanelHeader
            title="Queue"
            subtitle="Separations · Sat, Jul 25"
            meta={<span className={dsText.nums}>18</span>}
            actions={<IconButton label="Refresh" size="sm" icon={<RotateCcw aria-hidden className="size-3.5" />} />}
          />
          <PanelToolbar label="Queue filters">
            <Chip selected onSelect={() => undefined}>
              All
            </Chip>
            <Chip onSelect={() => undefined}>Needs you</Chip>
            <Chip onSelect={() => undefined}>Failed</Chip>
            <span className="ml-auto w-[180px]">
              <SearchInput placeholder="Search rows…" shortcut={<Kbd>/</Kbd>} />
            </span>
          </PanelToolbar>
          <PanelBody>
            <Table label="Queued runs">
              <THead>
                <TR>
                  <TH>Person</TH>
                  <TH sort="descending" onSort={() => undefined}>
                    Status
                  </TH>
                  <TH align="right">Elapsed</TH>
                </TR>
              </THead>
              <TBody>
                {QUEUE_SAMPLE.slice(0, 5).map((row, index) => (
                  <TR key={row.trace} interactive selected={index === 0}>
                    <TD className="text-[color:var(--ds-fg)]">{row.name}</TD>
                    <TD>
                      <StatusPill status={row.status} size="sm" />
                    </TD>
                    <TD align="right" numeric>
                      {row.age ?? "—"}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </PanelBody>
          <PanelFooter>
            <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>5 of 18 shown</span>
            <Button size="sm" variant="ghost" className="ml-auto">
              Load more
            </Button>
          </PanelFooter>
        </Panel>

        <div className="flex flex-col gap-[var(--ds-space-cozy)]">
          <Card tone="attention">
            <CardHeader>
              <StatusPill status="waiting" age="12m" size="sm" />
              <span className={cn(dsText.ui, "ml-auto font-medium")}>Alvarez, Marisol</span>
            </CardHeader>
            <CardBody>
              <KeyValueList
                items={[
                  { key: "EID", value: "100844120" },
                  { key: "Trace", value: "se-140211-9f3a" },
                  { key: "Pay rate", value: "18.50 → 21.00", tone: "warning" },
                ]}
              />
            </CardBody>
            <CardFooter>
              <Button size="sm" variant="primary">
                Approve
              </Button>
              <Button size="sm" variant="secondary">
                Open
              </Button>
              <IconButton
                label="Delete"
                size="sm"
                variant="danger"
                className="ml-auto"
                icon={<Trash2 aria-hidden className="size-3.5" />}
              />
            </CardFooter>
          </Card>

          <Banner
            tone="danger"
            title="UCPath write parked"
            action={
              <Button size="sm" variant="dangerGhost">
                Resolve
              </Button>
            }
          >
            The transaction was submitted but the read-back did not confirm it. Nothing will be
            retried automatically — check UCPath and mark it present or absent.
          </Banner>
          <Banner tone="warning" title="OCR fell back to tier 2 on 3 pages">
            Handwritten SSNs on those pages were re-read by a weaker model. Verify them.
          </Banner>
          <Banner tone="info" title="Synthetic data">
            Nothing on this page touches a real system.
          </Banner>
          <Banner tone="success" title="12 records verified" />

          {/* A REFUSAL is not a failure. The triangle means something broke;
              the shield means the product declined, on purpose, with a rule
              behind it — and always with the code that names the rule. */}
          <Refusal
            title="Nothing was enqueued — this form was built on a stale contract"
            code="workflow-version-conflict"
            outcome="nothing is enqueued"
            meta={["form built at v5", "server serves v6"]}
            action={
              <Button size="sm" variant="primary">
                Reload the form
              </Button>
            }
          >
            Separations changed behaviour after this modal opened. Starting on the old contract
            would run retired code against a live person.
          </Refusal>

          <Well className="flex flex-col gap-[var(--ds-space-snug)]">
            <SectionLabel>MetaLine — the provenance line</SectionLabel>
            <MetaLine
              items={["receipt rc-0884019", "generated 2:20 PM", "attempt 2", "filed by local-operator"]}
            />
            <MetaLine tone="faint" items={["se-142012-b410", "header row 4", "fingerprint 503172dd"]} />
            <SectionLabel>BulletList</SectionLabel>
            <BulletList
              items={[
                "Every run already on disk still opens, read-only.",
                "Nothing new can be enqueued until the volume is writable.",
              ]}
            />
          </Well>

          {/* ChipRow — the same five facts twice. The top row is a bare
              `flex-wrap`, which is what every chip row in this demo used to be:
              line one ends at the container edge, line two ends wherever its
              last chip stopped, and the set reads as four-plus-one. The bottom
              row lays them on the shared track, so both lines end on the same
              edge and it reads as one block. */}
          <div className="flex flex-col gap-[var(--ds-space-snug)]">
            <SectionLabel>ChipRow — a wrapping row of peer facts</SectionLabel>
            <div className="flex flex-wrap gap-[var(--ds-space-tight)] opacity-60">
              {CHIP_ROW_SPECIMEN.map((c) => (
                <Chip key={c.label} label={c.label}>
                  {c.value}
                </Chip>
              ))}
            </div>
            <ChipRow>
              {CHIP_ROW_SPECIMEN.map((c) => (
                <Chip key={c.label} label={c.label} className="w-full">
                  {c.value}
                </Chip>
              ))}
            </ChipRow>
          </div>
        </div>
      </div>

      {/* CardBody grow + CardBase — the sibling-alignment pair.
          The three descriptions are deliberately one, two and three lines long:
          without `grow` on the body nothing claims the row's slack, and without
          `CardBase` the button hangs off the end of each card's own text, so
          the middle card's control sits a line below its neighbours'. */}
      <div className="flex flex-col gap-[var(--ds-space-snug)]">
        <SectionLabel>CardBase — a trailing control on the row&apos;s bottom edge, not on its own card&apos;s</SectionLabel>
        <div className="grid grid-cols-3 gap-[var(--ds-space-cozy)]">
          {[
            { name: "Marisol Alvarez", sub: "On the input record", detail: "Read off the separation document." },
            {
              name: "Marisol Alvarez-Ruiz",
              sub: "Name match (proposed)",
              detail: "Resolved in UCPath on last name plus department, which is a different person than the document names.",
            },
            { name: "Typed by you", sub: "Manual entry", detail: "Not on any page." },
          ].map((c) => (
            <Card key={c.sub}>
              <CardBody grow className="flex flex-col gap-[var(--ds-space-hair)]">
                <SectionLabel>{c.sub}</SectionLabel>
                <span className={cn(dsText.ui, "font-semibold text-[color:var(--ds-fg)]")}>{c.name}</span>
                <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>{c.detail}</span>
                <CardBase className="pt-[var(--ds-space-tight)]">
                  <Button size="sm" variant="outline" icon={<Camera aria-hidden className={dsIcon.sm} />}>
                    See this candidate
                  </Button>
                </CardBase>
              </CardBody>
            </Card>
          ))}
        </div>
      </div>

      {/* CompareGrid + CompareCard — the OTHER half of sibling alignment.
          Same three candidates as the specimen above, and the difference is
          visible at a glance: there, only the buttons agree; here every line
          does, because the cards share the row's tracks rather than just its
          bottom edge. The third card has no reason at all and still holds the
          space its neighbours' reasons need. */}
      <div className="flex flex-col gap-[var(--ds-space-snug)]">
        <SectionLabel>CompareGrid — cards read ACROSS: name with name, reason with reason</SectionLabel>
        <CompareGrid rows={4} min="14rem">
          {[
            { name: "Marisol Alvarez", sub: "On the input record", detail: "Read off the separation document." },
            {
              name: "Marisol Alvarez-Ruiz",
              sub: "Name match (proposed)",
              detail: "Resolved in UCPath on last name plus department, which is a different person than the document names.",
            },
            { name: "Typed by you", sub: "Manual entry", detail: "" },
          ].map((c) => (
            <CompareCard key={c.sub} rows={4}>
              <SectionLabel>{c.sub}</SectionLabel>
              <span className={cn(dsText.ui, "font-semibold text-[color:var(--ds-fg)]")}>{c.name}</span>
              <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>{c.detail}</span>
              <span className="flex flex-col justify-end pt-[var(--ds-space-tight)]">
                <Button size="sm" variant="outline" className="w-full" icon={<Camera aria-hidden className={dsIcon.sm} />}>
                  See this candidate
                </Button>
              </span>
            </CompareCard>
          ))}
        </CompareGrid>
      </div>

      <div className="grid grid-cols-2 gap-[var(--ds-space-cozy)]">
        <Panel className="h-[260px]">
          <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1">
            <TabList label="Run detail">
              <Tab value="log">Log</Tab>
              <Tab value="data" count={12}>
                Data
              </Tab>
              <Tab value="evidence" count={4}>
                Evidence
              </Tab>
              <Tab value="receipt" disabled>
                Receipt
              </Tab>
            </TabList>
            <TabPanel value="log" className="p-[var(--ds-space-cozy)]">
              <Well className={dsText.nums}>
                12:04:11 kuali → extracted 6 fields
                <br />
                12:04:18 ucpath → row found, EID 100844120
                <br />
                12:04:41 ucpath → submitting transaction…
              </Well>
            </TabPanel>
            <TabPanel value="data" className="p-[var(--ds-space-cozy)]">
              <KeyValueList
                items={[
                  { key: "Department", value: "SDCMP · 000123" },
                  { key: "Effective", value: "2026-08-01" },
                  { key: "Timekeeper", value: "J. Hein" },
                ]}
              />
            </TabPanel>
            <TabPanel value="evidence" className="p-[var(--ds-space-cozy)]">
              <EmptyState
                icon={<Camera aria-hidden className="size-4" />}
                title="No screenshots captured yet"
                description="Evidence appears once the run reaches its first write step."
              />
            </TabPanel>
            <TabPanel value="receipt">
              <EmptyState title="Not available until the run is verified" />
            </TabPanel>
          </Tabs>
        </Panel>

        <Panel className="h-[260px]">
          <PanelHeader title="Empty states" />
          <PanelBody>
            <EmptyState
              icon={<Inbox aria-hidden className="size-4" />}
              title="Nothing needs you right now"
              description="Runs that stop at a gate land here. The rail badge turns amber when one arrives."
              action={
                <Button size="sm" variant="secondary">
                  View all runs
                </Button>
              }
            />
          </PanelBody>
        </Panel>
      </div>
    </Section>
  );
}

/* ----------------------------------------------------------------- Forms */

function FormsSection() {
  const [checked, setChecked] = useState<boolean | "indeterminate">("indeterminate");
  const [mode, setMode] = useState<"dry" | "live">("dry");
  const [notify, setNotify] = useState(false);
  const [search, setSearch] = useState("");
  const [corrected, setCorrected] = useState("07/16/2026");
  return (
    <Section
      id="forms"
      title="Forms"
      note="Every control has a visible label; errors are announced, not just coloured. Field wires the ids — never hand-roll aria-describedby."
    >
      <div className="grid grid-cols-3 gap-[var(--ds-space-loose)]">
        <div className="flex flex-col gap-[var(--ds-space-cozy)]">
          <Field label="Employee ID" description="9 digits, no dashes" required>
            <Input placeholder="100844120" defaultValue="100844120" />
          </Field>
          <Field label="Employee ID" error="No UCPath record matches 10084412X.">
            <Input defaultValue="10084412X" />
          </Field>
          <Field label="Workflow" hint="8 available">
            <Select defaultValue="separations">
              <option value="separations">Separations</option>
              <option value="onboarding">Onboarding</option>
              <option value="oath">Oath Signature</option>
            </Select>
          </Field>
          <Field label="Disabled" description="Locked while a run is in flight" disabled>
            <Input defaultValue="se-140211-9f3a" />
          </Field>
        </div>

        <div className="flex flex-col gap-[var(--ds-space-cozy)]">
          <Field label="Note for the receipt">
            <Textarea rows={4} placeholder="Why this run was started…" />
          </Field>
          <SearchInput
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onClear={() => setSearch("")}
            placeholder="Search people, files, trace ids…"
            shortcut={<Kbd>/</Kbd>}
          />

          {/* A RECORDED value, which is a different thing from a form input:
              the run observed it, and the only question is whether the operator
              may correct it. The pair is told apart by SHAPE — a box takes
              typing, flat text with a lock does not — because on a surface that
              files real HR transactions, "you may change this" and "you may
              not" is the load-bearing distinction. Both the Data ledger and the
              OCR review draw these; do not hand-roll a third. */}
          <SectionLabel>Recorded value</SectionLabel>
          <div className="flex flex-col gap-[var(--ds-space-base)]">
            <ValueField ariaLabel="Separation date — correctable" value={corrected} onChange={setCorrected} />
            <ValueField
              ariaLabel="Separation date — corrected, not yet saved"
              value="07/18/2026"
              dirty
              onChange={() => {}}
            />
            <LockedValue
              value="Voluntary termination"
              reason="A write is a record of what happened, not a form. It is shown here and never edited."
            />
            <LockedValue
              value="never read back"
              tone="warning"
              reason="Sent, but never read back — the outcome is unknown until you resolve the park."
            />
          </div>
        </div>

        <div className="flex flex-col gap-[var(--ds-space-loose)]">
          <div className="flex flex-col gap-[var(--ds-space-base)]">
            <SectionLabel>Checkbox</SectionLabel>
            <Checkbox
              checked={checked}
              onCheckedChange={(value) => setChecked(value)}
              label="Select all rows"
              description="Indeterminate when only some are checked"
            />
            <Checkbox checked label="Capture a screenshot at each write" />
            <Checkbox
              checked={false}
              disabled
              label="Auto-retry parked writes"
              description="Never available — a parked write is resolved by a human"
            />
          </div>
          <RadioGroup
            label="Run mode"
            name="kit-mode"
            value={mode}
            onValueChange={setMode}
            options={[
              { value: "dry", label: "Dry run", description: "No transaction is submitted" },
              { value: "live", label: "Live", description: "Files a real HR transaction" },
            ]}
          />
          <Switch
            checked={notify}
            onCheckedChange={setNotify}
            label="Desktop notifications"
            description="Applies immediately"
          />
        </div>
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------- Overlays */

function OverlaysSection() {
  const [dialog, setDialog] = useState(false);
  const [danger, setDanger] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const { toast } = useToasts();

  return (
    <Section
      id="overlays"
      title="Overlays"
      note="Radix owns focus: focus moves in on open and returns to the trigger on close, Escape dismisses, the rest of the page is hidden from assistive tech. A danger toast never auto-dismisses."
    >
      <Row label="Dialog">
        <Button variant="secondary" onClick={() => setDialog(true)}>
          Open dialog
        </Button>
        <Button variant="dangerGhost" onClick={() => setDanger(true)}>
          Open destructive dialog
        </Button>
        <Button variant="secondary" onClick={() => setDrawer(true)}>
          Open drawer
        </Button>
      </Row>
      {/* ContextMenu — an object's own commands, ON the object. There is no
          `⋯` in this system: a button whose only job is to admit there are more
          buttons costs a slot on every row in a queue. Right-click the panel
          below, or focus it and press the platform's Menu / Shift+F10 key —
          a shell binds its own shortcut through `openContextMenuFor`. */}
      <Row label="ContextMenu">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              role="button"
              tabIndex={0}
              className={cn(
                "flex w-[260px] cursor-context-menu items-center justify-center border border-dashed",
                "h-[var(--ds-h-lg)]",
                dsRadius.md,
                dsFocus,
                dsText.body,
                "border-[color:var(--ds-border-strong)] bg-[var(--ds-surface-2)] text-[color:var(--ds-fg-muted)]",
              )}
            >
              Right-click me
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent label="Commands for the specimen row">
            <ContextMenuItem icon={<ClipboardList aria-hidden className={dsIcon.md} />}>Review</ContextMenuItem>
            <ContextMenuSeparator className={cn("my-[var(--ds-space-tight)] h-px border-t", dsBorder.subtle)} />
            <ContextMenuItem icon={<RotateCcw aria-hidden className={dsIcon.md} />}>Retry</ContextMenuItem>
            <ContextMenuItem icon={<Pencil aria-hidden className={dsIcon.md} />}>Name this run…</ContextMenuItem>
            <ContextMenuSeparator className={cn("my-[var(--ds-space-tight)] h-px border-t", dsBorder.subtle)} />
            <ContextMenuItem icon={<Trash2 aria-hidden className={dsIcon.md} />} tone="destructive" hint="asks first">
              Delete
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </Row>
      <Row label="Toast">
        <Button
          size="sm"
          onClick={() => toast({ tone: "info", title: "Run queued", description: "se-140211-9f3a" })}
        >
          Info
        </Button>
        <Button size="sm" onClick={() => toast({ tone: "success", title: "12 records verified" })}>
          Success
        </Button>
        <Button
          size="sm"
          onClick={() =>
            toast({
              tone: "warning",
              title: "OCR fell back to tier 2",
              description: "3 pages need your eyes",
            })
          }
        >
          Warning
        </Button>
        <Button
          size="sm"
          variant="dangerGhost"
          onClick={() =>
            toast({
              tone: "danger",
              title: "Write parked",
              description: "UCPath did not confirm the read-back. This stays until you dismiss it.",
              action: { label: "Open the run", onAction: () => undefined },
            })
          }
        >
          Danger
        </Button>
      </Row>
      <Row label="Tooltip">
        <Tooltip content="A hint, never the only place information lives.">
          <Button variant="ghost">Hover me</Button>
        </Tooltip>
      </Row>
      {/* The Tooltip's counterpart. Anything the operator has to be able to
          READ belongs here, not in a hover-only surface: this one opens on
          CLICK, so it is reachable by pointer, touch and keyboard. It flips
          when it would overflow, Escape and outside-click dismiss it, focus
          enters on open and returns to the trigger on close. */}
      <Row label="Popover">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="secondary">Why is this parked?</Button>
          </PopoverTrigger>
          <PopoverContent
            title="Why is this parked?"
            description="ws-140902-4c1a · Work-Study"
            width="lg"
          >
            <BulletList
              items={[
                "The UCPath save posted, but the read-back returned no confirmation.",
                "Nothing may claim this write landed until a human checks it.",
                "Resolving it needs the transaction number from the UCPath page.",
              ]}
            />
          </PopoverContent>
        </Popover>
        <Popover>
          <PopoverTrigger asChild>
            <IconButton label="About this trace id" icon={<Info aria-hidden className={dsIcon.md} />} />
          </PopoverTrigger>
          <PopoverContent title="About this trace id" width="sm" side="right" hideTitle>
            <span className={dsText.nums}>se-140211-9f3a</span> — workflow code,
            local time of day, and the first four characters of the run id.
          </PopoverContent>
        </Popover>
      </Row>

      <Dialog open={dialog} onOpenChange={setDialog}>
        <DialogContent
          title="Approve 12 records"
          description="They will be written to UCPath in one batch. Nothing is written until you confirm."
        >
          <DialogBody className="flex flex-col gap-[var(--ds-space-cozy)]">
            <Banner tone="warning" title="3 records came from a tier-2 OCR read">
              Verify the handwritten fields before approving.
            </Banner>
            <KeyValueList
              items={[
                { key: "Workflow", value: "Emergency Contact" },
                { key: "Source", value: "ec-batch-2026-07-25.pdf" },
                { key: "Records", value: "12" },
                { key: "Warnings", value: "3", tone: "warning" },
              ]}
            />
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDialog(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => setDialog(false)}>
              Approve 12
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={danger} onOpenChange={setDanger}>
        <DialogContent
          size="sm"
          title="Delete this run?"
          description="The tracker row and its evidence are removed. This cannot be undone."
        >
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDanger(false)}>
              Keep it
            </Button>
            <Button variant="danger" onClick={() => setDanger(false)}>
              Delete run
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Drawer open={drawer} onOpenChange={setDrawer}>
        <DrawerContent title="Alvarez, Marisol" description="se-140211-9f3a · Separations">
          <div className="flex min-h-0 flex-1 flex-col gap-[var(--ds-space-cozy)] overflow-y-auto p-[var(--ds-space-cozy)]">
            <StatusPill status="waiting" age="12m" />
            <TimelineSteps steps={SAMPLE_STEPS} variant="full" />
            <Well className={dsText.nums}>12:04:41 ucpath → awaiting your decision</Well>
          </div>
        </DrawerContent>
      </Drawer>
    </Section>
  );
}

/* ----------------------------------------------------------- Foundations */

const TYPE_SPECIMENS: { name: string; cls: string }[] = [
  { name: "display · 20px", cls: dsText.display },
  { name: "section · 16px", cls: dsText.section },
  { name: "title · 14px", cls: dsText.title },
  { name: "ui · 13px", cls: dsText.ui },
  { name: "body · 12px", cls: dsText.body },
  { name: "meta · 11px", cls: dsText.meta },
  { name: "micro · 10px", cls: dsText.micro },
];

const SURFACES: { cssVar: string; cls: string; use: string }[] = [
  { cssVar: "--ds-surface-page", cls: "bg-[var(--ds-surface-page)]", use: "page" },
  { cssVar: "--ds-surface-1", cls: "bg-[var(--ds-surface-1)]", use: "panels, cards" },
  { cssVar: "--ds-surface-2", cls: "bg-[var(--ds-surface-2)]", use: "wells, table head" },
  { cssVar: "--ds-surface-3", cls: "bg-[var(--ds-surface-3)]", use: "hover, selected" },
  { cssVar: "--ds-surface-overlay", cls: "bg-[var(--ds-surface-overlay)]", use: "dialogs, menus" },
];

const ELEVATIONS: { cls: string; name: string }[] = [
  { cls: "", name: "0 · flat" },
  { cls: "ds-elev-1", name: "1 · raised" },
  { cls: "ds-elev-2", name: "2 · menu" },
  { cls: "ds-elev-3", name: "3 · modal" },
];

function FoundationsSection() {
  return (
    <Section
      id="foundations"
      title="Foundations"
      note="Seven type sizes, one 8px space rhythm, five surfaces, three elevations, one focus ring. If a value you need is missing, add a design token — do not write a literal."
    >
      <div className="grid grid-cols-2 gap-[var(--ds-space-loose)]">
        <Card>
          <CardHeader>
            <span className={cn(dsText.title, "font-semibold")}>Type scale</span>
          </CardHeader>
          <CardBody className="flex flex-col gap-[var(--ds-space-base)]">
            {TYPE_SPECIMENS.map((item) => (
              <div key={item.name} className="flex items-baseline gap-[var(--ds-space-cozy)]">
                <span className={cn(item.cls, "min-w-0 flex-1 truncate")}>
                  Separations · Alvarez, Marisol
                </span>
                <span className={cn(dsText.micro, "shrink-0 text-[color:var(--ds-fg-faint)]")}>
                  {item.name}
                </span>
              </div>
            ))}
          </CardBody>
        </Card>

        <div className="flex flex-col gap-[var(--ds-space-cozy)]">
          <Card>
            <CardHeader>
              <span className={cn(dsText.title, "font-semibold")}>Surfaces</span>
            </CardHeader>
            <CardBody className="flex flex-col gap-[var(--ds-space-tight)]">
              {SURFACES.map((surface) => (
                <div key={surface.cssVar} className="flex items-center gap-[var(--ds-space-base)]">
                  <span
                    className={cn(
                      "size-6 shrink-0 rounded-[var(--ds-radius-sm)] border border-[color:var(--ds-border)]",
                      surface.cls,
                    )}
                  />
                  <span className={cn(dsText.meta, dsText.nums, "min-w-0 flex-1 truncate")}>
                    {surface.cssVar}
                  </span>
                  <span className={cn(dsText.meta, "shrink-0 text-[color:var(--ds-fg-muted)]")}>
                    {surface.use}
                  </span>
                </div>
              ))}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <span className={cn(dsText.title, "font-semibold")}>Elevation</span>
            </CardHeader>
            {/* on the darkest surface — a black shadow is invisible on the
                plane it is cast from */}
            <CardBody className="m-[var(--ds-space-cozy)] mt-0 flex items-end gap-[var(--ds-space-cozy)] rounded-[var(--ds-radius-md)] bg-[var(--ds-surface-page)]">
              {ELEVATIONS.map((item) => (
                <span key={item.name} className="flex flex-col items-center gap-[var(--ds-space-snug)]">
                  <span
                    className={cn(
                      "size-12 rounded-[var(--ds-radius-lg)] border border-[color:var(--ds-border)] bg-[var(--ds-surface-1)]",
                      item.cls,
                    )}
                  />
                  <span className={cn(dsText.micro, "text-[color:var(--ds-fg-muted)]")}>{item.name}</span>
                </span>
              ))}
            </CardBody>
          </Card>
        </div>
      </div>
    </Section>
  );
}
