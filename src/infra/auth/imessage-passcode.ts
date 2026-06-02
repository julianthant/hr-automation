// Best-effort macOS reader for Duo "Text message passcode" codes delivered to
// the Messages app via Text Message Forwarding.
//
// When HR_AUTOMATION_DUO_SMS=1 and running on macOS, the Duo polling loop can
// select Duo's "Text message passcode" factor, then read the freshly-arrived
// passcode out of ~/Library/Messages/chat.db and submit it automatically — no
// phone interaction. Opt-in; otherwise a no-op.
//
// Design constraints (mirrors voice-cue.ts):
//   * MUST NOT throw. Any DB / decode / platform error is swallowed → undefined.
//   * Gated on macOS + the env flag, read live on each call.
//   * Read-only, fresh DB open per call so WAL-committed rows are always visible.
//
// Storage gotcha: for these forwarded SMS, message.text is NULL — the body lives
// in the message.attributedBody blob (Apple typedstream / NSAttributedString).
// The ASCII run "SMS passcodes: NNNNNNN" survives a latin1 decode of the blob.

import { homedir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Database } from "../sqlite/index.js";

/** Shortcode UCSD Duo SMS passcodes arrive from. */
export const DUO_SMS_SENDER = "386767";

/** Env var that turns the iMessage passcode path on. Any other value disables. */
export const DUO_SMS_ENV_FLAG = "HR_AUTOMATION_DUO_SMS";

/**
 * Default freshness back-grace (ms). The freshness threshold is the SMS-request
 * click time minus this, to absorb sub-second timestamp granularity between our
 * clock and Messages' stored `date`. Small enough that a prior login's code
 * (always minutes+ older) is never reused.
 */
export const FRESHNESS_GRACE_MS = 2_000;

/** ms between the Unix epoch (1970-01-01) and the Apple/Cocoa epoch (2001-01-01). */
const APPLE_EPOCH_OFFSET_MS = 978_307_200_000;

/**
 * Extract the Duo SMS passcode from decoded message text. Matches the observed
 * format `SMS passcodes: 1172584` (6–8 digits), ignoring any trailing
 * `@api-….duosecurity.com #…` line. Returns undefined when the label is absent.
 */
export function extractSmsPasscode(text: string): string | undefined {
  return text.match(/SMS passcodes:\s*(\d{6,8})/i)?.[1];
}

/**
 * Decode an iMessage `attributedBody` blob to a readable string. The blob is an
 * Apple typedstream (NSAttributedString); a latin1 decode preserves the embedded
 * ASCII message run verbatim without producing replacement characters. Returns
 * "" for nullish/empty input.
 */
export function decodeAttributedBody(
  blob: Uint8Array | Buffer | null | undefined,
): string {
  if (!blob || blob.length === 0) return "";
  return Buffer.from(blob).toString("latin1");
}

/**
 * Convert a Unix epoch time (ms) to Apple-epoch nanoseconds, as a BigInt.
 * `message.date` is stored in this unit; current-date values exceed
 * Number.MAX_SAFE_INTEGER, so the freshness threshold must be bound as a BigInt
 * and the comparison done in SQL (never round-trip `date` through a JS number).
 */
export function unixMsToAppleNanos(unixMs: number): bigint {
  return BigInt(Math.floor(unixMs) - APPLE_EPOCH_OFFSET_MS) * 1_000_000n;
}

export interface ImessagePasscodeReaderDeps {
  /** DB opener (default: read-only chat.db open). Injected in tests. */
  openDb?: (path: string) => Database;
  /** chat.db path (default: ~/Library/Messages/chat.db). */
  dbPath?: string;
  /** Platform (default: process.platform). */
  platform?: NodeJS.Platform;
  /** Env flag value. When omitted, read live from process.env on each isEnabled(). */
  envFlagValue?: string | undefined;
  /** Sender shortcode to match (default: DUO_SMS_SENDER). */
  senderId?: string;
}

export interface ImessagePasscodeReader {
  /** True on macOS with the opt-in flag set. */
  isEnabled(): boolean;
  /**
   * Return the newest Duo SMS passcode from a message that arrived after
   * `sinceMs - graceMs`, or undefined (disabled, none fresh, or any error).
   */
  readFreshPasscode(opts: { sinceMs: number; graceMs?: number }): string | undefined;
}

const NEWEST_FRESH_SMS_SQL = `
  SELECT m.attributedBody AS attributedBody, m.text AS text
  FROM message m
  JOIN handle h ON h.ROWID = m.handle_id
  WHERE h.id = :sender AND m.is_from_me = 0 AND m.date > :threshold
  ORDER BY m.date DESC
  LIMIT 1
`;

interface SmsRow {
  attributedBody?: Uint8Array | null;
  text?: string | null;
}

/**
 * Factory: create an iMessage passcode reader with injectable dependencies.
 * Exposed for tests that exercise gating/freshness without touching the real
 * chat.db. The production singleton `duoSmsReader` is created below.
 */
export function createImessagePasscodeReader(
  deps: ImessagePasscodeReaderDeps = {},
): ImessagePasscodeReader {
  const openDb =
    deps.openDb ??
    ((p: string) =>
      openDatabase(p, {
        readonly: true,
        fileMustExist: true,
        applyDefaultPragmas: false,
      }));
  const dbPath = deps.dbPath ?? join(homedir(), "Library", "Messages", "chat.db");
  const platform = deps.platform ?? process.platform;
  const senderId = deps.senderId ?? DUO_SMS_SENDER;
  // Read the flag live each call when not injected, so toggling it mid-process
  // (tests / shell) takes effect without re-instantiating the reader.
  const readFlag = (): string | undefined =>
    deps.envFlagValue !== undefined ? deps.envFlagValue : process.env[DUO_SMS_ENV_FLAG];

  function isEnabled(): boolean {
    return platform === "darwin" && readFlag() === "1";
  }

  function readFreshPasscode({
    sinceMs,
    graceMs = FRESHNESS_GRACE_MS,
  }: {
    sinceMs: number;
    graceMs?: number;
  }): string | undefined {
    if (!isEnabled()) return undefined;
    try {
      const db = openDb(dbPath);
      try {
        const threshold = unixMsToAppleNanos(sinceMs - graceMs);
        const row = db
          .prepare(NEWEST_FRESH_SMS_SQL)
          .get({ sender: senderId, threshold }) as SmsRow | undefined;
        if (!row) return undefined;
        const fromBlob = extractSmsPasscode(decodeAttributedBody(row.attributedBody));
        if (fromBlob) return fromBlob;
        // Fallback to the text column in case macOS/Duo ever populates it.
        if (typeof row.text === "string") return extractSmsPasscode(row.text);
        return undefined;
      } finally {
        db.close();
      }
    } catch {
      // Best-effort — any failure (FDA missing, schema drift, decode error)
      // degrades silently to the caller's fallback path.
      return undefined;
    }
  }

  return { isEnabled, readFreshPasscode };
}

/** Production singleton — env flag read live via isEnabled(). */
export const duoSmsReader = createImessagePasscodeReader();
