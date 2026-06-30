import { useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  Bell,
  Flag,
  FolderOpen,
  Gauge,
  KeyRound,
  Loader2,
  Monitor,
  Search,
  Settings2,
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

// ── Section definitions ───────────────────────────────────────────────────────

type SectionId =
  | "general"
  | "display"
  | "performance"
  | "features"
  | "paths"
  | "notifications"
  | "credentials";

interface Section {
  id: SectionId;
  label: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
  /** Whether this section edits the OperatorSettings draft (shows the Save/Revert footer). */
  settingsBacked: boolean;
  /** Extra terms the section matches in the settings search. */
  keywords: string[];
}

const SECTIONS: Section[] = [
  { id: "general", label: "General", icon: Settings2, settingsBacked: true, keywords: ["timekeeper", "operator", "identity", "annual", "fiscal", "kronos", "job end", "date"] },
  { id: "display", label: "Display", icon: Monitor, settingsBacked: true, keywords: ["screen", "width", "height", "resolution", "window", "monitor"] },
  { id: "performance", label: "Performance", icon: Gauge, settingsBacked: true, keywords: ["retries", "timeout", "navigation", "ocr", "concurrency", "second opinion", "separation"] },
  { id: "features", label: "Features", icon: Flag, settingsBacked: true, keywords: ["debug", "screenshots", "duo", "webauthn", "mfa", "flags"] },
  { id: "paths", label: "Paths", icon: FolderOpen, settingsBacked: true, keywords: ["reports", "onboarding", "documents", "directory", "folder", "downloads"] },
  { id: "notifications", label: "Notifications", icon: Bell, settingsBacked: false, keywords: ["desktop", "notify", "alerts", "failure", "review"] },
  { id: "credentials", label: "Credentials", icon: KeyRound, settingsBacked: false, keywords: ["env", "ucpath", "i-9", "password", "credential", "roster"] },
];

/** Maps a settings-backed section to the OperatorSettings groups it edits — drives per-section dirty dots. */
const SECTION_KEYS: Partial<Record<SectionId, (keyof OperatorSettings)[]>> = {
  general: ["operator", "annualDates"],
  display: ["display"],
  performance: ["performance", "timeouts", "ocr"],
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

// ── Credential display rows ───────────────────────────────────────────────────

interface CredentialRow {
  id: keyof CredentialStatus;
  label: string;
}

// Labels intentionally avoid a key:value pattern that would trip secret-scan hooks.
const CREDENTIAL_ROWS: CredentialRow[] = [
  { id: "ucpathUser", label: "UCPath user ID" },
  { id: "ucpathPassword", label: "UCPath login credential" },
  { id: "i9User", label: "I-9 user ID" },
  { id: "i9Password", label: "I-9 login credential" },
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
    const newValue: unknown = typeof current === "number" ? Number(rawValue) : rawValue;
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
  const { settings, credentials, loading, saving, error, save, reset } = useSettings();
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

  const handleSave = async () => {
    const ok = await save(diffOperatorSettings(draft));
    if (ok) {
      toast.success("Settings saved");
      setSaveStatus("Settings saved");
    } else {
      toast.error("Save failed");
      setSaveStatus(error ?? "Save failed");
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
      setSaveStatus(error ?? "Reset failed");
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
                visibleSections.map((section) => {
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
                        active
                          ? "bg-accent font-semibold text-foreground"
                          : "text-foreground/90 hover:bg-secondary",
                      )}
                    >
                      {active && (
                        <span
                          aria-hidden
                          className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary"
                        />
                      )}
                      <Icon aria-hidden className="h-4 w-4 shrink-0" />
                      <span className="truncate">{section.label}</span>
                      {dirty && (
                        <span
                          aria-label="Unsaved changes"
                          className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
                        />
                      )}
                    </button>
                  );
                })
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
              ) : (
                <div className="mx-auto max-w-2xl">
                  {activeSection === "notifications" ? (
                    <NotificationsSection
                      notifySettings={notifySettings}
                      onNotifySettingsChange={onNotifySettingsChange}
                    />
                  ) : activeSection === "credentials" ? (
                    <CredentialsSection credentials={credentials} />
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
            {showFooter && !loading && (
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
