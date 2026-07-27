import { useCallback, useMemo, useState } from "react";
import {
  ArrowLeft,
  Boxes,
  Camera,
  Cog,
  Database,
  FolderTree,
  Gauge,
  Info,
  Link2,
  Lock,
  Monitor,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Badge,
  Banner,
  BulletList,
  Button,
  Card,
  CardBase,
  CardBody,
  Chip,
  IconButton,
  Input,
  MetaLine,
  Panel,
  PanelBody,
  PanelHeader,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ProgressBar,
  Refusal,
  SectionLabel,
  Select,
  Separator,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Well,
  dsFocus,
  dsIcon,
  dsMotion,
  dsText,
} from "./demo-ui";
import {
  DEMO_BUDGETS,
  DEMO_ENVIRONMENT_FACTS,
  DEMO_LANE_BUDGET,
  DEMO_SETTINGS,
  DEMO_SYSTEM_BEHAVIOUR,
  DEMO_SYSTEM_URLS,
  SETTING_GROUPS,
  SETTING_SOURCE_LABEL,
  SETTING_SOURCE_NOTE,
  settingOrigin,
  settingsInGroup,
  storageSnapshot,
  submitEnvironmentOverride,
  submitSettingChanges,
  type EnvironmentFactWire,
  type SettingGroupKey,
  type SettingLeafWire,
  type SettingSaveResult,
  type SettingSource,
  type StorageMode,
} from "./demo-settings-wire";

/**
 * DEV-ONLY — the rebuild demo's SETTINGS surface.
 *
 * Two things this page is, and one thing it stopped being.
 *
 * **It is a provenance surface.** A setting's value is not the interesting part
 * — its PROVENANCE is. Precedence is `env var > settings.json > code default`,
 * so the operator's real question is "why is this 4 when I typed 3". Every leaf
 * shows all three layers, which one won, and the literal place the winning
 * value came from.
 *
 * **It is a transaction.** The draft is owned by the PAGE and keyed by leaf, so
 * a section switch cannot silently strand an edit in a remounted component, and
 * Save submits every dirty leaf at once and answers about every one of them.
 * The previous version kept its draft in a section component that React reused
 * across sections, and its Save submitted `dirty[0]` and cleared the rest —
 * under a footer reading "3 unsaved changes".
 *
 * **It stopped being where you go to do things that are not settings.** The
 * version registry and both bump commands went to the Archive (a page called
 * Settings should not be where you archive production runs); the doctor became
 * a standing Top Bar indicator; the three full-page launchers became the Top
 * Bar's own page switcher; the demo's storage fixture switch went behind the
 * demo badge. What is left is eight editable leaves and a read-only Status
 * group for the things that are facts rather than preferences.
 */

// ---------------------------------------------------------------------------
// Section model
// ---------------------------------------------------------------------------

export type SettingsSectionKey =
  | SettingGroupKey
  | "environment"
  | "behaviour"
  | "system-urls"
  | "budgets"
  | "storage";

interface SectionSpec {
  key: SettingsSectionKey;
  label: string;
  icon: typeof Cog;
  blurb: string;
  /** status sections describe what IS; they never save */
  status?: boolean;
}

const GROUP_ICON: Record<SettingGroupKey, typeof Cog> = {
  general: Cog,
  display: Monitor,
  performance: Gauge,
  paths: FolderTree,
};

const EDITABLE_SECTIONS: SectionSpec[] = SETTING_GROUPS.map((group) => ({
  key: group.key,
  label: group.label,
  icon: GROUP_ICON[group.key],
  blurb: group.blurb,
}));

const STATUS_SECTIONS: SectionSpec[] = [
  {
    key: "environment",
    label: "Environment & identity",
    icon: Lock,
    blurb: "Values the deployment owns. Visible, and not yours to set.",
    status: true,
  },
  {
    key: "behaviour",
    label: "System behaviour",
    icon: Cog,
    blurb: "Constants the product runs by, and the reason each one is not a preference.",
    status: true,
  },
  {
    key: "system-urls",
    label: "System hosts",
    icon: Link2,
    blurb: "Which machine each system resolves to. Choosing between them is a per-run question, asked in the run modal.",
    status: true,
  },
  {
    key: "budgets",
    label: "Performance budgets",
    icon: Boxes,
    blurb: "Executor lanes and per-system concurrency caps. Pool mode is a property of the system, not a preference.",
    status: true,
  },
  {
    key: "storage",
    label: "Storage health",
    icon: Database,
    blurb: "Authority generation, integrity, backup age, and the read-only degraded mode.",
    status: true,
  },
];

const SECTIONS: SectionSpec[] = [...EDITABLE_SECTIONS, ...STATUS_SECTIONS];

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

const SOURCE_TONE: Record<SettingSource, "warning" | "info" | "neutral"> = {
  env: "warning",
  settings: "info",
  default: "neutral",
};

