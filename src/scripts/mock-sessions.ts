import { writeFileSync, mkdirSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

const DIR = ".tracker";
const FILE = join(DIR, "sessions.jsonl");

if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });

const now = Date.now();
// Use explorer.exe PID so the dashboard treats these mock workflows as "active"
// (rebuildSessionState dims workflows whose start-PID is dead).
function getLivePid(): number {
  try {
    const out = execSync('powershell -NoProfile -Command "Get-Process explorer | Select-Object -First 1 -ExpandProperty Id"', { encoding: "utf-8" });
    const n = parseInt(out.trim(), 10);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {}
  return process.pid;
}
const pid = getLivePid();
const ts = (offsetMs: number) => new Date(now + offsetMs).toISOString();

type Event = {
  type: string;
  timestamp: string;
  pid: number;
  workflowInstance: string;
  sessionId?: string;
  browserId?: string;
  system?: string;
  currentItemId?: string;
  duoRequestId?: string;
};

const events: Event[] = [];
const emit = (e: Omit<Event, "timestamp" | "pid">, offset: number) =>
  events.push({ ...e, timestamp: ts(offset), pid });

// ── Onboarding 1 — CRM done, UCPath in Duo, I9 idle ─────
emit({ type: "workflow_start", workflowInstance: "Onboarding 1" }, -60_000);
emit({ type: "session_create", workflowInstance: "Onboarding 1", sessionId: "Session 1" }, -59_000);
emit({ type: "browser_launch", workflowInstance: "Onboarding 1", sessionId: "Session 1", browserId: "ob1-crm", system: "CRM" }, -58_000);
emit({ type: "browser_launch", workflowInstance: "Onboarding 1", sessionId: "Session 1", browserId: "ob1-ucpath", system: "UCPath" }, -57_000);
emit({ type: "browser_launch", workflowInstance: "Onboarding 1", sessionId: "Session 1", browserId: "ob1-i9", system: "I9" }, -56_000);
emit({ type: "auth_start", workflowInstance: "Onboarding 1", browserId: "ob1-crm", system: "CRM" }, -55_000);
emit({ type: "duo_request", workflowInstance: "Onboarding 1", system: "CRM", duoRequestId: "ob1-crm-req" }, -54_000);
emit({ type: "duo_start", workflowInstance: "Onboarding 1", system: "CRM", duoRequestId: "ob1-crm-req" }, -53_000);
emit({ type: "duo_complete", workflowInstance: "Onboarding 1", system: "CRM", duoRequestId: "ob1-crm-req" }, -40_000);
emit({ type: "auth_complete", workflowInstance: "Onboarding 1", browserId: "ob1-crm", system: "CRM" }, -39_000);
emit({ type: "auth_start", workflowInstance: "Onboarding 1", browserId: "ob1-ucpath", system: "UCPath" }, -20_000);
emit({ type: "duo_request", workflowInstance: "Onboarding 1", system: "UCPath", duoRequestId: "ob1-ucpath-req" }, -19_000);
emit({ type: "item_start", workflowInstance: "Onboarding 1", currentItemId: "alice@ucsd.edu" }, -18_000);

// ── Separation 1 — all 4 browsers authed, mid-item ──────
emit({ type: "workflow_start", workflowInstance: "Separation 1" }, -120_000);
emit({ type: "session_create", workflowInstance: "Separation 1", sessionId: "Session 1" }, -119_000);
emit({ type: "browser_launch", workflowInstance: "Separation 1", sessionId: "Session 1", browserId: "sep1-kuali", system: "Kuali" }, -118_000);
emit({ type: "browser_launch", workflowInstance: "Separation 1", sessionId: "Session 1", browserId: "sep1-oldk", system: "OldKronos" }, -117_000);
emit({ type: "browser_launch", workflowInstance: "Separation 1", sessionId: "Session 1", browserId: "sep1-newk", system: "NewKronos" }, -116_000);
emit({ type: "browser_launch", workflowInstance: "Separation 1", sessionId: "Session 1", browserId: "sep1-ucpath", system: "UCPath" }, -115_000);
emit({ type: "auth_complete", workflowInstance: "Separation 1", browserId: "sep1-kuali", system: "Kuali" }, -110_000);
emit({ type: "auth_complete", workflowInstance: "Separation 1", browserId: "sep1-oldk", system: "OldKronos" }, -105_000);
emit({ type: "auth_start", workflowInstance: "Separation 1", browserId: "sep1-newk", system: "NewKronos" }, -90_000);
emit({ type: "auth_complete", workflowInstance: "Separation 1", browserId: "sep1-newk", system: "NewKronos" }, -85_000);
emit({ type: "auth_complete", workflowInstance: "Separation 1", browserId: "sep1-ucpath", system: "UCPath" }, -70_000);
emit({ type: "item_start", workflowInstance: "Separation 1", currentItemId: "DOC-2026-042" }, -65_000);

// ── EID Lookup 1 — single browser, failed auth ──────────
emit({ type: "workflow_start", workflowInstance: "EID Lookup 1" }, -30_000);
emit({ type: "session_create", workflowInstance: "EID Lookup 1", sessionId: "Session 1" }, -29_000);
emit({ type: "browser_launch", workflowInstance: "EID Lookup 1", sessionId: "Session 1", browserId: "eid1-ucpath", system: "UCPath" }, -28_000);
emit({ type: "auth_start", workflowInstance: "EID Lookup 1", browserId: "eid1-ucpath", system: "UCPath" }, -27_000);
emit({ type: "auth_failed", workflowInstance: "EID Lookup 1", browserId: "eid1-ucpath", system: "UCPath" }, -5_000);

writeFileSync(FILE, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
console.log(`Wrote ${events.length} mock session events to ${FILE}`);
console.log(`PID used: ${pid} (workflow boxes may appear dimmed after this script exits)`);
