export interface TrackerEntry {
  workflow: string;
  timestamp: string;
  id: string;
  runId?: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  step?: string;
  data?: Record<string, string>;
  error?: string;
  /** First-seen timestamp for this entry (computed by useEntries, not from backend). */
  startTimestamp?: string;
  /** First log timestamp (enriched by backend SSE). */
  firstLogTs?: string;
  /** Last log timestamp (enriched by backend SSE). */
  lastLogTs?: string;
  /** Last log message (enriched by backend SSE, for queue display). */
  lastLogMessage?: string;
}

export interface LogEntry {
  workflow: string;
  itemId: string;
  runId?: string;
  level: "step" | "success" | "error" | "waiting";
  message: string;
  ts: string;
}

export interface RunInfo {
  runId: string;
  status: string;
  step?: string;
  timestamp: string;
}

export interface WorkflowConfig {
  label: string;
  steps: string[];
  detailFields: { key: string; label: string }[];
  getName: (r: TrackerEntry) => string;
  getId: (r: TrackerEntry) => string;
}

export const WF_CONFIG: Record<string, WorkflowConfig> = {
  onboarding: {
    label: "Onboarding",
    steps: ["crm-auth", "extraction", "pdf-download", "ucpath-auth", "person-search", "i9-creation", "transaction"],
    detailFields: [
      { key: "employee", label: "Employee" },
      { key: "email", label: "Email" },
      { key: "departmentNumber", label: "Dept #" },
      { key: "positionNumber", label: "Position #" },
      { key: "wage", label: "Wage" },
      { key: "effectiveDate", label: "Eff Date" },
      { key: "i9ProfileId", label: "I9 Profile" },
      { key: "elapsed", label: "Elapsed" },
    ],
    getName: (r) => [r.data?.firstName, r.data?.lastName].filter(Boolean).join(" "),
    getId: (r) => r.id,
  },
  separations: {
    label: "Separations",
    steps: ["launching", "authenticating", "kuali-extraction", "kronos-search", "ucpath-job-summary", "ucpath-transaction", "kuali-finalization"],
    detailFields: [
      { key: "employee", label: "Employee" },
      { key: "docId", label: "Doc ID" },
      { key: "started", label: "Started" },
      { key: "elapsed", label: "Elapsed" },
    ],
    getName: (r) => r.data?.name || r.data?.employeeName || "",
    getId: (r) => r.id,
  },
  "kronos-reports": {
    label: "Kronos Reports",
    steps: ["searching", "extracting", "downloading"],
    detailFields: [
      { key: "employee", label: "Employee" },
      { key: "id", label: "ID" },
      { key: "started", label: "Started" },
      { key: "elapsed", label: "Elapsed" },
    ],
    getName: (r) => r.data?.name || "",
    getId: (r) => r.id,
  },
  "eid-lookup": {
    label: "EID Lookup",
    steps: ["ucpath-auth", "searching", "crm-auth", "cross-verification"],
    detailFields: [
      { key: "searchName", label: "Search Name" },
      { key: "emplId", label: "Empl ID" },
      { key: "started", label: "Started" },
      { key: "elapsed", label: "Elapsed" },
    ],
    getName: (r) => r.data?.name || "",
    getId: (r) => r.id,
  },
  "work-study": {
    label: "Work Study",
    steps: ["ucpath-auth", "transaction"],
    detailFields: [
      { key: "employee", label: "Employee" },
      { key: "emplId", label: "Empl ID" },
      { key: "started", label: "Started" },
      { key: "elapsed", label: "Elapsed" },
    ],
    getName: (r) => r.data?.name || "",
    getId: (r) => r.id,
  },
  "emergency-contact": {
    label: "Emergency Contact",
    steps: ["navigation", "fill-form", "save"],
    detailFields: [
      { key: "employeeName", label: "Employee" },
      { key: "emplId", label: "Empl ID" },
      { key: "contactName", label: "Contact" },
      { key: "relationship", label: "Relationship" },
    ],
    getName: (r) => r.data?.employeeName || "",
    getId: (r) => r.id,
  },
};

export const TAB_ORDER = ["onboarding", "separations", "kronos-reports", "eid-lookup", "work-study", "emergency-contact"];

export function getConfig(wf: string): WorkflowConfig {
  if (WF_CONFIG[wf]) return WF_CONFIG[wf];
  return {
    label: wf.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    steps: [],
    detailFields: [
      { key: "id", label: "ID" },
      { key: "started", label: "Started" },
      { key: "elapsed", label: "Elapsed" },
    ],
    getName: () => "",
    getId: (r) => r.id,
  };
}

const STEP_ABBREVIATIONS: Record<string, string> = {
  ucpath: "UCPath",
  kuali: "Kuali",
  kronos: "Kronos",
  crm: "CRM",
  sso: "SSO",
  ukg: "UKG",
  pdf: "PDF",
  i9: "I-9",
};

export function formatStepName(step: string): string {
  return step
    .replace(/-/g, " ")
    .replace(/\b\w+/g, (w) => STEP_ABBREVIATIONS[w.toLowerCase()] || w.charAt(0).toUpperCase() + w.slice(1));
}

export type LogCategory = "fill" | "navigate" | "extract" | "search" | "select" | "auth" | "download" | "success" | "error" | "waiting" | "step";

export function getLogCategory(level: string, message: string): LogCategory {
  if (level === "success") return "success";
  if (level === "error") return "error";
  if (level === "waiting") return "waiting";
  const msg = (message || "").toLowerCase();
  if (msg.includes("fill") || msg.includes("comp rate") || msg.includes("compensation")) return "fill";
  if (msg.includes("click") || msg.includes("navigat")) return "navigate";
  if (msg.includes("crm field") || msg.includes("extract") || msg.includes("matched label")) return "extract";
  if (msg.includes("search") || msg.includes("found") || msg.includes("result") || msg.includes("person search")) return "search";
  if (msg.includes("select") || msg.includes("dropdown") || msg.includes("template") || msg.includes("reason")) return "select";
  if (msg.includes("sso") || msg.includes("duo") || msg.includes("auth") || msg.includes("credential") || msg.includes("login")) return "auth";
  if (msg.includes("download") || msg.includes("pdf") || msg.includes("report")) return "download";
  return "step";
}

// ── Session Panel Types ────────────────────────────────

export type AuthState = "idle" | "authenticating" | "authed" | "duo_waiting" | "failed";

export interface BrowserState {
  browserId: string;
  system: string;
  authState: AuthState;
}

export interface SessionInfo {
  sessionId: string;
  browsers: BrowserState[];
}

export interface WorkflowInstanceState {
  instance: string;
  active: boolean;
  /** True while the spawning Node process (and therefore its Playwright browsers) is still alive. */
  pidAlive: boolean;
  currentItemId: string | null;
  currentStep: string | null;
  finalStatus: "done" | "failed" | null;
  sessions: SessionInfo[];
}

export interface DuoQueueEntry {
  position: number;
  requestId: string;
  system: string;
  instance: string;
  state: "waiting" | "active";
}

export interface SessionState {
  workflows: WorkflowInstanceState[];
  duoQueue: DuoQueueEntry[];
}
