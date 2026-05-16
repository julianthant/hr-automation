export { levenshteinDistance } from "./levenshtein.js";
export { normalizeEid } from "../../domain/identity/eid.js";
export {
  scoreNameMatch,
  normalizeUsAddress,
  compareUsAddresses,
  matchAgainstRoster,
  precomputeRoster,
} from "./match.js";
export type {
  NameMatchResult,
  AddressLike,
  NormalizedAddress,
  RosterRow,
  TokenizedRosterRow,
  RosterMatchResult,
} from "./match.js";
export {
  __resetRosterCacheForTests,
  findLatestRoster,
  listRosters,
  loadRoster,
} from "./roster-loader.js";
export type { RosterFileRef } from "./roster-loader.js";
