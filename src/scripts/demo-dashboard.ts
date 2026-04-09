/**
 * Demo: seeds sample data for multiple workflows, then launches dashboard.
 * Run: npx tsx src/scripts/demo-dashboard.ts
 */
import { trackEvent, appendLogEntry } from "../tracker/jsonl.js";
import { startDashboard } from "../tracker/dashboard.js";
import { existsSync, rmSync } from "fs";

// Clean previous demo data
if (existsSync(".tracker")) rmSync(".tracker", { recursive: true });

const now = () => new Date().toISOString();
const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();

// ─── Onboarding: 12 employees ───────────────────
const onboarding = [
  { email: "jsmith@ucsd.edu", first: "John", last: "Smith" },
  { email: "mjones@ucsd.edu", first: "Mary", last: "Jones" },
  { email: "agarcia@ucsd.edu", first: "Ana", last: "Garcia" },
  { email: "rwilson@ucsd.edu", first: "Robert", last: "Wilson" },
  { email: "clee@ucsd.edu", first: "Chris", last: "Lee" },
  { email: "dkim@ucsd.edu", first: "Diana", last: "Kim" },
  { email: "epatel@ucsd.edu", first: "Erin", last: "Patel" },
  { email: "fchen@ucsd.edu", first: "Frank", last: "Chen" },
  { email: "gnguyen@ucsd.edu", first: "Grace", last: "Nguyen" },
  { email: "hbrown@ucsd.edu", first: "Henry", last: "Brown" },
  { email: "itaylor@ucsd.edu", first: "Iris", last: "Taylor" },
  { email: "jdavis@ucsd.edu", first: "Jake", last: "Davis" },
];

// 6 done
for (let i = 0; i < 6; i++) {
  const e = onboarding[i];
  trackEvent({
    workflow: "onboarding", timestamp: ago(30 - i * 4), id: e.email,
    status: "done", step: "transaction",
    data: { firstName: e.first, lastName: e.last },
  });
}

// 1 failed
trackEvent({
  workflow: "onboarding", timestamp: ago(8), id: onboarding[6].email,
  status: "failed", step: "extraction",
  data: { firstName: onboarding[6].first, lastName: onboarding[6].last },
  error: "CRM record not found — no active onboarding record for this email",
});

// 3 running
for (let i = 7; i < 10; i++) {
  const e = onboarding[i];
  trackEvent({
    workflow: "onboarding", timestamp: ago(3 - (i - 7)), id: e.email,
    status: "running", step: i === 7 ? "person-search" : i === 8 ? "i9-record" : "transaction",
    data: { firstName: e.first, lastName: e.last },
  });
}

// 2 pending
for (let i = 10; i < 12; i++) {
  const e = onboarding[i];
  trackEvent({
    workflow: "onboarding", timestamp: now(), id: e.email,
    status: "pending", step: "queued",
    data: { firstName: e.first, lastName: e.last },
  });
}

// ─── Kronos Reports: 20 employees ───────────────
const kronosIds = [
  "10042871", "10038922", "10051034", "10029817", "10044563",
  "10037291", "10055018", "10031456", "10048723", "10039182",
  "10052347", "10041098", "10036582", "10049871", "10033214",
  "10057892", "10045631", "10038104", "10050267", "10043519",
];
const kronosNames = [
  "Martinez, Sofia", "Chen, Wei", "Johnson, Amir", "Lee, Sarah", "Patel, Raj",
  "Thompson, Alex", "Nguyen, Linh", "Brown, Derek", "Kim, Yuna", "Garcia, Luis",
  "Wilson, Maya", "Taylor, Jordan", "Davis, Kenji", "Anderson, Nina", "Moore, Sam",
  "Clark, Priya", "White, Tomás", "Harris, Zoe", "Lewis, Omar", "Walker, Mia",
];

// 14 done
for (let i = 0; i < 14; i++) {
  trackEvent({
    workflow: "kronos-reports", timestamp: ago(40 - i * 2), id: kronosIds[i],
    status: "done",
    data: { name: kronosNames[i], saved: "x" },
  });
}

