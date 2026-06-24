// Narrow/re-export from src/config.ts + the OnBase system module. Never
// hardcode URLs/paths here.
export { ONBASE_URL } from "../../config.js";
export {
  ONBASE_EC_DOCUMENT_TYPE,
  ONBASE_PDF_FILE_TYPE,
  ONBASE_EMPLOYEE_LOOKUP_KEYSET,
  ONBASE_EC_DOCUMENT_NAME,
  ONBASE_REQUIRED_KEYWORDS,
} from "../../systems/onbase/index.js";
