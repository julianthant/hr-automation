import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Kuali Build space URL for RRSS separation forms. */
export const KUALI_SPACE_URL =
  "https://ucsd.kualibuild.com/build/space/5e47518b90adda9474c14adb";

/** New Kronos (WFD) home URL. */
export const NEW_KRONOS_URL = "https://ucsd-sso.prd.mykronos.com/wfd/home";

/** Screen dimensions for tiling worker windows. */
export const SCREEN_WIDTH = 2560;
export const SCREEN_HEIGHT = 1440;

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