// 2 failed
trackEvent({
  workflow: "kronos-reports", timestamp: ago(10), id: kronosIds[14],
  status: "failed",
  data: { name: kronosNames[14], saved: "" },
  error: "No matches were found on Kronos",
});
trackEvent({
  workflow: "kronos-reports", timestamp: ago(8), id: kronosIds[15],
  status: "failed",
  data: { name: kronosNames[15], saved: "" },
  error: "Mismatch: PDF name 'Clark, P.' does not match expected 'Clark, Priya'",
});

// 3 running
for (let i = 16; i < 19; i++) {
  trackEvent({
    workflow: "kronos-reports", timestamp: ago(2), id: kronosIds[i],
    status: "running",
    data: { name: kronosNames[i], saved: "" },
  });
}

// 1 pending
trackEvent({
  workflow: "kronos-reports", timestamp: now(), id: kronosIds[19],
  status: "pending",
  data: { name: kronosNames[19], saved: "" },
});

// ─── EID Lookup: 8 names ────────────────────────
const eidNames = [
  "Doe, Jane M", "Park, Soo-Jin", "Rivera, Carlos", "Tanaka, Yuki",
  "Al-Hassan, Noor", "Schmidt, Eva", "O'Brien, Liam", "Fernandez, Maria",
];

for (let i = 0; i < 5; i++) {
  trackEvent({
    workflow: "eid-lookup", timestamp: ago(15 - i * 2), id: eidNames[i],
    status: "done",
    data: { emplId: String(10050000 + i * 137), name: eidNames[i] },
  });
}

trackEvent({
  workflow: "eid-lookup", timestamp: ago(4), id: eidNames[5],
  status: "failed",
  data: { emplId: "Not Found", name: eidNames[5] },
});

trackEvent({
  workflow: "eid-lookup", timestamp: ago(1), id: eidNames[6],
  status: "running",
  data: { emplId: "", name: eidNames[6] },
});

trackEvent({
  workflow: "eid-lookup", timestamp: now(), id: eidNames[7],
  status: "pending",
  data: { emplId: "", name: eidNames[7] },
});

// ─── Work Study: 4 entries ──────────────────────
trackEvent({
  workflow: "work-study", timestamp: ago(20), id: "10042871",
  status: "done",
  data: { name: "Martinez, Sofia" },
});
trackEvent({
  workflow: "work-study", timestamp: ago(15), id: "10038922",
  status: "done",
  data: { name: "Chen, Wei" },
});
trackEvent({
  workflow: "work-study", timestamp: ago(5), id: "10051034",
  status: "failed",
  data: { name: "Johnson, Amir" },
  error: "Position pool update failed — PayPath Actions page timeout",
});
trackEvent({
  workflow: "work-study", timestamp: now(), id: "10029817",
  status: "running",
  data: { name: "Lee, Sarah" },
});

// ─── Log entries: jsmith@ucsd.edu (done, ~30 lines) ──────────────────────
{
  const smithLogs = [
    { level: "step", message: "Authenticating to ACT CRM..." },
    { level: "step", message: "SSO: credentials filled via 3-level fallback chain" },
    { level: "step", message: "SSO submit clicked" },
    { level: "waiting", message: "Waiting for Duo approval (approve on your phone)..." },
    { level: "success", message: "Duo MFA approved — authenticated" },
    { level: "success", message: "ACT CRM authenticated" },
    { level: "step", message: "Searching CRM: jsmith@ucsd.edu" },
    { level: "step", message: "Found 1 result(s)..." },
    { level: "step", message: 'CRM field "positionNumber": matched label "Position #" → value "00054321"' },
    { level: "step", message: 'CRM field "firstName": value "John"' },
    { level: "step", message: 'CRM field "lastName": value "Smith"' },
    { level: "step", message: 'CRM field "wage": matched label "Compensation Rate" → value "18.50"' },
    { level: "step", message: 'CRM field "effectiveDate": matched label "First Day of Service" → value "04/15/2026"' },
    { level: "step", message: 'CRM field "ssn": value "***-**-4567"' },
    { level: "step", message: 'CRM field "dob": value "01/15/2004"' },
    { level: "step", message: 'CRM field "phone": value "(555) 123-4567"' },
    { level: "step", message: 'CRM field "email": value "jsmith@ucsd.edu"' },
    { level: "success", message: "CRM extraction complete (14 fields)" },
    { level: "step", message: "Authenticating to UCPath..." },
    { level: "waiting", message: "Waiting for Duo approval (approve on your phone)..." },
    { level: "success", message: "Duo MFA approved — authenticated" },
    { level: "step", message: "Person search: SSN ending 4567" },
    { level: "step", message: "No existing record found — new hire (not rehire)" },
    { level: "step", message: 'Template: "UC_FULL_HIRE" selected for this transaction' },
    { level: "step", message: "Effective Date: 04/15/2026" },
    { level: "step", message: 'Reason: "Hire - No Prior UC Affiliation" selected' },
    { level: "step", message: "Filling Personal Data: John Smith, DOB: 01/15/2004" },
    { level: "step", message: "Phone: Mobile-Personal (555) 123-4567 — set as preferred" },
    { level: "step", message: 'Comp Rate Code: filled "UCHRLY" using grid selector index 0 (hourly)' },
    { level: "step", message: "Compensation Rate: $18.50 filled" },
    { level: "step", message: "Expected Job End Date: 06/30/2026" },
    { level: "success", message: "Transaction saved and submitted — Transaction ID: T0084521" },
  ];
  const smithBase = Date.now() - 30 * 60_000;
  for (let i = 0; i < smithLogs.length; i++) {
    appendLogEntry({
      workflow: "onboarding",
      itemId: "jsmith@ucsd.edu",
      level: smithLogs[i].level as "step" | "success" | "error" | "waiting",
      message: smithLogs[i].message,
      ts: new Date(smithBase - (smithLogs.length - i) * 2000).toISOString(),
    });
  }
}

