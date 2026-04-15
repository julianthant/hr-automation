/**
 * Standalone CLI wrapper for downloadSharePointFile().
 *
 * Usage:
 *   tsx --env-file=.env src/scripts/download-sharepoint-roster.ts "<sharepoint-url>"
 *
 * Saves to .tracker/rosters/<timestamp>-<filename>.xlsx.
 * For workflow integration, import downloadSharePointFile from src/utils/sharepoint-download.ts directly.
 */
import path from "node:path";
import { downloadSharePointFile } from "../utils/sharepoint-download.js";
import { validateEnv } from "../utils/env.js";
import { log } from "../utils/log.js";

const url = process.argv[2];
if (!url) {
  console.error('Usage: download-sharepoint-roster "<sharepoint-url>"');
  process.exit(1);
}

validateEnv();

downloadSharePointFile({
  url,
  outDir: path.join(".tracker", "rosters"),
})
  .then((savedPath) => {
    log.success(`Done: ${savedPath}`);
    process.exit(0);
  })
  .catch((e) => {
    log.error(`SharePoint download failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
