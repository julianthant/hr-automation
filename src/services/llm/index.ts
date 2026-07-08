/**
 * Shared free-tier text-LLM client. The text sibling of `services/ocr`'s vision
 * pool: same providers/keys/limits/rotation, but for text prompts. Non-OCR
 * features (sanity gate, failure triage, selector-map assist, run summarization,
 * data normalization) call `completeJson` / `completeText` so a rate-limited
 * provider transparently falls through to the next available one.
 */
export { completeJson, completeText } from "./complete.js";
export type { CompleteOptions, CompleteResult } from "./complete.js";
export { buildTextPool, summarizeTextPool } from "./text-pool.js";
export type { TextPoolKey, LlmProviderId } from "./text-pool.js";
export { resolveAddress } from "../address/index.js";
export type { AddressInput, AddressResolution, ResolvedAddress } from "../address/index.js";
export {
  normalizePhone,
  normalizeUsState,
  normalizeZip,
  canonicalizeRelationship,
  canonicalizeRelationshipRule,
  splitAddressString,
  normalizeEmergencyContactRecord,
  summarizeNormalizationChanges,
  CANONICAL_RELATIONSHIPS,
} from "./normalize-contact.js";
export type { NormalizationChange, CanonicalRelationship, NormalizableEcRecord } from "./normalize-contact.js";
export { triageFailure, summarizeTriage, TRIAGE_CATEGORIES } from "./triage.js";
export type { TriageResult, TriageInput, TriageCategory } from "./triage.js";
export {
  sanityCheckRecord,
  llmCrossFieldCheck,
  runRuleChecks,
  inferRuleSpec,
  hasBlockingIssue,
  summarizeSanityIssues,
  checkEmail,
  checkDob,
  checkEid,
  checkRequired,
} from "./sanity-check.js";
export type { SanityIssue, SanityCheckOptions, CheckableRecord, RuleSpec } from "./sanity-check.js";
export { suggestSelectors } from "./selector-suggest.js";
export type { SelectorCandidate, SuggestSelectorsInput } from "./selector-suggest.js";
export { summarizeRun, RUN_OUTCOMES } from "./summarize-run.js";
export type { RunSummary, RunOutcome, SummarizeRunInput } from "./summarize-run.js";
