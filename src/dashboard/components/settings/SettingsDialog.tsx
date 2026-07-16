import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bell,
  BookOpen,
  Camera,
  Flag,
  FolderOpen,
  Gauge,
  KeyRound,
  Keyboard,
  Layers,
  Link2,
  Loader2,
  Monitor,
  Network,
  Search,
  Settings2,
  Sparkles,
  Workflow,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSettings } from "@/components/hooks/useSettings";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  notificationsSupported,
  notificationPermission,
  requestNotificationPermission,
  type NotifySettings,
} from "@/lib/desktop-notifications";
import { toast } from "@/lib/notify";
import {
  DEFAULT_OPERATOR_SETTINGS,
  diffOperatorSettings,
  cloneOperatorSettings,
  type OperatorSettings,
  type CredentialStatus,
} from "../../../domain/settings/types.js";
import { useConfirm } from "@/components/shared/useConfirm";
import { InputField, ToggleField } from "./SettingsField.js";
import { ReferencePanel } from "./ReferencePanels.js";
import { AiAssistSection } from "./AiAssistSection.js";

// ── Section definitions ───────────────────────────────────────────────────────

type SectionId =
  | "general"
  | "display"
  | "urls"
  | "performance"
  | "capture"
  | "recovery"
  | "features"
  | "paths"
  | "notifications"
  | "credentials"
  | "ai-assist"
  // Read-only reference panels ("see what exists in the system").
  | "ref-rows"
  | "ref-workflows"
  | "ref-system"
  | "ref-shortcuts";

/** A section is either an editable settings group or a read-only reference panel. */
type SectionKind = "settings" | "reference";

interface Section {
  id: SectionId;
  label: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
  /** "settings" = editable; "reference" = read-only "what exists" panel. */
  kind: SectionKind;
  /** Whether this section edits the OperatorSettings draft (shows the Save/Revert footer). */
  settingsBacked: boolean;
  /** Extra terms the section matches in the settings search. */
  keywords: string[];
}

const SECTIONS: Section[] = [
  { id: "general", label: "General", icon: Settings2, kind: "settings", settingsBacked: true, keywords: ["timekeeper", "operator", "identity", "annual", "fiscal", "kronos", "job end", "date"] },
  { id: "display", label: "Display", icon: Monitor, kind: "settings", settingsBacked: true, keywords: ["screen", "width", "height", "resolution", "window", "monitor"] },
  { id: "urls", label: "System URLs", icon: Link2, kind: "settings", settingsBacked: true, keywords: ["url", "kuali", "kronos", "crm", "ucpath", "i-9", "onbase", "ukg", "instance", "endpoint"] },
  { id: "performance", label: "Performance", icon: Gauge, kind: "settings", settingsBacked: true, keywords: ["retries", "timeout", "navigation", "ocr", "concurrency", "second opinion", "separation", "duo", "workers", "backoff"] },
  { id: "capture", label: "Audit capture", icon: Camera, kind: "settings", settingsBacked: true, keywords: ["screenshot", "capture", "width", "slice", "audit", "image"] },
  { id: "recovery", label: "Recovery & daemon", icon: Activity, kind: "settings", settingsBacked: true, keywords: ["health", "browser", "refresh", "reopen", "daemon", "idle", "recovery", "monitor"] },
  { id: "features", label: "Features", icon: Flag, kind: "settings", settingsBacked: true, keywords: ["debug", "screenshots", "duo", "webauthn", "mfa", "flags"] },
  { id: "paths", label: "Paths", icon: FolderOpen, kind: "settings", settingsBacked: true, keywords: ["reports", "onboarding", "documents", "directory", "folder", "downloads"] },
  { id: "notifications", label: "Notifications", icon: Bell, kind: "settings", settingsBacked: false, keywords: ["desktop", "notify", "alerts", "failure", "review"] },
  { id: "credentials", label: "Credentials", icon: KeyRound, kind: "settings", settingsBacked: false, keywords: ["env", "ucpath", "i-9", "password", "credential", "roster"] },
  { id: "ai-assist", label: "AI Assist", icon: Sparkles, kind: "settings", settingsBacked: false, keywords: ["ai", "llm", "assist", "triage", "sanity", "selector", "summarize", "explain", "gemini", "free", "model", "failure"] },
  // ── Reference (read-only "what exists in the system") ──
  { id: "ref-rows", label: "Row & queue model", icon: Layers, kind: "reference", settingsBacked: false, keywords: ["archetype", "row", "shape", "kind", "queue", "trace", "single", "operation", "preview", "person", "file", "catalog", "status", "reference"] },
  { id: "ref-workflows", label: "Workflows & OCR", icon: BookOpen, kind: "reference", settingsBacked: false, keywords: ["workflow", "code", "ocr", "form", "steps", "run", "registry", "reference", "index"] },
  { id: "ref-system", label: "System reference", icon: Network, kind: "reference", settingsBacked: false, keywords: ["browser", "health", "daemon", "idle", "refresh", "states", "verdict", "reference"] },
  { id: "ref-shortcuts", label: "Keyboard shortcuts", icon: Keyboard, kind: "reference", settingsBacked: false, keywords: ["keyboard", "shortcut", "hotkey", "key", "navigation", "retry", "cancel", "search", "reference"] },
];

