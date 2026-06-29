// Assemble the Workflow Data Bank from the mined raw fragments.
//
// Reads:
//   config/workflow-design/data-bank/raw/systems/<sys>.json   (DataBankOperation[])
//   config/workflow-design/data-bank/raw/workflows/<wf>.json  (WorkflowDataBank)
//   config/workflow-design/data-bank/raw/<wf>.json            (combined { workflow, systemOps } — the pilot shape)
// Writes (assembled, deduped):
//   config/workflow-design/data-bank/systems/<sys>.json       (SystemCatalog)
//   config/workflow-design/data-bank/workflows/<wf>.json      (WorkflowDataBank)
//   config/workflow-design/data-bank/index.json               (DataBank — the palette loads this)
//
// Pure `buildDataBankFromRaw(...)` is exported for tests; `main()` does the I/O.
// Run with: `npm run data-bank:build`

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assembleDataBank,
  findOrphanOperationIds,
  type DataBank,
  type DataBankOperation,
  type WorkflowDataBank,
} from "../../domain/workflow-design/data-bank.js";
import { isMainModule } from "../main-module.js";

const DATA_BANK_DIR = "config/workflow-design/data-bank";

/** Display order (anything unlisted sorts after, then alpha); control flow last. */
const SYSTEM_ORDER = [
  "ucpath",
  "kuali",
  "crm",
  "i9",
  "new-kronos",
  "old-kronos",
  "servicenow",
  "sharepoint",
  "onbase",
  "control",
];

const SYSTEM_LABELS: Record<string, string> = {
  ucpath: "UCPath",
  kuali: "Kuali",
  crm: "CRM (ACT)",
  i9: "I-9",
  "new-kronos": "New Kronos",
  "old-kronos": "Old Kronos",
  servicenow: "ServiceNow",
  sharepoint: "SharePoint",
  onbase: "OnBase",
  control: "Control flow",
};

export interface RawFragments {
  /** Flat pool of every system palette op (from raw/systems/*.json + any combined). */
  systemOps: DataBankOperation[];
  /** Every workflow's sequence (from raw/workflows/*.json + any combined). */
  workflows: WorkflowDataBank[];
}

/** Assemble + diagnose. Pure given the parsed fragments + a timestamp. */
export function buildDataBankFromRaw(
  raw: RawFragments,
  generatedAt: string,
): { bank: DataBank; orphans: string[] } {
  const bank = assembleDataBank({
    generatedAt,
    systemOps: raw.systemOps,
    workflows: raw.workflows,
    systemOrder: SYSTEM_ORDER,
    labelOverrides: SYSTEM_LABELS,
  });
  return { bank, orphans: findOrphanOperationIds(bank) };
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function listJson(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(dir, f));
}

/** Gather every raw fragment from disk into the flat pools the assembler wants. */
function collectRawFragments(root: string): RawFragments {
  const rawDir = join(root, DATA_BANK_DIR, "raw");
  const systemOps: DataBankOperation[] = [];
  const workflows: WorkflowDataBank[] = [];

  for (const file of listJson(join(rawDir, "systems"))) {
    const ops = readJson(file) as DataBankOperation[];
    if (Array.isArray(ops)) systemOps.push(...ops);
    else console.warn(`[data-bank] ${file}: expected DataBankOperation[], skipping`);
  }

  for (const file of listJson(join(rawDir, "workflows"))) {
    const wf = readJson(file) as WorkflowDataBank;
    if (wf && Array.isArray(wf.steps)) workflows.push(wf);
    else console.warn(`[data-bank] ${file}: expected WorkflowDataBank, skipping`);
  }

  // Combined fragments at raw/<wf>.json (the pilot shape: { workflow, systemOps }).
  for (const file of listJson(rawDir)) {
    const obj = readJson(file) as { workflow?: WorkflowDataBank; systemOps?: DataBankOperation[] };
    if (obj?.workflow && Array.isArray(obj.workflow.steps)) workflows.push(obj.workflow);
    if (Array.isArray(obj?.systemOps)) systemOps.push(...obj.systemOps);
  }

  return { systemOps, workflows };
}

function main(): void {
  const root = process.cwd();
  const outDir = join(root, DATA_BANK_DIR);
  const raw = collectRawFragments(root);

  if (!raw.systemOps.length && !raw.workflows.length) {
    console.error(`[data-bank] no raw fragments under ${DATA_BANK_DIR}/raw — run the mining first.`);
    process.exit(1);
  }

  const { bank, orphans } = buildDataBankFromRaw(raw, new Date().toISOString());

  mkdirSync(join(outDir, "systems"), { recursive: true });
  mkdirSync(join(outDir, "workflows"), { recursive: true });
  for (const cat of bank.systems) {
    writeFileSync(join(outDir, "systems", `${cat.system}.json`), JSON.stringify(cat, null, 2) + "\n");
  }
  for (const wf of bank.workflows) {
    writeFileSync(join(outDir, "workflows", `${wf.workflow}.json`), JSON.stringify(wf, null, 2) + "\n");
  }
  writeFileSync(join(outDir, "index.json"), JSON.stringify(bank, null, 2) + "\n");

  const totalOps = bank.systems.reduce((n, s) => n + s.operations.length, 0);
  console.log(`[data-bank] ${bank.systems.length} systems · ${totalOps} palette ops · ${bank.workflows.length} workflows`);
  for (const s of bank.systems) console.log(`  ${s.label.padEnd(14)} ${s.operations.length} ops`);
  if (orphans.length) {
    console.warn(`[data-bank] ${orphans.length} workflow op id(s) not in any system palette:`);
    for (const id of orphans.slice(0, 25)) console.warn(`    ${id}`);
    if (orphans.length > 25) console.warn(`    … +${orphans.length - 25} more`);
  }
  console.log(`[data-bank] wrote ${join(DATA_BANK_DIR, "index.json")}`);
}

if (isMainModule(import.meta.url)) main();
