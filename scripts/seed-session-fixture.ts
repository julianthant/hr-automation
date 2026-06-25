/**
 * Seed a synthetic SESSION-PANEL fixture into an isolated tracker dir so the
 * real dashboard can be booted against it and verified headless with
 * `playwright-cli` — no live daemon / Duo / browsers needed.
 *
 * It writes session events with the SAME production emitters the daemon uses
 * (`emitWorkflowStart` / `emitBrowserLaunch` / `emitBrowserHealth` / …), so the
 * fixture can never drift from the event schema. It then STAYS ALIVE: the
 * session panel only shows a card whose `workflow_start.pid` is a live process
 * (`process.kill(pid, 0)`), and that pid is this script's pid — so kill this
 * process when you're done screenshotting.
 *
 * Usage:
 *   tsx scripts/seed-session-fixture.ts [trackerDir]
 *   (default trackerDir: generated/.dashboard-preview/tracker — gitignored)
 *
 * Then, in another shell:
 *   npm run build:dashboard
 *   HRAUTO_TRACKER_DIR=generated/.dashboard-preview/tracker npm run dashboard:prod
 *   # → drive http://localhost:3838 with playwright-cli
 *
 * The fixture covers every per-browser RENDER state in one view: healthy,
 * refreshing, unhealthy (+reason+url), failed (+reason+url+recovery-trail),
 * and auto-recovery-paused — across an in-flight card and an idle card — so a
 * single screenshot exercises the tiles, the drawer-bar health summary, and
 * (on hover/click) the controls + peek modal.
 */
import { mkdirSync } from "node:fs";
import {
  emitWorkflowStart,
  emitSessionCreate,
  emitBrowserLaunch,
  emitAuthComplete,
  emitBrowserHealth,
  emitItemStart,
  emitStepChange,
  emitDaemonPhase,
  type BrowserHealthStatus,
} from "../src/tracker/session-events.js";
import { sessionsDir } from "../src/tracker/paths.js";

const dir = process.argv[2] ?? "generated/.dashboard-preview/tracker";
mkdirSync(sessionsDir(dir), { recursive: true });

type Health = [status: BrowserHealthStatus, reason: string | undefined, url: string | undefined, paused: boolean];

function seedBrowser(instance: string, sessionId: string, sysId: string, sysLabel: string, seq: Health[]): void {
  emitBrowserLaunch(instance, sessionId, sysId, sysLabel, dir);
  emitAuthComplete(instance, sysId, sysLabel, dir);
  for (const [status, reason, url, paused] of seq) {
    emitBrowserHealth(instance, sysId, sysLabel, status, reason, dir, url, paused);
  }
}

const UCPATH_OK = "https://ucpath.universityofcalifornia.edu/psc/ucphrprd/EMPLOYEE/HRMS/c/NUI_FRAMEWORK.PT_AGSTARTPAGE_NUI.GBL";
const CRM_OK = "https://crickportal-ext.bfs.ucsd.edu/apex/case";
const KUALI_OK = "https://kualibuild.com/app/builder/app/run";
const SSO = "https://a5.ucsd.edu/idp/profile/SAML2/Redirect/SSO";

// ── Card 1: Separation 1 — in-flight, browsers across every health state ──
const sep = "Separation 1";
emitWorkflowStart(sep, dir);
emitSessionCreate(sep, "1", dir);
seedBrowser(sep, "1", "ucpath", "UCPath", [["healthy", undefined, UCPATH_OK, false]]);
// A flapping browser that ended up failed on the SSO host (trail + url).
seedBrowser(sep, "1", "crm", "CRM", [
  ["healthy", undefined, CRM_OK, false],
  ["refreshing", undefined, CRM_OK, false],
  ["unhealthy", "page unresponsive (execution context lost)", CRM_OK, false],
  ["failed", "session expired — re-auth needed", SSO, false],
]);
seedBrowser(sep, "1", "kuali", "Kuali", [["refreshing", undefined, KUALI_OK, false]]);
// Auto-recovery paused (degraded but the monitor won't act).
seedBrowser(sep, "1", "new-kronos", "Kronos", [
  ["unhealthy", "page unresponsive (auto-recovery paused)", "https://kronos.ucsd.edu/wfc/navigator", true],
]);
emitItemStart(sep, "10012345", dir, "run-sep-1", "os-143012-a3f1");
emitStepChange(sep, "fill-form", dir);

// ── Card 2: Person Lookup 1 — idle, all healthy ──
const pl = "Person Lookup 1";
emitWorkflowStart(pl, dir);
emitSessionCreate(pl, "1", dir);
seedBrowser(pl, "1", "ucpath", "UCPath", [["healthy", undefined, UCPATH_OK, false]]);
seedBrowser(pl, "1", "crm", "CRM", [["healthy", undefined, CRM_OK, false]]);
emitDaemonPhase(pl, "idle", dir);

// eslint-disable-next-line no-console
console.log(
  `[seed-session-fixture] seeded → ${dir} (workflow_start.pid=${process.pid}). ` +
    `Boot the dashboard against HRAUTO_TRACKER_DIR=${dir}; kill this process when done.`,
);

// Stay alive so the seeded cards remain "live" (pidAlive === true).
setInterval(() => {}, 1 << 30);
