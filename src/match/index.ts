export { levenshteinDistance } from "./levenshtein.js";
export {
  scoreNameMatch,
  normalizeUsAddress,
  compareUsAddresses,
  matchAgainstRoster,
} from "./match.js";
export type {
  NameMatchResult,
  AddressLike,
  NormalizedAddress,
  RosterRow,
  RosterMatchResult,
} from "./match.js";
export { findLatestRoster, listRosters, loadRoster } from "./roster-loader.js";
export type { RosterFileRef } from "./roster-loader.js";
