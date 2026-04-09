import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { KUALI_SPACE_URL as _KUALI_SPACE_URL, NEW_KRONOS_URL as _NEW_KRONOS_URL, SCREEN } from "../../config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Re-exported from central config ────────────────────────

/** Kuali Build space URL for RRSS separation forms. */
export const KUALI_SPACE_URL = _KUALI_SPACE_URL;

/** New Kronos (WFD) home URL. */
export const NEW_KRONOS_URL = _NEW_KRONOS_URL;

/** Screen dimensions for tiling worker windows. */
export const SCREEN_WIDTH = SCREEN.width;
export const SCREEN_HEIGHT = SCREEN.height;

// ─── Workflow-specific values ────────────────────────────────

/** Batch file containing Kuali document numbers. */
export const BATCH_FILE = join(__dirname, "batch.yaml");

/** UCPath termination templates. */
export const UC_VOL_TERM_TEMPLATE = "UC_VOL_TERM";
export const UC_INVOL_TERM_TEMPLATE = "UC_INVOL_TERM";

/**
 * Involuntary termination types from Kuali.
 * Everything NOT in this list is considered voluntary.
 */
export const INVOLUNTARY_TYPES = ["Never Started Employment"];