function SourceBadge({ source }: { source: SettingSource }) {
  return (
    <Badge tone={SOURCE_TONE[source]} title={SETTING_SOURCE_NOTE[source]}>
      {SETTING_SOURCE_LABEL[source]}
    </Badge>
  );
}

interface ProvenanceLayers {
  env?: { name: string; value: string };
  settings?: string;
  default: string;
}

/**
 * All three layers, with the winner marked. The losers are shown struck through
 * rather than hidden — "settings.json says 3 and it is not winning" is the fact
 * the operator came here for.
 */
function ProvenanceStack({ layers, source, origin }: { layers: ProvenanceLayers; source: SettingSource; origin: string }) {
  const rows: { source: SettingSource; label: string; value: string | undefined }[] = [
    { source: "env", label: layers.env?.name ?? "env var", value: layers.env?.value },
    { source: "settings", label: "settings.json", value: layers.settings },
    { source: "default", label: "code default", value: layers.default },
  ];
  return (
    <div className="flex min-w-0 flex-col gap-[var(--ds-space-hair)]">
      {rows.map((layer) => {
        const set = layer.value !== undefined;
        const won = set && source === layer.source;
        return (
          <div key={layer.source} className="flex min-w-0 items-baseline gap-[var(--ds-space-snug)]">
            <span className={cn(dsText.micro, "w-24 shrink-0 truncate text-[color:var(--ds-fg-muted)]")}>{layer.label}</span>
            <span
              className={cn(
                dsText.meta,
                dsText.nums,
                "min-w-0 truncate",
                !set && "text-[color:var(--ds-fg-faint)]",
                set && !won && "text-[color:var(--ds-fg-faint)] line-through",
                won && "font-semibold text-[color:var(--ds-fg)]",
              )}
            >
              {set ? layer.value || "(empty)" : "not set"}
            </span>
            {won && <span className={cn(dsText.micro, "shrink-0 text-[color:var(--ds-status-waiting-fg)]")}>in effect</span>}
          </div>
        );
      })}
      <span className={cn(dsText.micro, "truncate text-[color:var(--ds-fg-faint)]")} title={origin}>
        from {origin}
      </span>
    </div>
  );
}

/**
 * The ⓘ. Everything this page used to print as a paragraph under a control now
 * lives behind one of these — a rule of the product is teaching, and teaching
 * costs the same pixels every time it is drawn whether or not anyone needed it.
 */
