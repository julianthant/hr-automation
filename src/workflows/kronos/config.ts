import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Directory where downloaded PDF reports are saved. */
export const REPORTS_DIR = "C:\\Users\\juzaw\\Downloads\\reports";

/** Base directory for persistent UKG browser sessions. */
export const SESSION_DIR = "C:\\Users\\juzaw\\ukg_session";

/** Default date range for Time Detail reports. */
export const DEFAULT_START_DATE = "1/01/2017";
export const DEFAULT_END_DATE = "1/31/2026";

/** Default number of parallel workers. */
export const DEFAULT_WORKERS = 4;

/** Screen dimensions for tiling worker windows. */
export const SCREEN_WIDTH = 2560;
export const SCREEN_HEIGHT = 1440;

/** Batch file containing employee IDs. */
export const BATCH_FILE = join(__dirname, "batch.yaml");

/** Tracker Excel file path. */
export const TRACKER_PATH = join(__dirname, "kronos-tracker.xlsx");