// ─── Log entries: fchen@ucsd.edu (running, partial flow, ~6 lines) ────────
{
  const chenLogs = [
    { level: "step", message: "Authenticating to ACT CRM..." },
    { level: "success", message: "ACT CRM authenticated" },
    { level: "step", message: "Searching CRM: fchen@ucsd.edu" },
    { level: "step", message: 'CRM field "positionNumber": matched label "Position Number" → value "00067890"' },
    { level: "success", message: "CRM extraction complete (14 fields)" },
    { level: "step", message: "Person search: SSN ending 8901" },
  ];
  const chenBase = Date.now() - 3 * 60_000;
  for (let i = 0; i < chenLogs.length; i++) {
    appendLogEntry({
      workflow: "onboarding",
      itemId: "fchen@ucsd.edu",
      level: chenLogs[i].level as "step" | "success" | "error" | "waiting",
      message: chenLogs[i].message,
      ts: new Date(chenBase - (chenLogs.length - i) * 2000).toISOString(),
    });
  }
}

// ─── Log entries: epatel@ucsd.edu (failed, 2 lines) ──────────────────────
{
  const patelLogs = [
    { level: "step", message: "Searching CRM: epatel@ucsd.edu" },
    { level: "error", message: "CRM record not found — no active onboarding record for this email" },
  ];
  const patelBase = Date.now() - 8 * 60_000;
  for (let i = 0; i < patelLogs.length; i++) {
    appendLogEntry({
      workflow: "onboarding",
      itemId: "epatel@ucsd.edu",
      level: patelLogs[i].level as "step" | "success" | "error" | "waiting",
      message: patelLogs[i].message,
      ts: new Date(patelBase - (patelLogs.length - i) * 2000).toISOString(),
    });
  }
}

// ─── Log entries: 10042871 (kronos, done, ~10 lines) ─────────────────────
{
  const kronosLogs = [
    { level: "step", message: "Filling search: 10042871" },
    { level: "step", message: "Found employee: Martinez, Sofia" },
    { level: "step", message: "Navigating to Reports..." },
    { level: "step", message: 'Report: status "Running" (attempt 1)' },
    { level: "step", message: 'Report: status "Running" (attempt 2)' },
    { level: "step", message: 'Report: status "Complete" (attempt 3)' },
    { level: "step", message: "Download: captured via Playwright event — Time_Detail_10042871.pdf" },
    { level: "step", message: 'PDF: 45231 bytes, name "Martinez, Sofia" matches expected — MATCH' },
    { level: "success", message: "Report downloaded and verified for 10042871" },
  ];
  const kronosBase = Date.now() - 40 * 60_000;
  for (let i = 0; i < kronosLogs.length; i++) {
    appendLogEntry({
      workflow: "kronos-reports",
      itemId: "10042871",
      level: kronosLogs[i].level as "step" | "success" | "error" | "waiting",
      message: kronosLogs[i].message,
      ts: new Date(kronosBase - (kronosLogs.length - i) * 2000).toISOString(),
    });
  }
}

