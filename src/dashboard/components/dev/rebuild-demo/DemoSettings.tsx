import { useMemo, useState } from "react";
import {
  Activity,
  ArrowLeft,
  Archive,
  BadgeCheck,
  Boxes,
  Camera,
  ChartNoAxesColumn,
  Cog,
  Database,
  FolderTree,
  Gauge,
  Link2,
  ListChecks,
  Monitor,
  ShieldAlert,
  Stethoscope,
  Workflow,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Badge,
  Banner,
  Button,
  Card,
  CardBody,
  Chip,
  CountBadge,
  Input,
  Panel,
  PanelBody,
  PanelFooter,
  PanelHeader,
  ProgressBar,
  SectionLabel,
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
  dsText,
} from "./demo-ui";
import {
  DEMO_BUDGETS,
  DEMO_LANE_BUDGET,
  DEMO_PREFLIGHT,
  DEMO_SETTINGS,
  DEMO_SYSTEM_URLS,
  PREFLIGHT_ADVISORY_NOTE,
  SETTING_GROUPS,
  SETTING_SOURCE_LABEL,
  SETTING_SOURCE_NOTE,
  settingLockReason,
  settingOrigin,
  settingsInGroup,
  storageSnapshot,
  submitSettingChange,
  type PreflightVerdict,
  type SettingChangeResult,
  type SettingGroupKey,
  type SettingLeafWire,
  type SettingSource,
  type StorageMode,
} from "./demo-settings-wire";
import {
  allTopLevelRows,
  DEMO_CHANGE_RECORDS,
  deriveVersionRegistry,
  BUMP_SCOPE_LABEL,
} from "./demo-archive-wire";
import { DEMO_APP_VERSION } from "./demo-wire";
import { DemoVersionBumpDialog, type BumpTarget } from "./DemoVersionBump";

/**
 * DEV-ONLY — the rebuild demo's SETTINGS surface.
 *
 * `demo-feature-plan-2026-07-25.md` §1.6 / §2.8 / §3 Tier 4 #14. The gear in
 * the Top Bar was a NOOP; this is what it opens.
 *
 * The load-bearing idea, and the reason this is not a form: **a setting's value
 * is not the interesting part — its PROVENANCE is.** Precedence in this product
 * is `env var > settings.json > code default`, so the operator's real question
 * is "why is this 4 when I typed 3". Every leaf therefore shows all three
 * layers, which one won, and the literal place the winning value came from. A
 * leaf the environment owns renders its control DISABLED with the reason
 * (and an explicit "try anyway" that returns the server's refusal), because a
 * Save that silently loses to an env var is the worst version of this screen.
 *
 * Everything else here is a read of what the backend serves: System URLs
 * (empty = production), the executor's budget caps, the advisory doctor,
 * storage health with backup ages, and the version registry that keys the
 * archive.
 */

// ---------------------------------------------------------------------------
// Section model
// ---------------------------------------------------------------------------

export type SettingsSectionKey =
  | SettingGroupKey
  | "system-urls"
  | "budgets"
  | "preflight"
  | "storage"
  | "versions";

interface SectionSpec {
  key: SettingsSectionKey;
  label: string;
  icon: typeof Cog;
  blurb: string;
  /** reference sections describe what exists; they never save */
  readOnly?: boolean;
}

const GROUP_ICON: Record<SettingGroupKey, typeof Cog> = {
  general: Cog,
  display: Monitor,
  performance: Gauge,
  recovery: Activity,
  capture: Camera,
  paths: FolderTree,
};

const EDITABLE_SECTIONS: SectionSpec[] = SETTING_GROUPS.map((group) => ({
  key: group.key,
  label: group.label,
  icon: GROUP_ICON[group.key],
  blurb: group.blurb,
}));

const SYSTEM_URL_SECTION: SectionSpec = {
  key: "system-urls",
  label: "System URLs",
  icon: Link2,
  blurb: "Per-system entry URLs. Empty means the production default — a value means every run of that system targets a test instance.",
};

