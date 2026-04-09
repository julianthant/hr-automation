export interface TrackerEntry {
  workflow: string;
  timestamp: string;
  id: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  step?: string;
  data?: Record<string, string>;
  error?: string;
}

export interface LogEntry {
  workflow: string;
  itemId: string;
  level: "step" | "success" | "error" | "waiting";
  message: string;
  ts: string;
}

export interface WorkflowConfig {
  label: string;
  columns: string[];
  getName: (r: TrackerEntry) => string;
  getExtra?: (r: TrackerEntry) => Record<string, string>;
}

export const WF_CONFIG: Record<string, WorkflowConfig> = {
  onboarding: {
    label: "Onboarding",
    columns: [
      "id:Email",
      "_name:Employee",
      "status:Status",
      "step:Step",
      "error:Error",
      "timestamp:Time",
    ],
    getName: (r) =>
      [r.data?.firstName, r.data?.lastName].filter(Boolean).join(" "),
  },
  "eid-lookup": {
    label: "EID Lookup",
    columns: [
      "id:Search Name",
      "_emplId:Empl ID",
      "_name:Name",
      "status:Status",
      "timestamp:Time",
    ],
    getName: (r) => r.data?.name || "",
    getExtra: (r) => ({ emplId: r.data?.emplId || "" }),
  },
  "kronos-reports": {
    label: "Kronos Reports",
    columns: [
      "id:Employee ID",
      "_name:Name",
      "status:Status",
      "_saved:Saved",
      "error:Notes",
      "timestamp:Time",
    ],
    getName: (r) => r.data?.name || "",
    getExtra: (r) => ({ saved: r.data?.saved || "" }),
  },
  "work-study": {
    label: "Work Study",
    columns: [
      "id:Empl ID",
      "_name:Employee",
      "status:Status",
      "error:Error",
      "timestamp:Time",
    ],
    getName: (r) => r.data?.name || "",
  },
  separations: {
    label: "Separations",
    columns: [
      "id:Doc ID",
      "_name:Employee",
      "status:Status",
      "step:Step",
      "error:Error",
      "timestamp:Time",
    ],
    getName: (r) => r.data?.name || r.data?.employeeName || "",
  },
};

export const TAB_ORDER = [
  "onboarding",
  "separations",
  "kronos-reports",
  "eid-lookup",
  "work-study",
];

export function getConfig(wf: string): WorkflowConfig {
  if (WF_CONFIG[wf]) return WF_CONFIG[wf];
  return {
    label: wf
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase()),
    columns: ["id:ID", "status:Status", "step:Step", "error:Error", "timestamp:Time"],
    getName: () => "",
  };
}

export function parseColumns(cols: string[]): { key: string; label: string }[] {
  return cols.map((c) => {
    const [key, label] = c.split(":");
    return { key, label };
  });
}

export const STATUS_ORDER: Record<string, number> = {
  running: 0,
  pending: 1,
  failed: 2,
  skipped: 3,
  done: 4,
};

export function getLogAction(
  level: string,
  message: string
): { icon: string; cls: string } {
  if (level === "success") return { icon: "\u2713", cls: "success" };
  if (level === "error") return { icon: "\u2717", cls: "error" };
  if (level === "waiting") return { icon: "\u23F3", cls: "waiting" };
  const msg = (message || "").toLowerCase();
  if (msg.includes("fill") || msg.includes("comp rate") || msg.includes("compensation"))
    return { icon: "\u270E", cls: "fill" };
  if (msg.includes("click") || msg.includes("navigat"))
    return { icon: "\u25CE", cls: "navigate" };
  if (msg.includes("crm field") || msg.includes("extract") || msg.includes("matched label"))
    return { icon: "\u21E3", cls: "extract" };
  if (msg.includes("search") || msg.includes("found") || msg.includes("result") || msg.includes("person search"))
    return { icon: "\u2315", cls: "search" };
  if (msg.includes("select") || msg.includes("dropdown") || msg.includes("template") || msg.includes("reason"))
    return { icon: "\u2630", cls: "select" };
  if (msg.includes("sso") || msg.includes("duo") || msg.includes("auth") || msg.includes("credential") || msg.includes("login"))
    return { icon: "\u26BF", cls: "auth" };
  if (msg.includes("download") || msg.includes("pdf") || msg.includes("report"))
    return { icon: "\u2913", cls: "download" };
  return { icon: "\u2192", cls: "step" };
}