console.log("\n  Seeded demo data:");
console.log("    Onboarding:     12 employees (6 done, 1 failed, 3 running, 2 pending)");
console.log("    Kronos Reports: 20 employees (14 done, 2 failed, 3 running, 1 pending)");
console.log("    EID Lookup:      8 names     (5 done, 1 failed, 1 running, 1 pending)");
console.log("    Work Study:      4 employees (2 done, 1 failed, 1 running)\n");

startDashboard("onboarding", 3838);

console.log("  Dashboard running — open http://localhost:3838");
console.log("  Press Ctrl+C to stop.\n");

// ─── Simulate live updates ──────────────────────
const updates: Array<{ delay: number; wf: string; id: string; status: "running" | "done"; step?: string; data: Record<string, string> }> = [
  { delay: 4, wf: "onboarding", id: "fchen@ucsd.edu", status: "running", step: "person-search", data: { firstName: "Frank", lastName: "Chen" } },
  { delay: 7, wf: "onboarding", id: "fchen@ucsd.edu", status: "running", step: "transaction", data: { firstName: "Frank", lastName: "Chen" } },
  { delay: 10, wf: "onboarding", id: "fchen@ucsd.edu", status: "done", step: "transaction", data: { firstName: "Frank", lastName: "Chen" } },
  { delay: 6, wf: "kronos-reports", id: "10038104", status: "done", data: { name: "Harris, Zoe", saved: "x" } },
  { delay: 9, wf: "kronos-reports", id: "10050267", status: "done", data: { name: "Lewis, Omar", saved: "x" } },
  { delay: 12, wf: "kronos-reports", id: "10043519", status: "running", data: { name: "Walker, Mia", saved: "" } },
  { delay: 15, wf: "kronos-reports", id: "10043519", status: "done", data: { name: "Walker, Mia", saved: "x" } },
  { delay: 8, wf: "eid-lookup", id: "O'Brien, Liam", status: "done", data: { emplId: "10058234", name: "O'Brien, Liam" } },
  { delay: 13, wf: "eid-lookup", id: "Fernandez, Maria", status: "done", data: { emplId: "10059001", name: "Fernandez, Maria" } },
  { delay: 11, wf: "onboarding", id: "gnguyen@ucsd.edu", status: "done", step: "transaction", data: { firstName: "Grace", lastName: "Nguyen" } },
  { delay: 14, wf: "onboarding", id: "itaylor@ucsd.edu", status: "running", step: "extraction", data: { firstName: "Iris", lastName: "Taylor" } },
  { delay: 18, wf: "onboarding", id: "itaylor@ucsd.edu", status: "done", step: "transaction", data: { firstName: "Iris", lastName: "Taylor" } },
  { delay: 16, wf: "work-study", id: "10029817", status: "done", data: { name: "Lee, Sarah" } },
  { delay: 20, wf: "onboarding", id: "jdavis@ucsd.edu", status: "running", step: "extraction", data: { firstName: "Jake", lastName: "Davis" } },
  { delay: 25, wf: "onboarding", id: "jdavis@ucsd.edu", status: "done", step: "transaction", data: { firstName: "Jake", lastName: "Davis" } },
  { delay: 22, wf: "onboarding", id: "hbrown@ucsd.edu", status: "done", step: "transaction", data: { firstName: "Henry", lastName: "Brown" } },
];

for (const u of updates) {
  setTimeout(() => {
    trackEvent({
      workflow: u.wf,
      timestamp: new Date().toISOString(),
      id: u.id,
      status: u.status,
      step: u.step,
      data: u.data,
    });
  }, u.delay * 1000);
}

// ─── Simulate live log updates for fchen transition ──────────────────────
const delayMs = 10 * 1000; // matches fchen "done" transition at delay 10
setTimeout(() => {
  appendLogEntry({
    workflow: "onboarding",
    itemId: "fchen@ucsd.edu",
    level: "step",
    message: "Authenticating to UCPath...",
    ts: new Date().toISOString(),
  });
  appendLogEntry({
    workflow: "onboarding",
    itemId: "fchen@ucsd.edu",
    level: "success",
    message: "Transaction saved — ID: T0084599",
    ts: new Date().toISOString(),
  });
}, delayMs);