/** Maps a settings-backed section to the OperatorSettings groups it edits — drives per-section dirty dots. */
const SECTION_KEYS: Partial<Record<SectionId, (keyof OperatorSettings)[]>> = {
  general: ["operator", "annualDates"],
  display: ["display"],
  urls: ["urls"],
  performance: ["performance", "timeouts", "ocr", "concurrency"],
  capture: ["capture"],
  recovery: ["browserHealth", "daemon"],
  features: ["features"],
  paths: ["paths"],
};

// ── Props ─────────────────────────────────────────────────────────────────────

export interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Desktop-notification prefs (localStorage-backed, owned by App). */
  notifySettings: NotifySettings;
  onNotifySettingsChange: (s: NotifySettings) => void;
  /** Closes the dialog and opens the full-page Workflow Editor takeover. */
  onLaunchEditor: () => void;
}

// ── Dirty helpers ─────────────────────────────────────────────────────────────

function groupChanged(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return Object.keys(a).some((k) => a[k] !== b[k]);
}

function settingsEqual(a: OperatorSettings, b: OperatorSettings): boolean {
  return (Object.keys(a) as (keyof OperatorSettings)[]).every(
    (section) =>
      !groupChanged(a[section] as Record<string, unknown>, b[section] as Record<string, unknown>),
  );
}

function sectionDirty(id: SectionId, draft: OperatorSettings, settings: OperatorSettings | null): boolean {
  if (!settings) return false;
  const keys = SECTION_KEYS[id];
  if (!keys) return false;
  return keys.some((k) =>
    groupChanged(draft[k] as Record<string, unknown>, settings[k] as Record<string, unknown>),
  );
}

function sectionMatches(s: Section, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return s.label.toLowerCase().includes(q) || s.keywords.some((k) => k.includes(q));
}

// ── Card primitive ────────────────────────────────────────────────────────────

function Card({
  title,
  tag,
  children,
}: {
  title?: string;
  tag?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      {title && (
        <header className="mb-4 flex items-center gap-2.5">
          <h3 className="text-[13.5px] font-semibold tracking-tight text-foreground">{title}</h3>
          {tag && (
            <span className="rounded-full border border-warning/30 bg-warning/12 px-2 py-0.5 text-[10.5px] font-medium text-warning">
              {tag}
            </span>
          )}
        </header>
      )}
      {children}
    </section>
  );
}

const FIELD_GRID = "grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2";

