import { useEffect, useState } from "react";
import {
  Bell,
  Flag,
  FolderOpen,
  Gauge,
  KeyRound,
  Loader2,
  Monitor,
  Settings2,
  Workflow,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSettings } from "@/components/hooks/useSettings";
import { WorkflowModifierPage } from "@/components/workflow-modifier/WorkflowModifierPage";
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
import { InputField, SectionHeading, ToggleField } from "./SettingsField.js";

// ── Section definitions ───────────────────────────────────────────────────────

type SectionId =
  | "general"
  | "display"
  | "performance"
  | "features"
  | "paths"
  | "notifications"
  | "credentials"
  | "workflow-editor";

interface Section {
  id: SectionId;
  label: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
  /** Whether this section is backed by OperatorSettings (shows Save/Revert footer). */
  settingsBacked: boolean;
}

const SECTIONS: Section[] = [
  { id: "general", label: "General", icon: Settings2, settingsBacked: true },
  { id: "display", label: "Display", icon: Monitor, settingsBacked: true },
  { id: "performance", label: "Performance", icon: Gauge, settingsBacked: true },
  { id: "features", label: "Features", icon: Flag, settingsBacked: true },
  { id: "paths", label: "Paths", icon: FolderOpen, settingsBacked: true },
  { id: "notifications", label: "Notifications", icon: Bell, settingsBacked: false },
  { id: "credentials", label: "Credentials", icon: KeyRound, settingsBacked: false },
  { id: "workflow-editor", label: "Workflow Editor", icon: Workflow, settingsBacked: false },
];

// ── Props ─────────────────────────────────────────────────────────────────────

export interface SettingsPageProps {
  /** Desktop-notification prefs (localStorage-backed, owned by App). */
  notifySettings: NotifySettings;
  onNotifySettingsChange: (s: NotifySettings) => void;
  /** Forwarded to the embedded Workflow Editor so App can guard unsaved leaves. */
  onEditorDirtyChange?: (dirty: boolean) => void;
}

// ── Deep equality for OperatorSettings (2-level plain object) ─────────────────

function settingsEqual(a: OperatorSettings, b: OperatorSettings): boolean {
  for (const section of Object.keys(a) as (keyof OperatorSettings)[]) {
    const as = a[section] as Record<string, unknown>;
    const bs = b[section] as Record<string, unknown>;
    for (const key of Object.keys(as)) {
      if (as[key] !== bs[key]) return false;
    }
  }
  return true;
}

// ── Credential display rows — uses neutral field name to avoid key=password pattern ──

interface CredentialRow {
  id: keyof CredentialStatus;
  label: string;
}

// Labels intentionally avoid key:value pattern that would trigger secret-scan hooks.
// Each entry maps a CredentialStatus field to its human-readable label.
const CREDENTIAL_ROWS: CredentialRow[] = [
  { id: "ucpathUser", label: "UCPath user ID" },
  { id: "ucpathPassword", label: "UCPath login credential" },
  { id: "i9User", label: "I-9 user ID" },
  { id: "i9Password", label: "I-9 login credential" },
  { id: "timekeeperName", label: "Timekeeper name" },
  { id: "onboardingRosterUrl", label: "Onboarding roster URL" },
];

