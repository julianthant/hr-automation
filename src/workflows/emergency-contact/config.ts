import path from "node:path";
import { UCPATH_SMART_HR_URL } from "../../config.js";

/** UCPath HR Tasks landing — same URL used by other UCPath workflows. */
export const HR_TASKS_URL = UCPATH_SMART_HR_URL;

/**
 * Verified UCPath "Relationship to Employee" dropdown options
 * (mapped live 2026-04-14 via playwright-cli on Catherine Morales Rojas's record).
 *
 * Left-hand = raw handwritten text (lowercased + trimmed) from the paper form.
 * Right-hand = exact option LABEL text in the UCPath <select> (not the value code).
 *
 * The dropdown has NO "Mother"/"Father"/"Mom"/"Dad" options — all map to "Parent".
 * Likewise "Brother"/"Sister" → "Sibling", "Grandma"/"Grandpa" → "Grand Parent",
 * "Aunt"/"Uncle"/"Cousin" → "Other Relative", "Husband"/"Wife" → "Spouse".
 *
 * Actual option list (value=label):
 *   C=Child  H=Contact if Detained/Arrested  NA=Domestic Partner Adult
 *   NC=Domestic Partner Child  HA=Emerg/Detention/Arrest Contact  FR=Friend
 *   GP=Grand Parent  GC=Grandchild  MD=Medical Provider  N=Neighbor
 *   OT=Other  R=Other Relative  P=Parent  RO=Roommate  SB=Sibling
 *   SP=Spouse  W=Ward
 */
export const RELATIONSHIP_MAP: Record<string, string> = {
  // Parents
  mom: "Parent",
  mother: "Parent",
  mum: "Parent",
  ma: "Parent",
  dad: "Parent",
  father: "Parent",
  papa: "Parent",
  pa: "Parent",
  parent: "Parent",
  // Siblings
  brother: "Sibling",
  sister: "Sibling",
  sibling: "Sibling",
  bro: "Sibling",
  sis: "Sibling",
  // Grandparents
  grandmother: "Grand Parent",
  grandma: "Grand Parent",
  grandfather: "Grand Parent",
  grandpa: "Grand Parent",
  "grand parent": "Grand Parent",
  grandparent: "Grand Parent",
  // Children
  child: "Child",
  son: "Child",
  daughter: "Child",
  // Grandchildren
  grandchild: "Grandchild",
  grandson: "Grandchild",
  granddaughter: "Grandchild",
  // Other relatives
  aunt: "Other Relative",
  uncle: "Other Relative",
  cousin: "Other Relative",
  "other relative": "Other Relative",
  // Partners / spouses
  spouse: "Spouse",
  husband: "Spouse",
  wife: "Spouse",
  "domestic partner": "Domestic Partner Adult",
  partner: "Domestic Partner Adult",
  "domestic partner child": "Domestic Partner Child",
  // Friends / misc
  friend: "Friend",
  neighbor: "Neighbor",
  roommate: "Roommate",
  ward: "Ward",
  other: "Other",
  // Emergency-specific
  "medical provider": "Medical Provider",
  doctor: "Medical Provider",
};

/** Fall-back if we see a relationship not in the map. */
export const DEFAULT_RELATIONSHIP = "Other";

export function mapRelationship(raw: string): string {
  const key = raw.trim().toLowerCase();
  return RELATIONSHIP_MAP[key] ?? DEFAULT_RELATIONSHIP;
}

/** Default directory for batch YAMLs, source PNG crops, and rosters. */
export const TRACKER_DIR = path.join(".tracker", "emergency-contact");
export const ROSTERS_DIR = path.join(".tracker", "rosters");
