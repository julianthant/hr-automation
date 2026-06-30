import { existsSync, readFileSync } from "node:fs";
import { log } from "../../utils/log.js";
import { dataBankIndexFile } from "../paths.js";
import type { DataBank } from "../../domain/workflow-design/data-bank.js";
import { DataBankSchema } from "./schema.js";

/**
 * Read the assembled Data Bank (`config/workflow-design/data-bank/index.json`) —
 * the palette + per-workflow automation the Workflow Graph Editor loads. Built
 * by `npm run data-bank:build` from the mined fragments. Fail-soft on a missing
 * or unreadable file (the editor degrades to no palette rather than erroring).
 */
export function readDataBank(repoRoot: string): DataBank | null {
  const file = dataBankIndexFile(repoRoot);
  if (!existsSync(file)) return null;
  try {
    const parsed = DataBankSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success) {
      log.warn(
        `data bank invalid; ignoring (${parsed.error.issues.map((i) => i.message).join("; ")})`,
      );
      return null;
    }
    return parsed.data as DataBank;
  } catch (err) {
    log.warn(`data bank unreadable; ignoring (${String(err)})`);
    return null;
  }
}
