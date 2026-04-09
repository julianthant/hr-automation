import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { PATHS, SCREEN, ANNUAL_DATES } from "../../config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Re-exported from central config ────────────────────────

/** Directory where downloaded PDF reports are saved. */
export const REPORTS_DIR = PATHS.reportsDir;

/** Base directory for persistent UKG browser sessions. */
export const SESSION_DIR = PATHS.ukgSessionBase;

/** Default date range for Time Detail reports. */
export const DEFAULT_START_DATE = ANNUAL_DATES.kronosDefaultStartDate;
export const DEFAULT_END_DATE = ANNUAL_DATES.kronosDefaultEndDate;

/** Screen dimensions for tiling worker windows. */
export const SCREEN_WIDTH = SCREEN.width;
export const SCREEN_HEIGHT = SCREEN.height;

// ─── Workflow-specific values ────────────────────────────────

/** Default number of parallel workers. */
export const DEFAULT_WORKERS = 4;

/** Batch file containing employee IDs. */
export const BATCH_FILE = join(__dirname, "batch.yaml");

/** Tracker Excel file path. */
export const TRACKER_PATH = join(__dirname, "kronos-tracker.xlsx");