const REFERENCE_SECTIONS: SectionSpec[] = [
  {
    key: "budgets",
    label: "Performance budgets",
    icon: Boxes,
    blurb: "Executor lanes and per-system concurrency caps. Pool mode is a property of the system, not a preference.",
    readOnly: true,
  },
  {
    key: "preflight",
    label: "Preflight / doctor",
    icon: Stethoscope,
    blurb: "What would fail before you spend a Duo prompt finding out. Advisory only — it never blocks a run.",
    readOnly: true,
  },
  {
    key: "storage",
    label: "Storage health",
    icon: Database,
    blurb: "Authority generation, integrity, backup age, and the read-only degraded mode.",
    readOnly: true,
  },
  {
    key: "versions",
    label: "Version registry",
    icon: BadgeCheck,
    blurb: "Every workflow's current version, the runs stamped with it, and the bump flow that archives the rest.",
    readOnly: true,
  },
];

/** the pages Settings launches into — same pattern as the Workflow Editor takeover */
export type PeripheryView = "archive" | "explorer" | "report";

const TAKEOVERS: { key: PeripheryView; label: string; icon: typeof Cog; blurb: string }[] = [
  { key: "archive", label: "Archive", icon: Archive, blurb: "Prior-version runs, read-only" },
  { key: "explorer", label: "Explorer", icon: Workflow, blurb: "The workflow graph with a run on it" },
  { key: "report", label: "Activity report", icon: ChartNoAxesColumn, blurb: "The supervisor-facing summary" },
];

const SECTIONS: SectionSpec[] = [...EDITABLE_SECTIONS.slice(0, 2), SYSTEM_URL_SECTION, ...EDITABLE_SECTIONS.slice(2), ...REFERENCE_SECTIONS];

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

/**
 * All three layers, with the winner marked. The losers are shown struck through
 * rather than hidden — "settings.json says 3 and it is not winning" is the fact
 * the operator came here for.
 */
function ProvenanceStack({ leaf }: { leaf: SettingLeafWire }) {
  const layers: { source: SettingSource; label: string; value: string | undefined }[] = [
    { source: "env", label: leaf.layers.env?.name ?? "env var", value: leaf.layers.env?.value },
    { source: "settings", label: "settings.json", value: leaf.layers.settings },
    { source: "default", label: "code default", value: leaf.layers.default },
  ];
  return (
    <div className="flex min-w-0 flex-col gap-[var(--ds-space-hair)]">
      {layers.map((layer) => {
        const set = layer.value !== undefined;
        const won = set && leaf.source === layer.source;
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
            {won && (
              <span className={cn(dsText.micro, "shrink-0 text-[color:var(--ds-status-waiting-fg)]")}>in effect</span>
            )}
          </div>
        );
      })}
      <span className={cn(dsText.micro, "truncate text-[color:var(--ds-fg-faint)]")} title={settingOrigin(leaf)}>
        from {settingOrigin(leaf)}
      </span>
    </div>
  );
}

function ResultBanner({ result, onDismiss }: { result: SettingChangeResult; onDismiss: () => void }) {
  return (
    <Banner
      tone={result.state === "applied" ? "success" : "danger"}
      title={result.headline}
      action={
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      }
    >
      {result.detail}
      {result.code && (
        <span className={cn(dsText.meta, dsText.nums, "ml-[var(--ds-space-snug)] text-[color:var(--ds-fg-muted)]")}>
          code {result.code}
        </span>
      )}
    </Banner>
  );
}

// ---------------------------------------------------------------------------
// Editable leaf section
// ---------------------------------------------------------------------------

