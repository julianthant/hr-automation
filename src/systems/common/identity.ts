import { errorMessage } from "../../utils/errors.js";

/**
 * Shared pre-submit **identity gate** primitive.
 *
 * A single-operator tool that files REAL HR transactions must confirm the
 * person/subject actually displayed on the page matches the one it intends to
 * act on BEFORE the irreversible step (Save / Submit / Import). Several systems
 * grew their own hand-rolled version of this check (New Kronos'
 * `verifyPeopleEmployee` / `verifyTimecardEmployee`); this is the extracted,
 * shared, unit-testable core they now delegate to.
 *
 * The comparison is a pure function ({@link checkDisplayedIdentity}) so the
 * match/throw logic is testable without a live page; the async wrapper
 * ({@link assertDisplayedIdentity}) takes an `extract` closure (Playwright-
 * agnostic) and throws a legible error naming EXPECTED vs DISPLAYED on a
 * mismatch — fail loud, never proceed on the wrong person.
 */

/**
 * How to compare `expected` against the displayed text:
 * - `word-boundary` (default): `\bexpected\b` appears somewhere in the displayed
 *   text — for a header/blob where the id sits among other content (e.g. the
 *   New Kronos People `.empName` header "KentHodge, Michele L 10604376", or the
 *   Emergency Contact "Person ID 10877384 Jane Doe" row).
 * - `exact`: the displayed text, trimmed, EQUALS `expected` — for a single
 *   field's read-back value (e.g. the OnBase "UCPath ID" keyword input value).
 */
export type IdentityMatchMode = "word-boundary" | "exact";

export interface IdentityMatchOptions {
  /** Compare mode. Default `word-boundary`. */
  mode?: IdentityMatchMode;
  /**
   * When `expected` is NOT found (word-boundary mode), a regex whose first
   * capture group (or full match) names the COMPETING id actually shown — so the
   * thrown error can name who is displayed instead of the intended person.
   * Defaults to an 8-digit id (UC EIDs / UCPath IDs). Ignored in `exact` mode
   * (the whole displayed value is reported).
   */
  competingIdPattern?: RegExp;
}

/** Outcome of a displayed-identity comparison. */
export interface IdentityCheckResult {
  /** True when the displayed text shows the expected identity. */
  ok: boolean;
  /**
   * The competing/displayed identity actually shown when `ok` is false (for the
   * fail-loud error); null when nothing identifiable was found.
   */
  shown: string | null;
}

/** Escape a literal string for safe embedding in a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pure identity comparison: does `displayed` show `expected`? Returns the match
 * result plus any competing id found (for a fail-loud error). No page, no I/O —
 * unit-pinnable.
 *
 * Throws on an empty `expected` — an identity gate with no expected value can
 * never be a real check, so failing here surfaces the programming error rather
 * than silently passing everything.
 */
export function checkDisplayedIdentity(
  expected: string,
  displayed: string | null | undefined,
  opts: IdentityMatchOptions = {},
): IdentityCheckResult {
  const expectedTrimmed = expected.trim();
  if (!expectedTrimmed) {
    throw new Error(
      "checkDisplayedIdentity: expected identity is empty — cannot verify who is displayed",
    );
  }
  const { mode = "word-boundary", competingIdPattern = /\b\d{8}\b/ } = opts;
  const text = (displayed ?? "").trim();

  const matched =
    mode === "exact"
      ? text === expectedTrimmed
      : new RegExp(`\\b${escapeRegExp(expectedTrimmed)}\\b`).test(text);
  if (matched) return { ok: true, shown: null };

  if (mode === "exact") return { ok: false, shown: text || null };
  const m = text.match(competingIdPattern);
  return { ok: false, shown: m ? (m[1] ?? m[0]) : null };
}

export interface AssertDisplayedIdentityOptions extends IdentityMatchOptions {
  /** The identity we require to be displayed (an EID / UCPath ID / person id). */
  expected: string;
  /**
   * Read the currently-displayed identity text from the page — a single field's
   * value, or a header/blob to word-boundary-match against. Kept as a closure so
   * this primitive stays Playwright-agnostic and testable. A throw here is
   * treated as an INCONCLUSIVE read and fails the gate loud (never a pass).
   */
  extract: () => Promise<string | null>;
  /**
   * Human-readable context for the thrown error, e.g. `"New Kronos timecard"` or
   * `"OnBase import (UCPath ID 10877384)"`.
   */
  context: string;
  /**
   * Re-run `extract` until the identity matches or this many ms elapse — the
   * page may still be switching subjects (batch reuse). Default 0 (single read).
   */
  pollMs?: number;
  /** Poll interval in ms (default 500). Only used when `pollMs > 0`. */
  pollIntervalMs?: number;
  /** Injected sleeper (tests). Default real setTimeout. */
  _sleep?: (ms: number) => Promise<void>;
  /** Injected clock (tests). Default `Date.now`. */
  _now?: () => number;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Assert that the page currently displays `expected`, throwing a legible
 * EXPECTED-vs-DISPLAYED error otherwise. The pre-submit identity gate:
 *
 * ```ts
 * await assertDisplayedIdentity({
 *   expected: eid,
 *   context: "New Kronos People editor",
 *   mode: "word-boundary",
 *   extract: async () => (await header.textContent()) ?? "",
 * });
 * ```
 *
 * Fail-loud contract:
 * - a mismatch throws (names the competing/displayed id when known);
 * - an `extract` throw (frame detached, strict-mode violation) throws — an
 *   inconclusive read must NEVER pass the gate;
 * - an empty displayed value throws (nothing to confirm against).
 */
export async function assertDisplayedIdentity(
  opts: AssertDisplayedIdentityOptions,
): Promise<void> {
  const {
    expected,
    extract,
    context,
    pollMs = 0,
    pollIntervalMs = 500,
    _sleep = realSleep,
    _now = Date.now,
    ...matchOpts
  } = opts;

  const deadline = _now() + pollMs;
  let last: IdentityCheckResult = { ok: false, shown: null };
  for (;;) {
    let displayed: string | null;
    try {
      displayed = await extract();
    } catch (err) {
      throw new Error(
        `${context}: could not read the displayed identity to confirm it matches "${expected}" — ` +
          `refusing to proceed so no action is taken on the wrong person (cause: ${errorMessage(err)})`,
        { cause: err instanceof Error ? err : undefined },
      );
    }
    last = checkDisplayedIdentity(expected, displayed, matchOpts);
    if (last.ok) return;
    if (_now() >= deadline) break;
    await _sleep(pollIntervalMs);
  }

  throw new Error(
    `${context}: displayed identity does not match the expected "${expected}"` +
      (last.shown
        ? ` — the page shows "${last.shown}" instead`
        : " — the expected identity was not found on the page") +
      ". Refusing to proceed so no action is taken on the wrong person.",
  );
}