function WhatItDoes({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton size="xs" variant="ghost" label={`What ${title} does`} icon={<Info aria-hidden className={dsIcon.sm} />} />
      </PopoverTrigger>
      <PopoverContent title={title} width="md">
        <p className={cn(dsText.body, "text-[color:var(--ds-fg-secondary)]")}>{children}</p>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function ResultSurface({ result, onDismiss }: { result: SettingSaveResult; onDismiss: () => void }) {
  const dismiss = (
    <Button size="sm" variant="ghost" onClick={onDismiss}>
      Dismiss
    </Button>
  );
  const outcomes =
    result.outcomes.length > 0 ? (
      <Well className="mt-[var(--ds-space-base)]">
        <ul className="flex flex-col gap-[var(--ds-space-tight)]">
          {result.outcomes.map((outcome) => (
            <li key={outcome.key} className="flex min-w-0 items-baseline gap-[var(--ds-space-snug)]">
              <span
                className={cn(
                  dsText.caps,
                  "w-14 shrink-0",
                  outcome.state === "applied"
                    ? "text-[color:var(--ds-success-fg)]"
                    : "text-[color:var(--ds-danger)]",
                )}
              >
                {outcome.state === "applied" ? "saved" : "refused"}
              </span>
              <span className={cn(dsText.body, "shrink-0 font-medium text-[color:var(--ds-fg)]")}>{outcome.label}</span>
              <span className={cn(dsText.body, "min-w-0 flex-1 text-[color:var(--ds-fg-muted)]")}>{outcome.detail}</span>
              {outcome.code && (
                <span className={cn(dsText.micro, dsText.nums, "shrink-0 text-[color:var(--ds-danger)]")}>{outcome.code}</span>
              )}
            </li>
          ))}
        </ul>
      </Well>
    ) : null;

  if (result.state === "applied") {
    return (
      <Banner tone="success" title={result.headline} action={dismiss}>
        {result.detail}
        {outcomes}
      </Banner>
    );
  }
  if (!result.code) {
    return (
      <Banner tone="danger" title={result.headline} action={dismiss}>
        {result.detail} Nothing was saved — but the server sent no refusal code, so there is nothing here to quote in a bug
        report.
      </Banner>
    );
  }
  return (
    <Refusal title={result.headline} code={result.code} outcome="nothing was saved" action={dismiss}>
      {result.detail}
      {outcomes}
    </Refusal>
  );
}

// ---------------------------------------------------------------------------
// Editable leaf section
// ---------------------------------------------------------------------------

/** the numeric value a hazard is judged against, or null when it is not a number */
function hazardLevel(leaf: SettingLeafWire, value: string): "none" | "standing" | "over" {
  if (!leaf.hazard) return "none";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "standing";
  return parsed > leaf.hazard.safeMax ? "over" : "standing";
}

function LeafControl({
  leaf,
  value,
  onChange,
}: {
  leaf: SettingLeafWire;
  value: string;
  onChange: (next: string) => void;
}) {
  if (leaf.control.kind === "enum") {
    return (
      <Select aria-label={`${leaf.label} value`} value={value} onChange={(event) => onChange(event.target.value)} className="max-w-[280px]">
        {leaf.control.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    );
  }
  if (leaf.control.kind === "number") {
    return (
      <Input
        aria-label={`${leaf.label} value`}
        type="number"
        inputMode="numeric"
        min={leaf.control.min}
        max={leaf.control.max}
        step={leaf.control.step ?? 1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="max-w-[140px]"
      />
    );
  }
  return (
    <Input
      aria-label={`${leaf.label} value`}
      type={leaf.control.kind === "date" ? "date" : "text"}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="max-w-[280px]"
    />
  );
}

function LeafCard({
  leaf,
  value,
  dirty,
  onChange,
}: {
  leaf: SettingLeafWire;
  value: string;
  dirty: boolean;
  onChange: (next: string) => void;
}) {
  const hazard = hazardLevel(leaf, value);
  return (
    <Card tone={hazard === "over" ? "attention" : "default"}>
      <CardBody className="grid grid-cols-1 gap-[var(--ds-space-cozy)] min-[900px]:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-[var(--ds-space-snug)]">
          <div className="flex min-w-0 flex-wrap items-center gap-[var(--ds-space-snug)]">
            <span className={cn(dsText.ui, "font-semibold text-[color:var(--ds-fg)]")}>{leaf.label}</span>
            <WhatItDoes title={leaf.label}>{leaf.note}</WhatItDoes>
            <SourceBadge source={leaf.source} />
            {/* A hazard marker at rest, on the ONE leaf that has one. The
                caution vocabulary used to be spent entirely on values the
                operator could not change. */}
            {leaf.hazard && (
              <Badge tone="warning" title={leaf.hazard.consequence}>
                <TriangleAlert aria-hidden className={dsIcon.sm} />
                hazard
              </Badge>
            )}
            {dirty && (
              <Badge tone="info" title="Typed, not yet saved. It is included in the page's Save.">
                unsaved
              </Badge>
            )}
            <span className={cn(dsText.micro, dsText.nums, "ml-auto text-[color:var(--ds-fg-faint)]")}>{leaf.key}</span>
          </div>

          <div className="flex flex-wrap items-center gap-[var(--ds-space-snug)]">
            <LeafControl leaf={leaf} value={value} onChange={onChange} />
            {leaf.unit && <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>{leaf.unit}</span>}
            {leaf.control.kind === "number" && (
              <span className={cn(dsText.micro, dsText.nums, "text-[color:var(--ds-fg-faint)]")}>
                {leaf.control.min}–{leaf.hazard ? leaf.hazard.safeMax : leaf.control.max}
                {leaf.hazard ? ` safe · ${leaf.control.max} max` : " accepted"}
              </span>
            )}
          </div>

          {/* A hazard is an outcome, not teaching, so it is exempt from the
              no-prose rule — and it escalates only once the drafted value is
              actually past the safe bound. */}
          {hazard === "over" && leaf.hazard && (
            <Banner
              tone="warning"
              title={`Above ${leaf.hazard.safeMax}${leaf.unit ? ` ${leaf.unit}` : ""}, this can put wrong data into a real record`}
              icon={<TriangleAlert aria-hidden className={dsIcon.lg} />}
            >
              <span className="flex flex-col gap-[var(--ds-space-tight)]">
                <span>{leaf.hazard.consequence}</span>
                <span className="text-[color:var(--ds-fg-muted)]">{leaf.hazard.detection}</span>
              </span>
            </Banner>
          )}
        </div>

        <div className="min-w-0 border-t pt-[var(--ds-space-base)] border-[color:var(--ds-border-subtle)] min-[900px]:border-l min-[900px]:border-t-0 min-[900px]:pl-[var(--ds-space-cozy)] min-[900px]:pt-0">
          <SectionLabel className="mb-[var(--ds-space-snug)]">Provenance</SectionLabel>
          <ProvenanceStack layers={leaf.layers} source={leaf.source} origin={settingOrigin(leaf)} />
        </div>
      </CardBody>
    </Card>
  );
}

function LeafSection({
  section,
  draft,
  onDraft,
}: {
  section: SectionSpec;
  draft: Record<string, string>;
  onDraft: (key: string, value: string) => void;
}) {
  const leaves = settingsInGroup(section.key as SettingGroupKey);
  return (
    <Panel className="min-h-0 flex-1">
      <PanelHeader
        title={section.label}
        subtitle={section.blurb}
        icon={<section.icon aria-hidden className={dsIcon.lg} />}
        meta={`${leaves.length} setting${leaves.length === 1 ? "" : "s"}`}
      />
      <PanelBody className="flex flex-col gap-[var(--ds-space-cozy)] p-[var(--ds-space-cozy)]">
        {leaves.map((leaf) => (
          <LeafCard
            key={leaf.key}
            leaf={leaf}
            value={draft[leaf.key] ?? leaf.effective}
            dirty={draft[leaf.key] !== undefined && draft[leaf.key] !== leaf.effective}
            onChange={(next) => onDraft(leaf.key, next)}
          />
        ))}
      </PanelBody>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Status: environment & identity
// ---------------------------------------------------------------------------

function EnvironmentSection({
  storage,
  onResult,
}: {
  storage: StorageMode;
  onResult: (result: SettingSaveResult) => void;
}) {
  return (
    <Panel className="min-h-0 flex-1">
      <PanelHeader
        title="Environment & identity"
        subtitle={STATUS_SECTIONS[0].blurb}
        icon={<Lock aria-hidden className={dsIcon.lg} />}
        meta={`${DEMO_ENVIRONMENT_FACTS.length} values`}
      />
      <PanelBody className="flex flex-col gap-[var(--ds-space-cozy)] p-[var(--ds-space-cozy)]">
        {DEMO_ENVIRONMENT_FACTS.map((fact) => (
          <EnvironmentCard key={fact.key} fact={fact} storage={storage} onResult={onResult} />
        ))}
      </PanelBody>
    </Panel>
  );
}

function EnvironmentCard({
  fact,
  storage,
  onResult,
}: {
  fact: EnvironmentFactWire;
  storage: StorageMode;
  onResult: (result: SettingSaveResult) => void;
}) {
  return (
    <Card>
      <CardBody className="grid grid-cols-1 gap-[var(--ds-space-cozy)] min-[900px]:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-[var(--ds-space-snug)]">
          <div className="flex min-w-0 flex-wrap items-center gap-[var(--ds-space-snug)]">
            <span className={cn(dsText.ui, "font-semibold text-[color:var(--ds-fg)]")}>{fact.label}</span>
            <SourceBadge source={fact.source} />
            <span className={cn(dsText.micro, dsText.nums, "ml-auto text-[color:var(--ds-fg-faint)]")}>{fact.key}</span>
          </div>
          {/* Flat text with a lock and no box: the pair "you may change this" /
              "you may not" is told apart by SHAPE, never by a disabled input. */}
          <div className="flex min-w-0 items-center gap-[var(--ds-space-snug)]">
            <Lock aria-hidden className={cn(dsIcon.sm, "shrink-0 text-[color:var(--ds-fg-muted)]")} />
            <span className={cn(dsText.ui, dsText.nums, "min-w-0 truncate text-[color:var(--ds-fg)]")}>{fact.effective}</span>
          </div>
          <p
            className={cn(
              dsText.meta,
              "flex max-w-[86ch] items-start gap-[var(--ds-space-tight)] text-[color:var(--ds-status-waiting-fg)]",
            )}
          >
            <ShieldAlert aria-hidden className={cn(dsIcon.sm, "mt-px shrink-0")} />
            <span>{fact.reason}</span>
          </p>
          <CardBase className="flex flex-wrap items-center gap-[var(--ds-space-base)] pt-[var(--ds-space-tight)]">
            <span className={cn(dsText.meta, "min-w-0 flex-1 text-[color:var(--ds-fg-muted)]")}>{fact.toChangeIt}</span>
            <Button
              size="sm"
              variant="outline"
              icon={<ShieldAlert aria-hidden className={dsIcon.sm} />}
              onClick={() => onResult(submitEnvironmentOverride(fact, storage))}
            >
              Try to set it anyway
            </Button>
          </CardBase>
        </div>
        <div className="min-w-0 border-t pt-[var(--ds-space-base)] border-[color:var(--ds-border-subtle)] min-[900px]:border-l min-[900px]:border-t-0 min-[900px]:pl-[var(--ds-space-cozy)] min-[900px]:pt-0">
          <SectionLabel className="mb-[var(--ds-space-snug)]">Provenance</SectionLabel>
          <ProvenanceStack
            layers={fact.layers}
            source={fact.source}
            origin={
              fact.source === "env"
                ? `${fact.layers.env?.name ?? "environment"} · process environment`
                : `src/config.ts → ${fact.key}`
            }
          />
        </div>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Status: system behaviour
// ---------------------------------------------------------------------------

function BehaviourSection() {
  const groups = useMemo(() => {
    const map = new Map<string, typeof DEMO_SYSTEM_BEHAVIOUR>();
    for (const entry of DEMO_SYSTEM_BEHAVIOUR) map.set(entry.group, [...(map.get(entry.group) ?? []), entry]);
    return [...map.entries()];
  }, []);
  return (
    <Panel className="min-h-0 flex-1">
      <PanelHeader
        title="System behaviour"
        subtitle={STATUS_SECTIONS[1].blurb}
        icon={<Camera aria-hidden className={dsIcon.lg} />}
        meta={`${DEMO_SYSTEM_BEHAVIOUR.length} constants`}
      />
      <PanelBody className="flex flex-col gap-[var(--ds-space-cozy)] p-[var(--ds-space-cozy)]">
        {groups.map(([group, entries]) => (
          <div key={group} className="flex min-w-0 flex-col gap-[var(--ds-space-snug)]">
            <SectionLabel>{group}</SectionLabel>
            <Table label={`${group} constants`}>
              <THead>
                <TR>
                  <TH>Value</TH>
                  <TH align="right">In effect</TH>
                  <TH>Why it is not a preference</TH>
                </TR>
              </THead>
              <TBody>
                {entries.map((entry) => (
                  <TR key={entry.label}>
                    <TD>{entry.label}</TD>
                    <TD align="right" numeric>
                      {entry.value}
                    </TD>
                    <TD className="max-w-[520px]">{entry.notYours}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        ))}
      </PanelBody>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Status: system hosts
// ---------------------------------------------------------------------------

function SystemUrlsSection() {
  const withTest = DEMO_SYSTEM_URLS.filter((entry) => entry.testUrl).length;
  return (
    <Panel className="min-h-0 flex-1">
      <PanelHeader
        title="System hosts"
        subtitle={STATUS_SECTIONS[2].blurb}
        icon={<Link2 aria-hidden className={dsIcon.lg} />}
        meta={`${withTest} of ${DEMO_SYSTEM_URLS.length} have a test host`}
      />
      <PanelBody className="flex flex-col">
        <Banner tone="info" title="Choosing between these is a per-run decision" className="m-[var(--ds-space-cozy)]">
          The run modal picks the instance per system, prints the host it resolves to, and stamps a <strong>test</strong> badge
          on every row the start creates. A standing global override would redirect every future run with no expiry and nothing
          on screen to say so.
        </Banner>
        <Table label="System entry hosts">
          <THead>
            <TR>
              <TH>System</TH>
              <TH>Production</TH>
              <TH>Test</TH>
            </TR>
          </THead>
          <TBody>
            {DEMO_SYSTEM_URLS.map((entry) => (
              <TR key={entry.system}>
                <TD>
                  <span className="flex min-w-0 flex-col">
                    <span className={cn(dsText.ui, "text-[color:var(--ds-fg)]")}>{entry.label}</span>
                    <span className={cn(dsText.micro, "text-[color:var(--ds-fg-muted)]")}>{entry.note}</span>
                  </span>
                </TD>
                <TD numeric className="max-w-[260px] truncate">
                  {entry.productionUrl}
                </TD>
                <TD numeric className="max-w-[260px] truncate">
                  {entry.testUrl ?? <span className={cn(dsText.meta, "text-[color:var(--ds-fg-faint)]")}>none provisioned</span>}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </PanelBody>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Status: performance budgets
// ---------------------------------------------------------------------------

function BudgetsSection() {
  return (
    <Panel className="min-h-0 flex-1">
      <PanelHeader
        title="Performance budgets"
        subtitle="What the executor is allowed to hold at once. A cap that is full is why a queued row is not moving."
        icon={<Boxes aria-hidden className={dsIcon.lg} />}
        meta={`${DEMO_LANE_BUDGET.inUse} of ${DEMO_LANE_BUDGET.cap} lanes in use`}
      />
      <PanelBody className="flex flex-col gap-[var(--ds-space-cozy)] p-[var(--ds-space-cozy)]">
        <Card>
          <CardBody className="flex flex-col gap-[var(--ds-space-snug)]">
            <div className="flex items-baseline gap-[var(--ds-space-base)]">
              <span className={cn(dsText.title, "font-semibold text-[color:var(--ds-fg)]")}>Executor lanes</span>
              <span className={cn(dsText.display, dsText.nums, "ml-auto text-[color:var(--ds-fg)]")}>
                {DEMO_LANE_BUDGET.inUse}/{DEMO_LANE_BUDGET.cap}
              </span>
            </div>
            <ProgressBar
              label="Executor lanes in use"
              value={DEMO_LANE_BUDGET.inUse}
              max={DEMO_LANE_BUDGET.cap}
              tone={DEMO_LANE_BUDGET.inUse >= DEMO_LANE_BUDGET.cap ? "warning" : "accent"}
            />
            <p className={cn(dsText.body, "text-[color:var(--ds-fg-muted)]")}>{DEMO_LANE_BUDGET.note}</p>
          </CardBody>
        </Card>

        <Table label="Per-system concurrency caps">
          <THead>
            <TR>
              <TH>System</TH>
              <TH>Pool mode</TH>
              <TH align="right">In use</TH>
              <TH align="right">Cap</TH>
              <TH>Why</TH>
            </TR>
          </THead>
          <TBody>
            {DEMO_BUDGETS.map((budget) => (
              <TR key={budget.system}>
                <TD>{budget.label}</TD>
                <TD>
                  <Chip tone={budget.poolMode === "single" ? "warning" : "neutral"}>{budget.poolMode}</Chip>
                </TD>
                <TD align="right" numeric className={budget.inUse >= budget.cap ? "text-[color:var(--ds-status-waiting-fg)]" : undefined}>
                  {budget.inUse}
                </TD>
                <TD align="right" numeric>
                  {budget.cap}
                </TD>
                <TD className="max-w-[380px]">{budget.reason}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </PanelBody>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Status: storage health
// ---------------------------------------------------------------------------

function StorageSection({ storage }: { storage: StorageMode }) {
  const snapshot = storageSnapshot(storage);
  const degraded = snapshot.mode === "read-only-degraded";
  const newest = snapshot.backups[0];
  return (
    <Panel className="min-h-0 flex-1">
      <PanelHeader
        title="Storage health"
        subtitle="The tracker volume, the authority generation, and the backups a restore would use."
        icon={<Database aria-hidden className={dsIcon.lg} />}
        meta={`newest backup ${newest.ageLabel}`}
      />
      <PanelBody className="flex flex-col gap-[var(--ds-space-cozy)] p-[var(--ds-space-cozy)]">
        <Banner tone={degraded ? "danger" : "success"} title={degraded ? "Read-only — degraded" : "Read-write — healthy"}>
          {snapshot.reason ?? snapshot.integrity}
        </Banner>

        {/* Three stat cards read across as a row: label, then the number, then
            the note about it. The notes run one and two lines, so each is
            pinned to the card's base — otherwise the middle card's note ended
            a line below its neighbours' and the row lost its bottom edge. */}
        <div className="grid grid-cols-1 gap-[var(--ds-space-base)] min-[820px]:grid-cols-3">
          <Card>
            <CardBody grow className="flex flex-col gap-[var(--ds-space-hair)]">
              <SectionLabel>Authority generation</SectionLabel>
              <span className={cn(dsText.display, dsText.nums, "text-[color:var(--ds-fg)]")}>{snapshot.authorityGeneration}</span>
              <CardBase className="pt-[var(--ds-space-hair)]">
                <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
                  The SQLite task store's generation — every command's CAS token descends from it.
                </span>
              </CardBase>
            </CardBody>
          </Card>
          <Card>
            <CardBody grow className="flex flex-col gap-[var(--ds-space-hair)]">
              <SectionLabel>Rows on disk</SectionLabel>
              <span className={cn(dsText.display, dsText.nums, "text-[color:var(--ds-fg)]")}>
                {snapshot.rowsOnDisk.toLocaleString()}
              </span>
              <CardBase className="pt-[var(--ds-space-hair)]">
                <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
                  Across every day the tracker still holds. Notes and spans prune at 30 days; the ledger never prunes.
                </span>
              </CardBase>
            </CardBody>
          </Card>
          <Card>
            <CardBody grow className="flex flex-col gap-[var(--ds-space-hair)]">
              <SectionLabel>Newest backup</SectionLabel>
              <span className={cn(dsText.display, dsText.nums, "text-[color:var(--ds-fg)]")}>{newest.ageLabel}</span>
              <CardBase className="pt-[var(--ds-space-hair)]">
                <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
                  Integrity {degraded ? "last checked" : "verified"} {snapshot.integrityCheckedAt}.
                </span>
              </CardBase>
            </CardBody>
          </Card>
        </div>

        <Table label="Backups">
          <THead>
            <TR>
              <TH>Taken</TH>
              <TH>Age</TH>
              <TH align="right">Size</TH>
              <TH>Verdict</TH>
              <TH>Note</TH>
            </TR>
          </THead>
          <TBody>
            {snapshot.backups.map((backup) => (
              <TR key={backup.id}>
                <TD numeric>{backup.takenAt}</TD>
                <TD numeric>{backup.ageLabel}</TD>
                <TD align="right" numeric>
                  {backup.sizeLabel}
                </TD>
                <TD>
                  <Badge tone={backup.verdict === "verified" ? "success" : backup.verdict === "stale" ? "warning" : "danger"}>
                    {backup.verdict}
                  </Badge>
                </TD>
                <TD className="max-w-[420px]">{backup.note}</TD>
              </TR>
            ))}
          </TBody>
        </Table>

        {degraded && (
          <div className="grid grid-cols-1 gap-[var(--ds-space-base)] min-[820px]:grid-cols-2">
            <Card>
              <CardBody className="flex flex-col gap-[var(--ds-space-snug)]">
                <SectionLabel>Still works</SectionLabel>
                <BulletList items={snapshot.stillWorks} />
              </CardBody>
            </Card>
            <Card tone="danger">
              <CardBody className="flex flex-col gap-[var(--ds-space-snug)]">
                <SectionLabel>Does not work</SectionLabel>
                <BulletList items={snapshot.blocked} />
              </CardBody>
            </Card>
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export function DemoSettingsPage({ storage, onBack }: { storage: StorageMode; onBack: () => void }) {
  const [active, setActive] = useState<SettingsSectionKey>("general");
  const [result, setResult] = useState<SettingSaveResult | null>(null);
  /**
   * The draft is PAGE state, keyed by leaf. It used to live inside the section
   * component, which React reused across every group because they render into
   * the same JSX slot — so an edit made in General survived a trip to Display as
   * invisible state nobody had said would be kept. Owning it here makes the
   * carry-over a designed behaviour instead of a React accident: the nav marks
   * every section holding one, and the action bar counts all of them.
   */
  const [draft, setDraft] = useState<Record<string, string>>({});

  const section = SECTIONS.find((entry) => entry.key === active) ?? SECTIONS[0];

  const dirtyLeaves = useMemo(
    () => DEMO_SETTINGS.filter((leaf) => draft[leaf.key] !== undefined && draft[leaf.key] !== leaf.effective),
    [draft],
  );

  const dirtyByGroup = useMemo(() => {
    const map = new Map<SettingGroupKey, number>();
    for (const leaf of dirtyLeaves) map.set(leaf.group, (map.get(leaf.group) ?? 0) + 1);
    return map;
  }, [dirtyLeaves]);

  const setDraftValue = useCallback((key: string, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  const save = useCallback(() => {
    const saved = submitSettingChanges(
      dirtyLeaves.map((leaf) => ({ leaf, value: draft[leaf.key] ?? leaf.effective })),
      storage,
    );
    setResult(saved);
    // Only the leaves the server actually took leave the draft. A refused value
    // stays in the form so it can be fixed — it is never silently dropped.
    const appliedKeys = new Set(saved.outcomes.filter((o) => o.state === "applied").map((o) => o.key));
    setDraft((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => !appliedKeys.has(key))));
  }, [dirtyLeaves, draft, storage]);

  return (
    <div className="flex min-h-0 flex-1">
      <nav
        aria-label="Settings sections"
        className="flex w-[220px] shrink-0 flex-col gap-[var(--ds-space-hair)] overflow-y-auto border-r border-[color:var(--ds-border)] bg-[var(--ds-surface-1)] p-[var(--ds-space-base)]"
      >
        <Button variant="ghost" size="sm" icon={<ArrowLeft aria-hidden className={dsIcon.md} />} onClick={onBack} className="justify-start">
          Back to the dashboard
        </Button>
        <Separator className="my-[var(--ds-space-tight)]" />
        <SectionLabel className="px-[var(--ds-space-base)] py-[var(--ds-space-tight)]">Settings</SectionLabel>
        {EDITABLE_SECTIONS.map((entry) => (
          <SectionButton
            key={entry.key}
            entry={entry}
            active={active === entry.key}
            dirty={dirtyByGroup.get(entry.key as SettingGroupKey) ?? 0}
            onClick={() => setActive(entry.key)}
          />
        ))}
        <SectionLabel className="px-[var(--ds-space-base)] pb-[var(--ds-space-tight)] pt-[var(--ds-space-cozy)]">Status</SectionLabel>
        {STATUS_SECTIONS.map((entry) => (
          <SectionButton key={entry.key} entry={entry} active={active === entry.key} dirty={0} onClick={() => setActive(entry.key)} />
        ))}
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-[var(--ds-space-base)] p-[var(--ds-space-cozy)]">
        {result && <ResultSurface result={result} onDismiss={() => setResult(null)} />}
        {storage === "read-only-degraded" && !result && (
          <Banner tone="danger" title="Storage is read-only — no setting can be saved">
            A save from here will be refused by the server, not applied silently. Status → Storage health says what else is
            blocked.
          </Banner>
        )}

        {section.key === "environment" ? (
          <EnvironmentSection storage={storage} onResult={setResult} />
        ) : section.key === "behaviour" ? (
          <BehaviourSection />
        ) : section.key === "system-urls" ? (
          <SystemUrlsSection />
        ) : section.key === "budgets" ? (
          <BudgetsSection />
        ) : section.key === "storage" ? (
          <StorageSection storage={storage} />
        ) : (
          <LeafSection section={section} draft={draft} onDraft={setDraftValue} />
        )}

        {/* One action bar for the whole page, because the draft is the whole
            page's. It appears only when there is something to answer for, and
            it names WHERE the changes are so a save never commits an edit the
            operator has scrolled away from without knowing it. */}
        {dirtyLeaves.length > 0 && (
          <div className="flex shrink-0 flex-wrap items-center gap-[var(--ds-space-base)] rounded-[var(--ds-radius-lg)] border border-[color:var(--ds-border-loud)] bg-[var(--ds-surface-2)] px-[var(--ds-space-cozy)] py-[var(--ds-space-base)]">
            <span className={cn(dsText.ui, "font-semibold text-[color:var(--ds-fg)]")}>
              {dirtyLeaves.length} unsaved change{dirtyLeaves.length === 1 ? "" : "s"}
            </span>
            <MetaLine items={[...dirtyByGroup.entries()].map(([group, count]) => `${SETTING_GROUPS.find((g) => g.key === group)?.label ?? group} ${count}`)} />
            <span className="ml-auto flex items-center gap-[var(--ds-space-base)]">
              <Button variant="ghost" size="sm" onClick={() => setDraft({})}>
                Discard all
              </Button>
              <Button variant="primary" size="sm" onClick={save}>
                Save {dirtyLeaves.length} change{dirtyLeaves.length === 1 ? "" : "s"}
              </Button>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function SectionButton({
  entry,
  active,
  dirty,
  onClick,
}: {
  entry: SectionSpec;
  active: boolean;
  dirty: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "flex min-w-0 items-center gap-[var(--ds-space-snug)] rounded-[var(--ds-radius-md)] px-[var(--ds-space-base)] py-[var(--ds-space-snug)] text-left",
        dsText.ui,
        dsFocus,
        dsMotion.base,
        active
          ? "bg-[var(--ds-surface-selected)] font-semibold text-[color:var(--ds-fg)]"
          : "text-[color:var(--ds-fg-muted)] hover:bg-[var(--ds-surface-3)] hover:text-[color:var(--ds-fg)]",
      )}
    >
      <entry.icon aria-hidden className={cn(dsIcon.md, "shrink-0")} />
      <span className="truncate">{entry.label}</span>
      {dirty > 0 && (
        <span
          title={`${dirty} unsaved change${dirty === 1 ? "" : "s"} in ${entry.label}`}
          className={cn(dsText.micro, dsText.nums, "ml-auto shrink-0 text-[color:var(--ds-status-waiting-fg)]")}
        >
          {dirty} unsaved
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// The degraded banner — mounted app-wide, not just in Settings
// ---------------------------------------------------------------------------

/**
 * A degraded dashboard has to say so everywhere, not only on the page that
 * explains it. The copy is the served snapshot's own `stillWorks` / `blocked`
 * lists, because "what still works" is the only useful thing to say — a banner
 * that just says "degraded" makes the operator guess whether their next click
 * will be recorded.
 */
export function DemoStorageBanner({ storage, onOpenSettings }: { storage: StorageMode; onOpenSettings: () => void }) {
  const [open, setOpen] = useState(false);
  if (storage !== "read-only-degraded") return null;
  const snapshot = storageSnapshot(storage);
  return (
    <div className="shrink-0 border-b border-[color:var(--ds-danger-border)] bg-[var(--ds-danger-quiet)] px-[var(--ds-space-cozy)] py-[var(--ds-space-base)]">
      <div className="flex min-w-0 flex-wrap items-center gap-[var(--ds-space-base)]">
        <ShieldAlert aria-hidden className={cn(dsIcon.lg, "shrink-0 text-[color:var(--ds-danger)]")} />
        <span className="flex min-w-0 flex-col">
          <span className={cn(dsText.ui, "font-semibold text-[color:var(--ds-fg)]")}>
            Storage is read-only — the dashboard is diagnostic only
          </span>
          <span className={cn(dsText.body, "text-[color:var(--ds-fg-secondary)]")}>{snapshot.reason}</span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-[var(--ds-space-tight)]">
          <Button size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            {open ? "Hide what still works" : "What still works?"}
          </Button>
          <Button size="sm" variant="secondary" onClick={onOpenSettings}>
            Storage health
          </Button>
        </span>
      </div>
      {open && (
        <div className="mt-[var(--ds-space-base)] grid grid-cols-1 gap-[var(--ds-space-base)] min-[820px]:grid-cols-2">
          <Well>
            <SectionLabel className="mb-[var(--ds-space-tight)]">Still works</SectionLabel>
            <BulletList items={snapshot.stillWorks} />
          </Well>
          <Well>
            <SectionLabel className="mb-[var(--ds-space-tight)]">Does not work</SectionLabel>
            <BulletList items={snapshot.blocked} />
          </Well>
        </div>
      )}
    </div>
  );
}
