export { levenshteinDistance } from "./levenshtein.js";
export {
  scoreNameMatch,
  normalizeUsAddress,
  compareUsAddresses,
  matchAgainstRoster,
  precomputeRoster,
  normalizeEid,
} from "./match.js";
export type {
  NameMatchResult,
  AddressLike,
  NormalizedAddress,
  RosterRow,
  TokenizedRosterRow,
  RosterMatchResult,
} from "./match.js";
export { findLatestRoster, listRosters, loadRoster } from "./roster-loader.js";
export type { RosterFileRef } from "./roster-loader.js";