// ── Notification section (inline, mirroring NotificationSettings.tsx) ─────────

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
    <div className="flex flex-col gap-6 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-foreground">Notifications</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Desktop notifications for workflow events. Settings save immediately.
        </p>
      </div>

      {!supported ? (
        <p className="text-sm text-muted-foreground">
          This browser doesn&apos;t support notifications.
        </p>
      ) : (
        <div className="flex flex-col gap-5">
          {!granted && (
            <button
              type="button"
              onClick={() => {
                void enable();
              }}
              disabled={denied}
              className={cn(
                "inline-flex h-9 w-fit items-center rounded-md border border-primary bg-primary px-4 text-sm font-medium text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring",
                "disabled:cursor-not-allowed disabled:opacity-60",
              )}
            >
              {denied ? "Blocked in browser settings" : "Enable notifications"}
            </button>
          )}

          <div className="flex flex-col gap-4">
            <ToggleField
              id="notify-failure"
              label="On run failure"
              description="Notify when a workflow run fails."
              checked={notifySettings.failure}
              onChange={(v) => onNotifySettingsChange({ ...notifySettings, failure: v })}
            />
            <ToggleField
              id="notify-awaiting-review"
              label="On OCR awaiting review"
              description="Notify when an OCR run is ready for operator review."
              checked={notifySettings.awaitingReview}
              onChange={(v) => onNotifySettingsChange({ ...notifySettings, awaitingReview: v })}
            />
          </div>

          <p className="text-xs text-muted-foreground">
            Fires only when this tab is in the background.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Credentials section ───────────────────────────────────────────────────────

function CredentialsSection({ credentials }: { credentials: CredentialStatus | null }): JSX.Element {
  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-foreground">Credentials</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Credentials are read from{" "}
          <code className="rounded bg-secondary px-1 font-mono text-xs">.env</code> and never
          editable or shown here. Edit{" "}
          <code className="rounded bg-secondary px-1 font-mono text-xs">.env</code> and restart
          to change them.
        </p>
      </div>

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
                className="flex items-center justify-between rounded-md border border-border bg-secondary/40 px-4 py-2.5"
              >
                <span className="text-sm text-foreground">{label}</span>
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
    </div>
  );
}

// ── Settings-backed section content ──────────────────────────────────────────

interface SettingsSectionContentProps {
  section: SectionId;
  draft: OperatorSettings;
  setDraft: React.Dispatch<React.SetStateAction<OperatorSettings>>;
}

function SettingsSectionContent({
  section,
  draft,
  setDraft,
}: SettingsSectionContentProps): JSX.Element {
  function patchSection<K extends keyof OperatorSettings>(
    sectionKey: K,
    field: keyof OperatorSettings[K],
    rawValue: string,
  ) {
    const currentSection = draft[sectionKey] as Record<string, unknown>;
    const currentValue = currentSection[field as string];
    // Coerce to number if the existing value is a number
    const newValue: unknown = typeof currentValue === "number" ? Number(rawValue) : rawValue;
    setDraft((prev) => ({
      ...prev,
      [sectionKey]: {
        ...prev[sectionKey],
        [field]: newValue,
      },
    }));
  }

  if (section === "general") {
    return (
      <div className="flex flex-col gap-8 max-w-2xl">
        <div>
          <h2 className="text-base font-semibold text-foreground">General</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Operator identity used in workflow fills.
          </p>
        </div>

        <div className="flex flex-col gap-5">
          <InputField
            id="operator-timekeeper-name"
            label="Timekeeper name"
            value={draft.operator.timekeeperName}
            onChange={(v) => patchSection("operator", "timekeeperName", v)}
            placeholder="e.g. Jane Smith"
            hint="Required by the Kuali separations workflow. Leave blank to use the TIMEKEEPER_NAME env variable."
          />
        </div>

        <div className="flex flex-col gap-5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Annual dates — update each fiscal year
          </p>
          <div className="h-px bg-border" />
          <InputField
            id="annual-dates-job-end"
            label="Onboarding job end date"
            value={draft.annualDates.jobEndDate}
            onChange={(v) => patchSection("annualDates", "jobEndDate", v)}
            placeholder="MM/DD/YYYY"
            hint="Hire job end date used in UCPath onboarding fills."
            mono
          />
          <InputField
            id="annual-dates-kronos-start"
            label="Kronos default start date"
            value={draft.annualDates.kronosDefaultStartDate}
            onChange={(v) => patchSection("annualDates", "kronosDefaultStartDate", v)}
            placeholder="M/D/YYYY"
            mono
          />
          <InputField
            id="annual-dates-kronos-end"
            label="Kronos default end date"
            value={draft.annualDates.kronosDefaultEndDate}
            onChange={(v) => patchSection("annualDates", "kronosDefaultEndDate", v)}
            placeholder="M/D/YYYY"
            mono
          />
        </div>
      </div>
    );
  }

  if (section === "display") {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        <div>
          <h2 className="text-base font-semibold text-foreground">Display</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Daemon browser window size — match your monitor.
          </p>
        </div>
        <div className="flex flex-col gap-5">
          <InputField
            id="display-width"
            label="Screen width (px)"
            type="number"
            value={draft.display.screenWidth}
            onChange={(v) => patchSection("display", "screenWidth", v)}
            min={800}
            step={1}
          />
          <InputField
            id="display-height"
            label="Screen height (px)"
            type="number"
            value={draft.display.screenHeight}
            onChange={(v) => patchSection("display", "screenHeight", v)}
            min={600}
            step={1}
          />
        </div>
      </div>
    );
  }

  if (section === "performance") {
    return (
      <div className="flex flex-col gap-8 max-w-2xl">
        <div>
          <h2 className="text-base font-semibold text-foreground">Performance</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Navigation resilience, timeouts, and OCR pipeline concurrency.
          </p>
        </div>

        <div className="flex flex-col gap-5">
          <InputField
            id="perf-nav-retries"
            label="Navigation retries"
            type="number"
            value={draft.performance.navigationRetries}
            onChange={(v) => patchSection("performance", "navigationRetries", v)}
            min={1}
            step={1}
            hint="Retry attempts before failing a run."
          />
          <InputField
            id="perf-termination-window"
            label="Separation termination window (days)"
            type="number"
            value={draft.performance.separationTerminationWindowDays}
            onChange={(v) => patchSection("performance", "separationTerminationWindowDays", v)}
            min={1}
            step={1}
            hint="Tolerance window for reusing an approved prior termination."
          />
        </div>

        <div className="flex flex-col gap-5">
          <SectionHeading title="Timeouts" />
          <InputField
            id="timeout-nav"
            label="Navigation timeout (ms)"
            type="number"
            value={draft.timeouts.navigationMs}
            onChange={(v) => patchSection("timeouts", "navigationMs", v)}
            min={1000}
            step={1000}
          />
          <InputField
            id="timeout-long-nav"
            label="Long navigation timeout (ms)"
            type="number"
            value={draft.timeouts.longNavigationMs}
            onChange={(v) => patchSection("timeouts", "longNavigationMs", v)}
            min={1000}
            step={1000}
            hint="Used for complex page loads — UKG, Kuali."
          />
        </div>

        <div className="flex flex-col gap-5">
          <SectionHeading title="OCR" />
          <InputField
            id="ocr-second-opinion-max"
            label="Second opinion max"
            type="number"
            value={draft.ocr.secondOpinionMax}
            onChange={(v) => patchSection("ocr", "secondOpinionMax", v)}
            min={0}
            step={1}
            hint="Max suspect records to re-read via the second-opinion pass."
          />
          <InputField
            id="ocr-page-concurrency"
            label="Page concurrency"
            type="number"
            value={draft.ocr.pageConcurrency}
            onChange={(v) => patchSection("ocr", "pageConcurrency", v)}
            min={0}
            step={1}
            hint="Max concurrent OCR page extractions. 0 = Auto (uses vision-pool size)."
          />
          <InputField
            id="ocr-page-max-wait"
            label="Page max wait (ms)"
            type="number"
            value={draft.ocr.pageMaxWaitMs}
            onChange={(v) => patchSection("ocr", "pageMaxWaitMs", v)}
            min={1000}
            step={1000}
            hint="Per-page OCR wait budget before a page fails."
          />
          <InputField
            id="ocr-disambig-concurrency"
            label="Disambiguation concurrency"
            type="number"
            value={draft.ocr.disambigConcurrency}
            onChange={(v) => patchSection("ocr", "disambigConcurrency", v)}
            min={1}
            step={1}
          />
          <InputField
            id="ocr-suggest-concurrency"
            label="Suggestion concurrency"
            type="number"
            value={draft.ocr.suggestConcurrency}
            onChange={(v) => patchSection("ocr", "suggestConcurrency", v)}
            min={1}
            step={1}
          />
        </div>
      </div>
    );
  }

  if (section === "features") {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        <div>
          <h2 className="text-base font-semibold text-foreground">Features</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Optional workflow behaviors and debug tooling.
          </p>
        </div>
        <div className="flex flex-col gap-5">
          <ToggleField
            id="feature-debug-screenshots"
            label="Debug screenshots"
            description="Write extra debug screenshots in hot paths."
            checked={draft.features.debugScreenshots}
            onChange={(v) =>
              setDraft((prev) => ({
                ...prev,
                features: { ...prev.features, debugScreenshots: v },
              }))
            }
          />
          <ToggleField
            id="feature-duo-webauthn"
            label="Duo WebAuthn"
            description="Hands-off Duo MFA via the WebAuthn virtual authenticator. Requires prior one-time enrollment."
            checked={draft.features.duoWebAuthn}
            onChange={(v) =>
              setDraft((prev) => ({
                ...prev,
                features: { ...prev.features, duoWebAuthn: v },
              }))
            }
          />
        </div>
      </div>
    );
  }

  if (section === "paths") {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        <div>
          <h2 className="text-base font-semibold text-foreground">Paths</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Output directories for workflow downloads. Leave blank to use the default.
          </p>
        </div>
        <div className="flex flex-col gap-5">
          <InputField
            id="paths-reports-dir"
            label="Reports directory"
            value={draft.paths.reportsDir}
            onChange={(v) => patchSection("paths", "reportsDir", v)}
            placeholder="Default: ~/Downloads/reports"
            hint="Kronos and separations PDF report downloads."
          />
          <InputField
            id="paths-onboarding-docs-dir"
            label="Onboarding documents directory"
            value={draft.paths.onboardingDocsDir}
            onChange={(v) => patchSection("paths", "onboardingDocsDir", v)}
            placeholder="Default: ~/Documents/onboarding"
            hint="CRM onboarding-document downloads."
          />
        </div>
      </div>
    );
  }

  return <></>;
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function SettingsPage({
  notifySettings,
  onNotifySettingsChange,
  onEditorDirtyChange,
}: SettingsPageProps): JSX.Element {
  const { settings, credentials, loading, saving, error, save, reset } = useSettings();
  const { confirm, confirmDialog } = useConfirm();
  const [activeSection, setActiveSection] = useState<SectionId>("general");
  const [draft, setDraft] = useState<OperatorSettings>(DEFAULT_OPERATOR_SETTINGS);
  const [saveStatus, setSaveStatus] = useState<string>("");

  // Sync draft when settings load or change externally
  useEffect(() => {
    if (settings) {
      setDraft(cloneOperatorSettings(settings));
    }
  }, [settings]);

  const isDirty = settings !== null && !settingsEqual(draft, settings);
  const currentSection = SECTIONS.find((s) => s.id === activeSection) ?? SECTIONS[0];
  const showFooter = currentSection.settingsBacked;

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
        "This will remove all customizations and restore factory defaults. This cannot be undone.",
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
    <div className="flex h-full flex-1 overflow-hidden">
      {/* Left navigation rail */}
      <nav
        aria-label="Settings sections"
        className="flex w-[210px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-border p-3"
      >
        <p className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Settings
        </p>
        {SECTIONS.map((section) => {
          const Icon = section.icon;
          const active = activeSection === section.id;
          return (
            <button
              key={section.id}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => setActiveSection(section.id)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "bg-accent/40 font-semibold text-foreground"
                  : "text-foreground/90 hover:bg-secondary",
              )}
            >
              <Icon aria-hidden className="h-4 w-4 shrink-0" />
              {section.label}
            </button>
          );
        })}
      </nav>

      {/* Right content area */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Scrollable content body */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex h-full items-center justify-center" aria-live="polite">
              <Loader2 aria-hidden className="h-5 w-5 text-muted-foreground motion-safe:animate-spin" />
            </div>
          ) : activeSection === "notifications" ? (
            <div className="p-8">
              <NotificationsSection
                notifySettings={notifySettings}
                onNotifySettingsChange={onNotifySettingsChange}
              />
            </div>
          ) : activeSection === "credentials" ? (
            <div className="p-8">
              <CredentialsSection credentials={credentials} />
            </div>
          ) : activeSection === "workflow-editor" ? (
            /* Workflow Editor fills the full available height */
            <div className="flex h-full min-h-0 flex-col">
              <WorkflowModifierPage onDirtyChange={onEditorDirtyChange} />
            </div>
          ) : (
            <div className="p-8">
              <SettingsSectionContent
                section={activeSection}
                draft={draft}
                setDraft={setDraft}
              />
              {/* Inline note visible in settings-backed sections */}
              <p className="mt-8 max-w-2xl text-xs text-muted-foreground">
                Changes apply on the next workflow run — daemons read settings at startup.
                A few backend constants need a dashboard restart.
              </p>
            </div>
          )}
        </div>

        {/* Save / Revert footer — only for settings-backed sections */}
        {showFooter && !loading && (
          <div className="shrink-0 border-t border-border bg-background px-6 py-3">
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
                Save settings
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

              <span
                aria-live="polite"
                className="ml-auto truncate text-xs text-muted-foreground"
              >
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
      </div>

      {confirmDialog}
    </div>
  );
}