function ConfigurationFaultPanel({
  error,
  backupAvailable,
  saving,
  actionError,
  onRecover,
  onReset,
}: {
  error: string;
  backupAvailable: boolean;
  saving: boolean;
  actionError: string | null;
  onRecover: () => void;
  onReset: () => void;
}): JSX.Element {
  return (
    <section role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-5">
      <div className="flex items-start gap-3">
        <AlertTriangle aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">Configuration fault</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            The existing settings file is corrupt or invalid. Workflow launches and queue
            mutations are blocked; defaults have not been substituted.
          </p>
          <p className="mt-3 break-words rounded-md border border-border bg-background/70 p-3 font-mono text-xs text-foreground">
            {error}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {backupAvailable ? (
              <button
                type="button"
                disabled={saving}
                onClick={onRecover}
                className="rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                Restore last valid backup
              </button>
            ) : null}
            <button
              type="button"
              disabled={saving}
              onClick={onReset}
              className="rounded-md border border-destructive/40 bg-background px-3.5 py-2 text-sm font-medium text-destructive outline-none hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              Reset to defaults
            </button>
          </div>
          {actionError ? (
            <p className="mt-3 text-xs text-destructive" aria-live="polite">{actionError}</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

// ── Credential display rows ───────────────────────────────────────────────────

interface CredentialRow {
  id: keyof CredentialStatus;
  label: string;
}

// Labels intentionally avoid a key:value pattern that would trip secret-scan hooks.
const CREDENTIAL_ROWS: CredentialRow[] = [
  { id: "ucpathUser", label: "UCPath user ID" },
  { id: "ucpathPassword", label: "UCPath login credential" },
  { id: "timekeeperName", label: "Timekeeper name" },
  { id: "onboardingRosterUrl", label: "Onboarding roster URL" },
];

// ── Section header (icon tile + title + subtitle) ─────────────────────────────

function SectionHead({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: Section["icon"];
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

// ── Notifications section ─────────────────────────────────────────────────────

function NotificationsSection({
  notifySettings,
  onNotifySettingsChange,
}: {
  notifySettings: NotifySettings;
  onNotifySettingsChange: (s: NotifySettings) => void;
}): JSX.Element {
  const supported = notificationsSupported();
  const [permission, setPermission] = useState<NotificationPermission>(notificationPermission());
  const granted = permission === "granted";
  const denied = permission === "denied";

  const enable = async () => {
    setPermission(await requestNotificationPermission());
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionHead
        icon={Bell}
        title="Notifications"
        subtitle="Desktop alerts for workflow events. Changes save automatically."
      />
      {!supported ? (
        <Card>
          <p className="text-sm text-muted-foreground">This browser doesn&apos;t support notifications.</p>
        </Card>
      ) : (
        <Card title="Desktop alerts">
          {!granted && (
            <button
              type="button"
              onClick={() => {
                void enable();
              }}
              disabled={denied}
              className={cn(
                "mb-4 inline-flex h-9 w-fit items-center rounded-md border border-primary bg-primary px-4 text-sm font-medium text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring",
                "disabled:cursor-not-allowed disabled:opacity-60",
              )}
            >
              {denied ? "Blocked in browser settings" : "Enable notifications"}
            </button>
          )}
          <div className="flex flex-col divide-y divide-border">
            <div className="pb-3.5">
              <ToggleField
                id="notify-failure"
                label="On run failure"
                description="Notify when a workflow run fails."
                checked={notifySettings.failure}
                onChange={(v) => onNotifySettingsChange({ ...notifySettings, failure: v })}
              />
            </div>
            <div className="pt-3.5">
              <ToggleField
                id="notify-awaiting-review"
                label="On OCR awaiting review"
                description="Notify when an OCR run is ready for operator review."
                checked={notifySettings.awaitingReview}
                onChange={(v) => onNotifySettingsChange({ ...notifySettings, awaitingReview: v })}
              />
            </div>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Fires only when this dashboard tab is in the background.
          </p>
        </Card>
      )}
    </div>
  );
}

// ── Credentials section ───────────────────────────────────────────────────────

function CredentialsSection({ credentials }: { credentials: CredentialStatus | null }): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SectionHead
        icon={KeyRound}
        title="Credentials"
        subtitle="Read from .env on startup — never editable or shown here."
      />
      <Card>
        <p className="mb-4 text-[13px] leading-relaxed text-muted-foreground">
          Edit <code className="rounded bg-secondary px-1 font-mono text-xs">.env</code> and restart
          the dashboard to change these.
        </p>
        <div className="flex flex-col gap-2">
          {credentials === null ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
              <Loader2 aria-hidden className="h-4 w-4 motion-safe:animate-spin" />
              Loading…
            </div>
          ) : (
            CREDENTIAL_ROWS.map(({ id, label }) => {
              const configured = credentials[id];
              return (
                <div
                  key={id}
                  className="flex items-center justify-between rounded-lg border border-border bg-secondary/40 px-4 py-2.5"
                >
                  <span className="text-[13px] text-foreground">{label}</span>
                  <span
                    className={cn(
                      "rounded-full border px-2.5 py-0.5 text-xs font-medium",
                      configured
                        ? "border-success/30 bg-success/12 text-success"
                        : "border-border bg-muted text-muted-foreground",
                    )}
                  >
                    {configured ? "Configured" : "Not set"}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </Card>
    </div>
  );
}

// ── Settings-backed section content ──────────────────────────────────────────

function SettingsSectionContent({
  section,
  draft,
  settings,
  setDraft,
}: {
  section: SectionId;
  draft: OperatorSettings;
  settings: OperatorSettings | null;
  setDraft: React.Dispatch<React.SetStateAction<OperatorSettings>>;
}): JSX.Element {
  function patch<K extends keyof OperatorSettings>(
    sectionKey: K,
    field: keyof OperatorSettings[K],
    rawValue: string,
  ) {
    const current = (draft[sectionKey] as Record<string, unknown>)[field as string];
    const parsed = Number(rawValue);
    const newValue: unknown =
      typeof current === "number"
        ? rawValue === "" || !Number.isFinite(parsed)
          ? current
          : parsed
        : rawValue;
    setDraft((prev) => ({
      ...prev,
      [sectionKey]: { ...prev[sectionKey], [field]: newValue },
    }));
  }
  // Per-field "changed" check against the saved baseline.
  function chg<K extends keyof OperatorSettings>(sectionKey: K, field: keyof OperatorSettings[K]): boolean {
    if (!settings) return false;
    return (
      (draft[sectionKey] as Record<string, unknown>)[field as string] !==
      (settings[sectionKey] as Record<string, unknown>)[field as string]
    );
  }
  const meta = SECTIONS.find((s) => s.id === section)!;

  if (section === "general") {
    return (
      <div className="flex flex-col gap-6">
        <SectionHead icon={meta.icon} title="General" subtitle="Operator identity used in workflow fills." />
        <Card title="Operator identity">
          <InputField
            id="operator-timekeeper-name"
            label="Timekeeper name"
            value={draft.operator.timekeeperName}
            changed={chg("operator", "timekeeperName")}
            onChange={(v) => patch("operator", "timekeeperName", v)}
            placeholder="e.g. Jane Smith"
            hint="Required by the Kuali separations workflow. Leave blank to use the TIMEKEEPER_NAME env variable."
          />
        </Card>
        <Card title="Annual dates" tag="Update each fiscal year">
          <div className={FIELD_GRID}>
            <InputField
              id="annual-dates-job-end"
              label="Onboarding job end date"
              value={draft.annualDates.jobEndDate}
              changed={chg("annualDates", "jobEndDate")}
              onChange={(v) => patch("annualDates", "jobEndDate", v)}
              placeholder="MM/DD/YYYY"
              mono
            />
            <InputField
              id="annual-dates-kronos-start"
              label="Kronos default start date"
              value={draft.annualDates.kronosDefaultStartDate}
              changed={chg("annualDates", "kronosDefaultStartDate")}
              onChange={(v) => patch("annualDates", "kronosDefaultStartDate", v)}
              placeholder="M/D/YYYY"
              mono
            />
            <InputField
              id="annual-dates-kronos-end"
              label="Kronos default end date"
              value={draft.annualDates.kronosDefaultEndDate}
              changed={chg("annualDates", "kronosDefaultEndDate")}
              onChange={(v) => patch("annualDates", "kronosDefaultEndDate", v)}
              placeholder="M/D/YYYY"
              mono
            />
          </div>
        </Card>
      </div>
    );
  }

  if (section === "display") {
    return (
      <div className="flex flex-col gap-6">
        <SectionHead icon={meta.icon} title="Display" subtitle="Daemon browser window size — match your monitor." />
        <Card title="Window size">
          <div className={FIELD_GRID}>
            <InputField
              id="display-width"
              label="Screen width (px)"
              type="number"
              value={draft.display.screenWidth}
              changed={chg("display", "screenWidth")}
              onChange={(v) => patch("display", "screenWidth", v)}
              min={800}
              step={1}
            />
            <InputField
              id="display-height"
              label="Screen height (px)"
              type="number"
              value={draft.display.screenHeight}
              changed={chg("display", "screenHeight")}
              onChange={(v) => patch("display", "screenHeight", v)}
              min={600}
              step={1}
            />
          </div>
        </Card>
      </div>
    );
  }

  if (section === "performance") {
    return (
      <div className="flex flex-col gap-6">
        <SectionHead
          icon={meta.icon}
          title="Performance"
          subtitle="Navigation resilience, timeouts, and OCR pipeline concurrency."
        />
        <Card title="Navigation">
          <div className={FIELD_GRID}>
            <InputField
              id="perf-nav-retries"
              label="Navigation retries"
              type="number"
              value={draft.performance.navigationRetries}
              changed={chg("performance", "navigationRetries")}
              onChange={(v) => patch("performance", "navigationRetries", v)}
              min={1}
              step={1}
              hint="Retry attempts before failing a run."
            />
            <InputField
              id="perf-termination-window"
              label="Separation termination window (days)"
              type="number"
              value={draft.performance.separationTerminationWindowDays}
              changed={chg("performance", "separationTerminationWindowDays")}
              onChange={(v) => patch("performance", "separationTerminationWindowDays", v)}
              min={1}
              step={1}
              hint="Tolerance window for reusing an approved prior termination."
            />
          </div>
        </Card>
        <Card title="Timeouts">
          <div className={FIELD_GRID}>
            <InputField
              id="timeout-nav"
              label="Navigation timeout (ms)"
              type="number"
              value={draft.timeouts.navigationMs}
              changed={chg("timeouts", "navigationMs")}
              onChange={(v) => patch("timeouts", "navigationMs", v)}
              min={1000}
              step={1000}
            />
            <InputField
              id="timeout-long-nav"
              label="Long navigation timeout (ms)"
              type="number"
              value={draft.timeouts.longNavigationMs}
              changed={chg("timeouts", "longNavigationMs")}
              onChange={(v) => patch("timeouts", "longNavigationMs", v)}
              min={1000}
              step={1000}
              hint="Used for complex page loads — UKG, Kuali."
            />
            <InputField
              id="timeout-ukg-nav"
              label="UKG navigation timeout (ms)"
              type="number"
              value={draft.timeouts.ukgNavigationMs}
              changed={chg("timeouts", "ukgNavigationMs")}
              onChange={(v) => patch("timeouts", "ukgNavigationMs", v)}
              min={1000}
              step={1000}
              hint="Old Kronos (UKG) is slow to load."
            />
            <InputField
              id="timeout-retry-delay"
              label="Retry delay (ms)"
              type="number"
              value={draft.timeouts.retryDelayMs}
              changed={chg("timeouts", "retryDelayMs")}
              onChange={(v) => patch("timeouts", "retryDelayMs", v)}
              min={0}
              step={500}
              hint="Wait between navigation retries."
            />
            <InputField
              id="timeout-duo"
              label="Duo approval wait (seconds)"
              type="number"
              value={draft.timeouts.duoApprovalSeconds}
              changed={chg("timeouts", "duoApprovalSeconds")}
              onChange={(v) => patch("timeouts", "duoApprovalSeconds", v)}
              min={10}
              step={5}
              hint="UCPath / onboarding MFA wait."
            />
            <InputField
              id="timeout-duo-crm"
              label="Duo approval wait — CRM (seconds)"
              type="number"
              value={draft.timeouts.duoApprovalCrmSeconds}
              changed={chg("timeouts", "duoApprovalCrmSeconds")}
              onChange={(v) => patch("timeouts", "duoApprovalCrmSeconds", v)}
              min={10}
              step={5}
              hint="CRM / separations MFA wait."
            />
          </div>
        </Card>
        <Card title="OCR">
          <div className={FIELD_GRID}>
            <InputField
              id="ocr-second-opinion-max"
              label="Second opinion max"
              type="number"
              value={draft.ocr.secondOpinionMax}
              changed={chg("ocr", "secondOpinionMax")}
              onChange={(v) => patch("ocr", "secondOpinionMax", v)}
              min={0}
              step={1}
              hint="Max suspect records to re-read via the second-opinion pass."
            />
            <InputField
              id="ocr-page-concurrency"
              label="Page concurrency"
              type="number"
              value={draft.ocr.pageConcurrency}
              changed={chg("ocr", "pageConcurrency")}
              onChange={(v) => patch("ocr", "pageConcurrency", v)}
              min={0}
              step={1}
              hint="Max concurrent OCR page extractions. 0 = Auto (vision-pool size)."
            />
            <InputField
              id="ocr-page-max-wait"
              label="Page max wait (ms)"
              type="number"
              value={draft.ocr.pageMaxWaitMs}
              changed={chg("ocr", "pageMaxWaitMs")}
              onChange={(v) => patch("ocr", "pageMaxWaitMs", v)}
              min={1000}
              step={1000}
              hint="Per-page OCR wait budget before a page fails."
            />
            <InputField
              id="ocr-disambig-concurrency"
              label="Disambiguation concurrency"
              type="number"
              value={draft.ocr.disambigConcurrency}
              changed={chg("ocr", "disambigConcurrency")}
              onChange={(v) => patch("ocr", "disambigConcurrency", v)}
              min={1}
              step={1}
            />
            <InputField
              id="ocr-suggest-concurrency"
              label="Suggestion concurrency"
              type="number"
              value={draft.ocr.suggestConcurrency}
              changed={chg("ocr", "suggestConcurrency")}
              onChange={(v) => patch("ocr", "suggestConcurrency", v)}
              min={1}
              step={1}
            />
            <InputField
              id="ocr-backoff-base"
              label="Rate-limit backoff base (ms)"
              type="number"
              value={draft.ocr.backoffBaseMs}
              changed={chg("ocr", "backoffBaseMs")}
              onChange={(v) => patch("ocr", "backoffBaseMs", v)}
              min={100}
              step={100}
              hint="Starting backoff after an OCR rate-limit."
            />
            <InputField
              id="ocr-backoff-cap"
              label="Rate-limit backoff cap (ms)"
              type="number"
              value={draft.ocr.backoffCapMs}
              changed={chg("ocr", "backoffCapMs")}
              onChange={(v) => patch("ocr", "backoffCapMs", v)}
              min={1000}
              step={1000}
            />
            <InputField
              id="ocr-max-validation-retries"
              label="Max validation retries"
              type="number"
              value={draft.ocr.maxValidationRetries}
              changed={chg("ocr", "maxValidationRetries")}
              onChange={(v) => patch("ocr", "maxValidationRetries", v)}
              min={0}
              step={1}
              hint="Re-OCR attempts when a page fails schema validation."
            />
          </div>
        </Card>
        <Card title="Concurrency">
          <div className={FIELD_GRID}>
            <InputField
              id="concurrency-default-workers"
              label="Default workers"
              type="number"
              value={draft.concurrency.defaultWorkers}
              changed={chg("concurrency", "defaultWorkers")}
              onChange={(v) => patch("concurrency", "defaultWorkers", v)}
              min={1}
              step={1}
              hint="Default parallel workers for the Old Kronos report download."
            />
          </div>
        </Card>
      </div>
    );
  }

  if (section === "urls") {
    return (
      <div className="flex flex-col gap-6">
        <SectionHead
          icon={meta.icon}
          title="System URLs"
          subtitle="Entry URLs for each external system. Leave blank to use the production default — set one only to target an alternate/test instance."
        />
        <Card title="System endpoints">
          <div className="flex flex-col gap-4">
            <InputField
              id="url-kuali"
              label="Kuali Build space"
              value={draft.urls.kualiSpace}
              changed={chg("urls", "kualiSpace")}
              onChange={(v) => patch("urls", "kualiSpace", v)}
              placeholder="Default: ucsd.kualibuild.com/build/space/…"
              mono
            />
            <InputField
              id="url-ucpath"
              label="UCPath Smart HR"
              value={draft.urls.ucpathSmartHr}
              changed={chg("urls", "ucpathSmartHr")}
              onChange={(v) => patch("urls", "ucpathSmartHr", v)}
              placeholder="Default: ucphrprdpub.universityofcalifornia.edu/…"
              mono
            />
            <InputField
              id="url-crm-entry"
              label="CRM entry"
              value={draft.urls.crmEntry}
              changed={chg("urls", "crmEntry")}
              onChange={(v) => patch("urls", "crmEntry", v)}
              placeholder="Default: crm.ucsd.edu/hr"
              mono
            />
            <InputField
              id="url-crm-search"
              label="CRM onboarding search"
              value={draft.urls.crmSearch}
              changed={chg("urls", "crmSearch")}
              onChange={(v) => patch("urls", "crmSearch", v)}
              placeholder="Default: act-crm.my.site.com/hr/ONB_SearchOnboardings"
              mono
            />
            <InputField
              id="url-new-kronos"
              label="New Kronos (WFD)"
              value={draft.urls.newKronos}
              changed={chg("urls", "newKronos")}
              onChange={(v) => patch("urls", "newKronos", v)}
              placeholder="Default: ucsd-sso.prd.mykronos.com/wfd/home"
              mono
            />
            <InputField
              id="url-ukg"
              label="UKG (Old Kronos)"
              value={draft.urls.ukg}
              changed={chg("urls", "ukg")}
              onChange={(v) => patch("urls", "ukg", v)}
              placeholder="Default: ucsd.kronos.net/wfcstatic/…"
              mono
            />
            <InputField
              id="url-i9"
              label="I-9 Complete"
              value={draft.urls.i9}
              changed={chg("urls", "i9")}
              onChange={(v) => patch("urls", "i9", v)}
              placeholder="Default: i9complete.ucop.edu"
              mono
            />
            <InputField
              id="url-onbase"
              label="OnBase (Hyland)"
              value={draft.urls.onbase}
              changed={chg("urls", "onbase")}
              onChange={(v) => patch("urls", "onbase", v)}
              placeholder="Default: ucsd.hylandcloud.com/251ids/NavPanel.aspx"
              mono
            />
          </div>
        </Card>
      </div>
    );
  }

  if (section === "capture") {
    return (
      <div className="flex flex-col gap-6">
        <SectionHead
          icon={meta.icon}
          title="Audit capture"
          subtitle="Geometry for the audit screenshots taken at each workflow step. Tune for readability of captured forms."
        />
        <Card title="Capture geometry">
          <div className={FIELD_GRID}>
            <InputField
              id="capture-width"
              label="Minimum width (px)"
              type="number"
              value={draft.capture.width}
              changed={chg("capture", "width")}
              onChange={(v) => patch("capture", "width", v)}
              min={320}
              step={40}
              hint="Fixed readable column width — a floor, not a cap."
            />
            <InputField
              id="capture-max-width"
              label="Maximum width (px)"
              type="number"
              value={draft.capture.maxWidth}
              changed={chg("capture", "maxWidth")}
              onChange={(v) => patch("capture", "maxWidth", v)}
              min={320}
              step={100}
              hint="Hard cap for very wide grids."
            />
            <InputField
              id="capture-slice-height"
              label="Slice height (px)"
              type="number"
              value={draft.capture.sliceHeight}
              changed={chg("capture", "sliceHeight")}
              onChange={(v) => patch("capture", "sliceHeight", v)}
              min={200}
              step={100}
              hint="Height of each page slice when a tall form is split."
            />
            <InputField
              id="capture-slice-overlap"
              label="Slice overlap (px)"
              type="number"
              value={draft.capture.sliceOverlap}
              changed={chg("capture", "sliceOverlap")}
              onChange={(v) => patch("capture", "sliceOverlap", v)}
              min={0}
              step={20}
              hint="Overlap between consecutive slices. Must be < slice height."
            />
            <InputField
              id="capture-max-slices"
              label="Max slices per page"
              type="number"
              value={draft.capture.maxSlices}
              changed={chg("capture", "maxSlices")}
              onChange={(v) => patch("capture", "maxSlices", v)}
              min={1}
              step={1}
            />
          </div>
        </Card>
      </div>
    );
  }

  if (section === "recovery") {
    return (
      <div className="flex flex-col gap-6">
        <SectionHead
          icon={meta.icon}
          title="Recovery & daemon"
          subtitle="Per-browser health-recovery aggressiveness and daemon claim-loop timing."
        />
        <Card title="Browser health monitor">
          <div className={FIELD_GRID}>
            <InputField
              id="health-tick"
              label="Monitor tick (ms)"
              type="number"
              value={draft.browserHealth.monitorTickMs}
              changed={chg("browserHealth", "monitorTickMs")}
              onChange={(v) => patch("browserHealth", "monitorTickMs", v)}
              min={1000}
              step={1000}
              hint="How often each browser's health is probed."
            />
            <InputField
              id="health-max-refresh"
              label="Max auto-refresh (rung 1)"
              type="number"
              value={draft.browserHealth.maxAutoRefresh}
              changed={chg("browserHealth", "maxAutoRefresh")}
              onChange={(v) => patch("browserHealth", "maxAutoRefresh", v)}
              min={0}
              step={1}
              hint="Consecutive Refresh attempts before escalating to Reopen."
            />
            <InputField
              id="health-max-reopen"
              label="Max reopen (rung 2)"
              type="number"
              value={draft.browserHealth.maxReopen}
              changed={chg("browserHealth", "maxReopen")}
              onChange={(v) => patch("browserHealth", "maxReopen", v)}
              min={0}
              step={1}
              hint="Consecutive Reopen attempts before surfacing a failure."
            />
          </div>
        </Card>
        <Card title="Daemon timing">
          <div className={FIELD_GRID}>
            <InputField
              id="daemon-idle"
              label="Idle keepalive window (ms)"
              type="number"
              value={draft.daemon.idleMs}
              changed={chg("daemon", "idleMs")}
              onChange={(v) => patch("daemon", "idleMs", v)}
              min={10000}
              step={10000}
              hint="Idle window before a daemon runs its heavyweight keepalive tick."
            />
            <InputField
              id="daemon-repoll"
              label="Idle re-poll backstop (ms)"
              type="number"
              value={draft.daemon.idleRepollMs}
              changed={chg("daemon", "idleRepollMs")}
              onChange={(v) => patch("daemon", "idleRepollMs", v)}
              min={1000}
              step={1000}
              hint="How quickly a missed wake is recovered (lower = snappier queue pickup)."
            />
          </div>
        </Card>
      </div>
    );
  }

  if (section === "features") {
    return (
      <div className="flex flex-col gap-6">
        <SectionHead icon={meta.icon} title="Features" subtitle="Optional workflow behaviors and debug tooling." />
        <Card title="Optional behaviors">
          <div className="flex flex-col divide-y divide-border">
            <div className="pb-3.5">
              <ToggleField
                id="feature-debug-screenshots"
                label="Debug screenshots"
                description="Write extra debug screenshots in hot paths."
                checked={draft.features.debugScreenshots}
                changed={chg("features", "debugScreenshots")}
                onChange={(v) =>
                  setDraft((prev) => ({ ...prev, features: { ...prev.features, debugScreenshots: v } }))
                }
              />
            </div>
            <div className="pt-3.5">
              <ToggleField
                id="feature-duo-webauthn"
                label="Duo WebAuthn"
                description="Hands-off Duo MFA via the WebAuthn virtual authenticator. Requires prior one-time enrollment."
                checked={draft.features.duoWebAuthn}
                changed={chg("features", "duoWebAuthn")}
                onChange={(v) =>
                  setDraft((prev) => ({ ...prev, features: { ...prev.features, duoWebAuthn: v } }))
                }
              />
            </div>
          </div>
        </Card>
      </div>
    );
  }

  if (section === "paths") {
    return (
      <div className="flex flex-col gap-6">
        <SectionHead
          icon={meta.icon}
          title="Paths"
          subtitle="Output directories for workflow downloads. Leave blank to use the default."
        />
        <Card title="Directories">
          <div className="flex flex-col gap-4">
            <InputField
              id="paths-reports-dir"
              label="Reports directory"
              value={draft.paths.reportsDir}
              changed={chg("paths", "reportsDir")}
              onChange={(v) => patch("paths", "reportsDir", v)}
              placeholder="Default: ~/Downloads/reports"
              hint="Kronos and separations PDF report downloads."
            />
            <InputField
              id="paths-onboarding-docs-dir"
              label="Onboarding documents directory"
              value={draft.paths.onboardingDocsDir}
              changed={chg("paths", "onboardingDocsDir")}
              onChange={(v) => patch("paths", "onboardingDocsDir", v)}
              placeholder="Default: ~/Documents/onboarding"
              hint="CRM onboarding-document downloads."
            />
          </div>
        </Card>
      </div>
    );
  }

  return <></>;
}

// ── Main dialog ───────────────────────────────────────────────────────────────

export function SettingsDialog({
  open,
  onOpenChange,
  notifySettings,
  onNotifySettingsChange,
  onLaunchEditor,
}: SettingsDialogProps): JSX.Element {
  const { settings, credentials, loading, saving, error, configuration, save, reset, recover } = useSettings();
  const { confirm, confirmDialog } = useConfirm();
  const [activeSection, setActiveSection] = useState<SectionId>("general");
  const [draft, setDraft] = useState<OperatorSettings>(DEFAULT_OPERATOR_SETTINGS);
  const [query, setQuery] = useState("");
  const [saveStatus, setSaveStatus] = useState("");

  // Sync the draft when settings load or change externally (save / reset).
  useEffect(() => {
    if (settings) setDraft(cloneOperatorSettings(settings));
  }, [settings]);

  const isDirty = settings !== null && !settingsEqual(draft, settings);
  const current = SECTIONS.find((s) => s.id === activeSection) ?? SECTIONS[0];
  const showFooter = current.settingsBacked;
  const visibleSections = useMemo(() => SECTIONS.filter((s) => sectionMatches(s, query)), [query]);
  const settingsNavSections = useMemo(() => visibleSections.filter((s) => s.kind === "settings"), [visibleSections]);
  const referenceNavSections = useMemo(() => visibleSections.filter((s) => s.kind === "reference"), [visibleSections]);

  const renderNavButton = (section: Section): JSX.Element => {
    const Icon = section.icon;
    const active = activeSection === section.id;
    const dirty = sectionDirty(section.id, draft, settings);
    return (
      <button
        key={section.id}
        type="button"
        aria-current={active ? "page" : undefined}
        onClick={() => setActiveSection(section.id)}
        className={cn(
          "relative mt-0.5 flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          active ? "bg-accent font-semibold text-foreground" : "text-foreground/90 hover:bg-secondary",
        )}
      >
        {active && (
          <span aria-hidden className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary" />
        )}
        <Icon aria-hidden className="h-4 w-4 shrink-0" />
        <span className="truncate">{section.label}</span>
        {dirty && (
          <span aria-label="Unsaved changes" className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
        )}
      </button>
    );
  };

  const handleSave = async () => {
    const ok = await save(diffOperatorSettings(draft));
    if (ok) {
      toast.success("Settings saved");
      setSaveStatus("Settings saved");
    } else {
      toast.error("Save failed");
      setSaveStatus("Save failed");
    }
  };

  const handleReset = async () => {
    const ok = await confirm({
      title: "Reset all settings to defaults?",
      description:
        "This removes every customization and restores factory defaults. This cannot be undone.",
      tone: "destructive",
      confirmLabel: "Reset to defaults",
      cancelLabel: "Keep current",
    });
    if (!ok) return;
    const success = await reset();
    if (success) {
      toast.success("Settings reset to defaults");
      setSaveStatus("Reset to defaults");
    } else {
      toast.error("Reset failed");
      setSaveStatus("Reset failed");
    }
  };

  const handleRecover = async () => {
    const success = await recover();
    if (success) {
      toast.success("Settings backup restored");
      setSaveStatus("Backup restored");
    } else {
      toast.error("Recovery failed");
      setSaveStatus("Recovery failed");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="xl"
        className="flex h-[min(86vh,660px)] flex-col gap-0 overflow-hidden p-0"
      >
        <DialogHeader className="flex-row items-center gap-2.5 px-5 py-3.5">
          <Settings2 aria-hidden className="h-[18px] w-[18px] text-foreground" />
          <DialogTitle className="text-[15px]">Settings</DialogTitle>
          <DialogDescription className="sr-only">
            Operator constants, notifications, and credential status for the HR automation
            dashboard.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          {/* Left section nav */}
          <nav
            aria-label="Settings sections"
            className="flex w-[212px] shrink-0 flex-col border-r border-border bg-sidebar"
          >
            <div className="p-3">
              <div className="flex h-9 items-center gap-2 rounded-md border border-border bg-secondary px-2.5 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring">
                <Search aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search settings…"
                  aria-label="Search settings"
                  className="w-full bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-2.5 pb-2">
              {visibleSections.length === 0 ? (
                <p className="px-2.5 py-3 text-[12.5px] text-muted-foreground">
                  No settings match “{query}”.
                </p>
              ) : (
                <>
                  {settingsNavSections.map(renderNavButton)}
                  {referenceNavSections.length > 0 && (
                    <p className="mt-3 mb-0.5 px-2.5 pt-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Reference
                    </p>
                  )}
                  {referenceNavSections.map(renderNavButton)}
                </>
              )}
            </div>
            {/* Workflow Editor launches into its own full-page view */}
            <div className="border-t border-border p-2.5">
              <button
                type="button"
                onClick={onLaunchEditor}
                className="group flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] text-foreground/90 outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Workflow aria-hidden className="h-4 w-4 shrink-0" />
                <span className="truncate">Workflow Editor</span>
                <ArrowUpRight
                  aria-hidden
                  className="ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
                />
              </button>
            </div>
          </nav>

          {/* Right content area */}
          <div className="flex min-h-0 flex-1 flex-col bg-background">
            <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
              {loading ? (
                <div className="flex h-full items-center justify-center" aria-live="polite">
                  <Loader2 aria-hidden className="h-5 w-5 text-muted-foreground motion-safe:animate-spin" />
                </div>
              ) : configuration?.state === "fault" ? (
                <div className="mx-auto max-w-2xl">
                  <ConfigurationFaultPanel
                    error={configuration.error}
                    backupAvailable={configuration.backupAvailable}
                    saving={saving}
                    actionError={error}
                    onRecover={() => { void handleRecover(); }}
                    onReset={() => { void handleReset(); }}
                  />
                </div>
              ) : (
                <div className="mx-auto max-w-2xl">
                  {activeSection === "notifications" ? (
                    <NotificationsSection
                      notifySettings={notifySettings}
                      onNotifySettingsChange={onNotifySettingsChange}
                    />
                  ) : activeSection === "credentials" ? (
                    <CredentialsSection credentials={credentials} />
                  ) : activeSection === "ai-assist" ? (
                    <AiAssistSection />
                  ) : activeSection === "ref-rows" ||
                    activeSection === "ref-workflows" ||
                    activeSection === "ref-system" ||
                    activeSection === "ref-shortcuts" ? (
                    <ReferencePanel section={activeSection} />
                  ) : (
                    <>
                      <SettingsSectionContent
                        section={activeSection}
                        draft={draft}
                        settings={settings}
                        setDraft={setDraft}
                      />
                      <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
                        Changes apply on the next workflow run — daemons read settings at startup. A
                        few backend constants need a dashboard restart.
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Footer — Save/Revert for settings-backed sections */}
            {showFooter && !loading && configuration?.state !== "fault" && (
              <div className="shrink-0 border-t border-border bg-card/60 px-7 py-3">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    disabled={saving || !isDirty}
                    aria-disabled={saving || !isDirty}
                    onClick={() => {
                      void handleSave();
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {saving ? (
                      <Loader2 aria-hidden className="h-3.5 w-3.5 shrink-0 motion-safe:animate-spin" />
                    ) : null}
                    Save changes
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    aria-disabled={saving}
                    onClick={() => {
                      void handleReset();
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary px-3.5 py-1.5 text-sm text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Revert to defaults
                  </button>
                  {isDirty && !saving ? (
                    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-warning" />
                      Unsaved changes
                    </span>
                  ) : null}
                  <span aria-live="polite" className="ml-auto truncate text-xs text-muted-foreground">
                    {saveStatus}
                  </span>
                </div>
                {error && (
                  <p aria-live="polite" className="mt-2 text-xs text-destructive">
                    {error}
                  </p>
                )}
              </div>
            )}

            {/* Notifications save automatically */}
            {activeSection === "notifications" && !loading && (
              <div className="shrink-0 border-t border-border bg-card/60 px-7 py-3">
                <span className="inline-flex items-center gap-2 text-xs text-success">
                  <Settings2 aria-hidden className="h-3.5 w-3.5" />
                  Changes are saved automatically.
                </span>
              </div>
            )}
          </div>
        </div>

        {confirmDialog}
      </DialogContent>
    </Dialog>
  );
}