function LeafSection({
  section,
  storage,
  onResult,
}: {
  section: SectionSpec;
  storage: StorageMode;
  onResult: (result: SettingChangeResult) => void;
}) {
  const leaves = settingsInGroup(section.key as SettingGroupKey);
  const [draft, setDraft] = useState<Record<string, string>>({});

  const dirty = leaves.filter((leaf) => draft[leaf.key] !== undefined && draft[leaf.key] !== leaf.effective);

  return (
    <Panel className="min-h-0">
      <PanelHeader
        title={section.label}
        subtitle={section.blurb}
        icon={<section.icon aria-hidden className={dsIcon.lg} />}
        meta={`${leaves.length} settings`}
      />
      <PanelBody className="flex flex-col gap-[var(--ds-space-cozy)] p-[var(--ds-space-cozy)]">
        {leaves.map((leaf) => (
          <Card key={leaf.key}>
            <CardBody className="grid grid-cols-1 gap-[var(--ds-space-cozy)] min-[900px]:grid-cols-[minmax(0,1fr)_300px]">
              <div className="flex min-w-0 flex-col gap-[var(--ds-space-snug)]">
                <div className="flex min-w-0 flex-wrap items-center gap-[var(--ds-space-snug)]">
                  <span className={cn(dsText.ui, "font-semibold text-[color:var(--ds-fg)]")}>{leaf.label}</span>
                  <SourceBadge source={leaf.source} />
                  <span className={cn(dsText.micro, dsText.nums, "text-[color:var(--ds-fg-faint)]")}>{leaf.key}</span>
                </div>
                <p className={cn(dsText.body, "text-[color:var(--ds-fg-muted)]")}>{leaf.note}</p>
                <div className="flex flex-wrap items-center gap-[var(--ds-space-snug)]">
                  <Input
                    aria-label={`${leaf.label} value`}
                    value={draft[leaf.key] ?? leaf.effective}
                    disabled={!leaf.editable}
                    onChange={(event) => setDraft((prev) => ({ ...prev, [leaf.key]: event.target.value }))}
                    className="max-w-[280px]"
                  />
                  {leaf.unit && <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>{leaf.unit}</span>}
                  {!leaf.editable && (
                    <Button
                      size="sm"
                      variant="outline"
                      icon={<ShieldAlert aria-hidden className={dsIcon.sm} />}
                      onClick={() => onResult(submitSettingChange(leaf, leaf.effective, storage))}
                    >
                      {leaf.source === "env" ? "Override in settings.json anyway" : "Try to set it anyway"}
                    </Button>
                  )}
                </div>
                {!leaf.editable && (
                  <p className={cn(dsText.meta, "text-[color:var(--ds-status-waiting-fg)]")}>{settingLockReason(leaf)}</p>
                )}
              </div>
              <div className="min-w-0 border-t pt-[var(--ds-space-base)] border-[color:var(--ds-border-subtle)] min-[900px]:border-l min-[900px]:border-t-0 min-[900px]:pl-[var(--ds-space-cozy)] min-[900px]:pt-0">
                <SectionLabel className="mb-[var(--ds-space-snug)]">Provenance</SectionLabel>
                <ProvenanceStack leaf={leaf} />
              </div>
            </CardBody>
          </Card>
        ))}
      </PanelBody>
      <PanelFooter>
        <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
          {dirty.length === 0 ? "No unsaved changes." : `${dirty.length} unsaved change${dirty.length === 1 ? "" : "s"}.`}
        </span>
        <span className="ml-auto flex items-center gap-[var(--ds-space-base)]">
          <Button variant="ghost" size="sm" disabled={dirty.length === 0} onClick={() => setDraft({})}>
            Discard
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={dirty.length === 0}
            onClick={() => {
              const first = dirty[0];
              if (first) onResult(submitSettingChange(first, draft[first.key] ?? first.effective, storage));
              setDraft({});
            }}
          >
            Save changes
          </Button>
        </span>
      </PanelFooter>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// System URLs
// ---------------------------------------------------------------------------

function SystemUrlsSection({ storage, onResult }: { storage: StorageMode; onResult: (r: SettingChangeResult) => void }) {
  const testCount = DEMO_SYSTEM_URLS.filter((entry) => entry.resolved === "test").length;
  return (
    <Panel className="min-h-0">
      <PanelHeader
        title="System URLs"
        subtitle={SYSTEM_URL_SECTION.blurb}
        icon={<Link2 aria-hidden className={dsIcon.lg} />}
        meta={`${testCount} on a test instance`}
      />
      <PanelBody>
        <Banner
          tone={testCount > 0 ? "warning" : "info"}
          title={
            testCount > 0
              ? `${testCount} system is pointed away from production`
              : "Every system is pointed at production"
          }
          className="m-[var(--ds-space-cozy)]"
        >
          A row that touches a test-instance system carries a <strong>test</strong> badge in the queue and on its receipt, so a
          staging run can never be mistaken for a filing. Clearing an override sends that system back to production.
        </Banner>
        <Table label="System entry URLs">
          <THead>
            <TR>
              <TH>System</TH>
              <TH>Production default</TH>
              <TH>Override</TH>
              <TH>Resolves to</TH>
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
                <TD numeric className="max-w-[240px] truncate">
                  {entry.productionUrl}
                </TD>
                <TD>
                  <Input
                    aria-label={`${entry.label} override URL`}
                    defaultValue={entry.override}
                    placeholder="empty = production"
                    className="max-w-[260px]"
                  />
                </TD>
                <TD>
                  {entry.resolved === "test" ? (
                    <Chip tone="warning" label="instance">
                      test
                    </Chip>
                  ) : (
                    <Chip label="instance">prod</Chip>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </PanelBody>
      <PanelFooter>
        <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
          OnBase has no test host provisioned — a test run there is refused at enqueue rather than silently sent to production.
        </span>
        <Button
          className="ml-auto"
          variant="primary"
          size="sm"
          onClick={() =>
            onResult(
              submitSettingChange(
                { ...DEMO_SETTINGS[0], key: "systemUrls.kuali", label: "Kuali URL", editable: true, layers: { default: "" } },
                "https://kuali-stg.ucsd.edu/space/HR",
                storage,
              ),
            )
          }
        >
          Save URLs
        </Button>
      </PanelFooter>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Performance budgets
// ---------------------------------------------------------------------------

function BudgetsSection() {
  return (
    <Panel className="min-h-0">
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
// Preflight / doctor
// ---------------------------------------------------------------------------

const VERDICT_TONE: Record<PreflightVerdict, "success" | "warning" | "danger"> = {
  pass: "success",
  warning: "warning",
  fail: "danger",
};

function PreflightSection() {
  const failing = DEMO_PREFLIGHT.filter((check) => check.verdict === "fail").length;
  const warning = DEMO_PREFLIGHT.filter((check) => check.verdict === "warning").length;
  return (
    <Panel className="min-h-0">
      <PanelHeader
        title="Preflight / doctor"
        subtitle="Advisory only. Nothing here blocks a run — it tells you what will fail before you spend a Duo prompt finding out."
        icon={<Stethoscope aria-hidden className={dsIcon.lg} />}
        meta={`${failing} failing · ${warning} warning`}
      />
      <PanelBody className="flex flex-col gap-[var(--ds-space-base)] p-[var(--ds-space-cozy)]">
        <Banner tone="info" title="A failing check is information, not an error">
          {PREFLIGHT_ADVISORY_NOTE}
        </Banner>
        {DEMO_PREFLIGHT.map((check) => (
          <Card key={check.id} tone={check.verdict === "fail" ? "danger" : "default"}>
            <CardBody className="flex min-w-0 flex-col gap-[var(--ds-space-snug)]">
              <div className="flex min-w-0 flex-wrap items-center gap-[var(--ds-space-snug)]">
                <Badge tone={VERDICT_TONE[check.verdict]}>{check.verdict}</Badge>
                <span className={cn(dsText.ui, "font-semibold text-[color:var(--ds-fg)]")}>{check.label}</span>
                <span className={cn(dsText.meta, dsText.nums, "ml-auto text-[color:var(--ds-fg-muted)]")}>
                  checked {check.checkedAt}
                </span>
              </div>
              <p className={cn(dsText.body, "text-[color:var(--ds-fg-secondary)]")}>{check.detail}</p>
              {check.blocks.length > 0 && (
                <Well>
                  <SectionLabel className="mb-[var(--ds-space-tight)]">What this blocks</SectionLabel>
                  <ul className="flex flex-col gap-[var(--ds-space-hair)]">
                    {check.blocks.map((item) => (
                      <li key={item} className={cn(dsText.body, "text-[color:var(--ds-fg-secondary)]")}>
                        · {item}
                      </li>
                    ))}
                  </ul>
                </Well>
              )}
              {check.remediation && (
                <p className={cn(dsText.body, "text-[color:var(--ds-fg-muted)]")}>
                  <span className="text-[color:var(--ds-fg-secondary)]">Fix: </span>
                  {check.remediation}
                </p>
              )}
            </CardBody>
          </Card>
        ))}
      </PanelBody>
      <PanelFooter>
        <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
          Doctor reads local state only — it opens no browser and spends no Duo prompt.
        </span>
        <Button className="ml-auto" size="sm" variant="secondary" icon={<ListChecks aria-hidden className={dsIcon.md} />}>
          Run doctor again
        </Button>
      </PanelFooter>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Storage health
// ---------------------------------------------------------------------------

function StorageSection({ storage, onStorage }: { storage: StorageMode; onStorage: (mode: StorageMode) => void }) {
  const snapshot = storageSnapshot(storage);
  const degraded = snapshot.mode === "read-only-degraded";
  const newest = snapshot.backups[0];
  return (
    <Panel className="min-h-0">
      <PanelHeader
        title="Storage health"
        subtitle="The tracker volume, the authority generation, and the backups a restore would use."
        icon={<Database aria-hidden className={dsIcon.lg} />}
        meta={`newest backup ${newest.ageLabel}`}
      />
      <PanelBody className="flex flex-col gap-[var(--ds-space-cozy)] p-[var(--ds-space-cozy)]">
        <Banner
          tone={degraded ? "danger" : "success"}
          title={degraded ? "Read-only — degraded" : "Read-write — healthy"}
        >
          {snapshot.reason ?? snapshot.integrity}
        </Banner>

        <div className="grid grid-cols-1 gap-[var(--ds-space-base)] min-[820px]:grid-cols-3">
          <Card>
            <CardBody className="flex flex-col gap-[var(--ds-space-hair)]">
              <SectionLabel>Authority generation</SectionLabel>
              <span className={cn(dsText.display, dsText.nums, "text-[color:var(--ds-fg)]")}>
                {snapshot.authorityGeneration}
              </span>
              <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
                The SQLite task store's generation — every command's CAS token descends from it.
              </span>
            </CardBody>
          </Card>
          <Card>
            <CardBody className="flex flex-col gap-[var(--ds-space-hair)]">
              <SectionLabel>Rows on disk</SectionLabel>
              <span className={cn(dsText.display, dsText.nums, "text-[color:var(--ds-fg)]")}>
                {snapshot.rowsOnDisk.toLocaleString()}
              </span>
              <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
                Across every day the tracker still holds. Notes and spans prune at 30 days; the ledger never prunes.
              </span>
            </CardBody>
          </Card>
          <Card>
            <CardBody className="flex flex-col gap-[var(--ds-space-hair)]">
              <SectionLabel>Newest backup</SectionLabel>
              <span className={cn(dsText.display, dsText.nums, "text-[color:var(--ds-fg)]")}>{newest.ageLabel}</span>
              <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
                Integrity {degraded ? "last checked" : "verified"} {snapshot.integrityCheckedAt}.
              </span>
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
                {snapshot.stillWorks.map((item) => (
                  <p key={item} className={cn(dsText.body, "text-[color:var(--ds-fg-secondary)]")}>
                    · {item}
                  </p>
                ))}
              </CardBody>
            </Card>
            <Card tone="danger">
              <CardBody className="flex flex-col gap-[var(--ds-space-snug)]">
                <SectionLabel>Does not work</SectionLabel>
                {snapshot.blocked.map((item) => (
                  <p key={item} className={cn(dsText.body, "text-[color:var(--ds-fg-secondary)]")}>
                    · {item}
                  </p>
                ))}
              </CardBody>
            </Card>
          </div>
        )}
      </PanelBody>
      <PanelFooter>
        <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
          Demo control — which storage snapshot the mock server returns:
        </span>
        <span className="ml-auto flex items-center gap-[var(--ds-space-tight)]">
          <Button
            size="sm"
            variant={storage === "read-write" ? "primary" : "outline"}
            aria-pressed={storage === "read-write"}
            onClick={() => onStorage("read-write")}
          >
            Healthy
          </Button>
          <Button
            size="sm"
            variant={storage === "read-only-degraded" ? "danger" : "outline"}
            aria-pressed={storage === "read-only-degraded"}
            onClick={() => onStorage("read-only-degraded")}
          >
            Degraded
          </Button>
        </span>
      </PanelFooter>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Version registry
// ---------------------------------------------------------------------------

function VersionsSection({ onBump }: { onBump: (target: BumpTarget) => void }) {
  const rows = useMemo(() => allTopLevelRows(), []);
  const registry = useMemo(() => deriveVersionRegistry(rows), [rows]);
  const blocked = registry.filter((entry) => entry.nonTerminal > 0).length;

  return (
    <Panel className="min-h-0">
      <PanelHeader
        title="Version registry"
        subtitle="The dashboard's authoritative record of every workflow's current version. Active surfaces only ever contain current-version runs."
        icon={<BadgeCheck aria-hidden className={dsIcon.lg} />}
        meta={`app ${DEMO_APP_VERSION}`}
      />
      <PanelBody>
        <Banner
          tone={blocked > 0 ? "warning" : "info"}
          title={
            blocked > 0
              ? `${blocked} workflows have runs that are not terminal`
              : "Every listed run is terminal — any bump can proceed"
          }
          className="m-[var(--ds-space-cozy)]"
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onBump({ scope: "dashboard", workflowIds: [] })}
            >
              Dashboard update…
            </Button>
          }
        >
          A bump moves every prior-version run out of the dashboard into the read-only archive. It <strong>cannot</strong> archive a
          run that is still queued, running, waiting on you or parked — those must be terminalized or resolved first, and the bump
          flow lists them by name.
        </Banner>
        <Table label="Workflow version registry">
          <THead>
            <TR>
              <TH>Workflow</TH>
              <TH align="right">Version</TH>
              <TH align="right">At current</TH>
              <TH align="right">Prior version</TH>
              <TH align="right">Not terminal</TH>
              <TH align="right">Archived</TH>
              <TH align="right">Bump</TH>
            </TR>
          </THead>
          <TBody>
            {registry.map((entry) => (
              <TR key={entry.workflowId}>
                <TD>
                  <span className="flex items-baseline gap-[var(--ds-space-snug)]">
                    <span className={cn(dsText.nums, dsText.micro, "text-[color:var(--ds-fg-muted)]")}>{entry.code}</span>
                    <span className={cn(dsText.ui, "text-[color:var(--ds-fg)]")}>{entry.label}</span>
                  </span>
                </TD>
                <TD align="right" numeric>
                  v{entry.currentVersion}
                </TD>
                <TD align="right" numeric>
                  {entry.atCurrentVersion}
                </TD>
                <TD align="right" numeric className={entry.atPriorVersion > 0 ? "text-[color:var(--ds-status-waiting-fg)]" : undefined}>
                  {entry.atPriorVersion}
                </TD>
                <TD align="right">
                  <CountBadge value={entry.nonTerminal} tone={entry.nonTerminal > 0 ? "warning" : "neutral"} />
                </TD>
                <TD align="right" numeric>
                  {entry.archived}
                </TD>
                <TD align="right">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onBump({ scope: "workflow", workflowIds: [entry.workflowId] })}
                  >
                    Bump…
                  </Button>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>

        <div className="p-[var(--ds-space-cozy)]">
          <SectionLabel className="mb-[var(--ds-space-snug)]">Change records</SectionLabel>
          <div className="flex flex-col gap-[var(--ds-space-base)]">
            {DEMO_CHANGE_RECORDS.map((record) => (
              <Card key={record.id}>
                <CardBody className="flex min-w-0 flex-col gap-[var(--ds-space-tight)]">
                  <div className="flex min-w-0 flex-wrap items-center gap-[var(--ds-space-snug)]">
                    <Badge tone={record.scope === "dashboard" ? "warning" : "info"}>{BUMP_SCOPE_LABEL[record.scope]}</Badge>
                    <span className={cn(dsText.nums, dsText.meta, "text-[color:var(--ds-fg)]")}>
                      {record.fromVersion} → {record.toVersion}
                    </span>
                    <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>{record.at}</span>
                    <span className={cn(dsText.nums, dsText.micro, "ml-auto text-[color:var(--ds-fg-faint)]")}>
                      {record.commit} · {record.archivedRuns} archived
                    </span>
                  </div>
                  <p className={cn(dsText.body, "text-[color:var(--ds-fg)]")}>{record.what}</p>
                  <p className={cn(dsText.body, "text-[color:var(--ds-fg-muted)]")}>{record.why}</p>
                </CardBody>
              </Card>
            ))}
          </div>
        </div>
      </PanelBody>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export function DemoSettingsPage({
  storage,
  onStorage,
  onOpenView,
  onBack,
}: {
  storage: StorageMode;
  onStorage: (mode: StorageMode) => void;
  onOpenView: (view: PeripheryView) => void;
  onBack: () => void;
}) {
  const [active, setActive] = useState<SettingsSectionKey>("general");
  const [result, setResult] = useState<SettingChangeResult | null>(null);
  const [bump, setBump] = useState<BumpTarget | null>(null);
  const section = SECTIONS.find((entry) => entry.key === active) ?? SECTIONS[0];

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
        <SectionLabel className="px-[var(--ds-space-base)] py-[var(--ds-space-tight)]">Editable</SectionLabel>
        {SECTIONS.filter((entry) => !entry.readOnly).map((entry) => (
          <SectionButton key={entry.key} entry={entry} active={active === entry.key} onClick={() => setActive(entry.key)} />
        ))}
        <SectionLabel className="px-[var(--ds-space-base)] pb-[var(--ds-space-tight)] pt-[var(--ds-space-cozy)]">Reference</SectionLabel>
        {SECTIONS.filter((entry) => entry.readOnly).map((entry) => (
          <SectionButton key={entry.key} entry={entry} active={active === entry.key} onClick={() => setActive(entry.key)} />
        ))}
        <SectionLabel className="px-[var(--ds-space-base)] pb-[var(--ds-space-tight)] pt-[var(--ds-space-cozy)]">Full-page views</SectionLabel>
        {TAKEOVERS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => onOpenView(entry.key)}
            className={cn(
              "flex min-w-0 items-center gap-[var(--ds-space-snug)] rounded-[var(--ds-radius-md)] px-[var(--ds-space-base)] py-[var(--ds-space-snug)] text-left",
              "text-[color:var(--ds-fg-muted)] hover:bg-[var(--ds-surface-3)] hover:text-[color:var(--ds-fg)]",
              dsFocus,
            )}
          >
            <entry.icon aria-hidden className={cn(dsIcon.md, "shrink-0")} />
            <span className="flex min-w-0 flex-col">
              <span className={cn(dsText.ui, "truncate")}>{entry.label}</span>
              <span className={cn(dsText.micro, "truncate text-[color:var(--ds-fg-faint)]")}>{entry.blurb}</span>
            </span>
          </button>
        ))}
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-[var(--ds-space-base)] overflow-y-auto p-[var(--ds-space-cozy)]">
        {result && <ResultBanner result={result} onDismiss={() => setResult(null)} />}
        {storage === "read-only-degraded" && !result && (
          <Banner tone="danger" title="Storage is read-only — no setting can be saved">
            Changes typed here will be refused by the server, not saved silently. The Storage health section says what else is
            blocked.
          </Banner>
        )}

        {section.key === "system-urls" ? (
          <SystemUrlsSection storage={storage} onResult={setResult} />
        ) : section.key === "budgets" ? (
          <BudgetsSection />
        ) : section.key === "preflight" ? (
          <PreflightSection />
        ) : section.key === "storage" ? (
          <StorageSection storage={storage} onStorage={onStorage} />
        ) : section.key === "versions" ? (
          <VersionsSection onBump={setBump} />
        ) : (
          <LeafSection section={section} storage={storage} onResult={setResult} />
        )}
      </div>

      <DemoVersionBumpDialog target={bump} onClose={() => setBump(null)} onOpenArchive={() => onOpenView("archive")} />
    </div>
  );
}

function SectionButton({ entry, active, onClick }: { entry: SectionSpec; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "flex min-w-0 items-center gap-[var(--ds-space-snug)] rounded-[var(--ds-radius-md)] px-[var(--ds-space-base)] py-[var(--ds-space-snug)] text-left",
        dsText.ui,
        dsFocus,
        active
          ? "bg-[var(--ds-surface-selected)] font-semibold text-[color:var(--ds-fg)]"
          : "text-[color:var(--ds-fg-muted)] hover:bg-[var(--ds-surface-3)] hover:text-[color:var(--ds-fg)]",
      )}
    >
      <entry.icon aria-hidden className={cn(dsIcon.md, "shrink-0")} />
      <span className="truncate">{entry.label}</span>
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
            {snapshot.stillWorks.map((item) => (
              <p key={item} className={cn(dsText.body, "text-[color:var(--ds-fg-secondary)]")}>
                · {item}
              </p>
            ))}
          </Well>
          <Well>
            <SectionLabel className="mb-[var(--ds-space-tight)]">Does not work</SectionLabel>
            {snapshot.blocked.map((item) => (
              <p key={item} className={cn(dsText.body, "text-[color:var(--ds-fg-secondary)]")}>
                · {item}
              </p>
            ))}
          </Well>
        </div>
      )}
    </div>
  );
}
