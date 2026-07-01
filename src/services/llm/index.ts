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
