import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  createImessagePasscodeReader,
  decodeAttributedBody,
  extractSmsPasscode,
  unixMsToAppleNanos,
  DUO_SMS_SENDER,
  FRESHNESS_GRACE_MS,
} from "../../../../src/infra/auth/imessage-passcode.js";
import type { Database as SqliteDatabase } from "../../../../src/infra/sqlite/index.js";

// We never touch the real ~/Library/Messages/chat.db. The reader's `openDb` is
// injected with a fake whose prepared statement returns a row only when the
// bound freshness threshold is older than the row's stored date — mirroring the
// `m.date > :threshold` filter in SQL.

const APPLE_EPOCH_OFFSET_MS = 978_307_200_000;

/** Build an attributedBody-style blob: binary noise around an ASCII run. */
function fakeAttributedBody(body: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x04, 0x0b, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d]),
    Buffer.from(body, "latin1"),
    Buffer.from([0x86, 0x84, 0x02]),
  ]);
}

interface FakeRow {
  attributedBody?: Uint8Array | null;
  text?: string | null;
}

/**
 * Fake DB factory. `dateMs` is when the (single) message "arrived"; the fake
 * statement returns the row only when the bound `threshold` is strictly less
 * than that date — matching `m.date > :threshold`. Tracks open/close/calls.
 */
function makeFakeDb(opts: {
  row: FakeRow;
  dateMs: number;
  log?: { opened: string[]; closed: number; getThresholds: bigint[] };
  throwOnGet?: boolean;
}): { openDb: (p: string) => SqliteDatabase; log: { opened: string[]; closed: number; getThresholds: bigint[] } } {
  const log = opts.log ?? { opened: [], closed: 0, getThresholds: [] };
  const rowDate = unixMsToAppleNanos(opts.dateMs);
  const openDb = (p: string): SqliteDatabase => {
    log.opened.push(p);
    return {
      prepare() {
        return {
          get(params: unknown) {
            if (opts.throwOnGet) throw new Error("get failed");
            const threshold = (params as { threshold: bigint }).threshold;
            log.getThresholds.push(threshold);
            return threshold < rowDate ? opts.row : undefined;
          },
          all() {
            return [];
          },
          run() {
            return { changes: 0, lastInsertRowid: 0 };
          },
          iterate() {
            return [][Symbol.iterator]();
          },
        };
      },
      exec() {},
      close() {
        log.closed += 1;
      },
    } as unknown as SqliteDatabase;
  };
  return { openDb, log };
}

describe("extractSmsPasscode", () => {
  it("extracts the 7-digit code after the label", () => {
    assert.equal(extractSmsPasscode("SMS passcodes: 1172584"), "1172584");
  });

  it("ignores a trailing duosecurity reference line", () => {
    const text = "SMS passcodes: 1172584\n@api-ce13a1a7.duosecurity.com #1687421";
    assert.equal(extractSmsPasscode(text), "1172584");
  });

  it("matches case-insensitively", () => {
    assert.equal(extractSmsPasscode("sms PASSCODES:  654321"), "654321");
  });

  it("finds the code when embedded in surrounding blob noise", () => {
    const decoded = "NSStringSMS passcodes: 8675309";
    assert.equal(extractSmsPasscode(decoded), "8675309");
  });

  it("returns undefined when the label is absent", () => {
    assert.equal(extractSmsPasscode("Your code is 1234567"), undefined);
    assert.equal(extractSmsPasscode(""), undefined);
  });
});

describe("decodeAttributedBody", () => {
  it("recovers the ASCII message run from a typedstream-style blob", () => {
    const decoded = decodeAttributedBody(fakeAttributedBody("SMS passcodes: 1234567"));
    assert.match(decoded, /SMS passcodes: 1234567/);
    assert.equal(extractSmsPasscode(decoded), "1234567");
  });

  it("returns empty string for nullish or empty input", () => {
    assert.equal(decodeAttributedBody(null), "");
    assert.equal(decodeAttributedBody(undefined), "");
    assert.equal(decodeAttributedBody(new Uint8Array(0)), "");
  });

  it("accepts a Uint8Array", () => {
    const decoded = decodeAttributedBody(
      new Uint8Array(Buffer.from("SMS passcodes: 9990001", "latin1")),
    );
    assert.equal(extractSmsPasscode(decoded), "9990001");
  });
});

describe("unixMsToAppleNanos", () => {
  it("maps the Apple epoch to 0n", () => {
    assert.equal(unixMsToAppleNanos(APPLE_EPOCH_OFFSET_MS), 0n);
  });

  it("converts one second past the epoch to 1e9 nanoseconds", () => {
    assert.equal(unixMsToAppleNanos(APPLE_EPOCH_OFFSET_MS + 1000), 1_000_000_000n);
  });

  it("returns a bigint for a recent date that overflows Number.MAX_SAFE_INTEGER", () => {
    const nanos = unixMsToAppleNanos(1_780_000_000_000); // ~2026
    assert.equal(typeof nanos, "bigint");
    assert.ok(nanos > BigInt(Number.MAX_SAFE_INTEGER));
  });
});

describe("createImessagePasscodeReader — gating", () => {
  it("is disabled and never opens the DB when the flag is unset", () => {
    let opened = false;
    const reader = createImessagePasscodeReader({
      platform: "darwin",
      envFlagValue: undefined,
      openDb: () => {
        opened = true;
        throw new Error("should not open");
      },
    });
    assert.equal(reader.isEnabled(), false);
    assert.equal(reader.readFreshPasscode({ sinceMs: Date.now() }), undefined);
    assert.equal(opened, false);
  });

  it('is disabled when the flag is "0"', () => {
    const reader = createImessagePasscodeReader({ platform: "darwin", envFlagValue: "0" });
    assert.equal(reader.isEnabled(), false);
  });

  it('is disabled on non-darwin even when the flag is "1"', () => {
    for (const platform of ["linux", "win32"] as NodeJS.Platform[]) {
      const reader = createImessagePasscodeReader({ platform, envFlagValue: "1" });
      assert.equal(reader.isEnabled(), false, `expected disabled on ${platform}`);
    }
  });

  it('is enabled on darwin with the flag "1"', () => {
    const reader = createImessagePasscodeReader({ platform: "darwin", envFlagValue: "1" });
    assert.equal(reader.isEnabled(), true);
  });
});

describe("createImessagePasscodeReader — freshness", () => {
  it("returns the code when the newest message is newer than the threshold", () => {
    const sinceMs = 1_700_000_000_000;
    const { openDb, log } = makeFakeDb({
      row: { attributedBody: fakeAttributedBody("SMS passcodes: 1172584") },
      dateMs: sinceMs + 4_000, // arrived after the request
    });
    const reader = createImessagePasscodeReader({
      platform: "darwin",
      envFlagValue: "1",
      dbPath: "/fake/chat.db",
      openDb,
    });
    assert.equal(reader.readFreshPasscode({ sinceMs }), "1172584");
    assert.deepEqual(log.opened, ["/fake/chat.db"]);
    assert.equal(log.closed, 1);
  });

  it("returns undefined for a stale message (older than the threshold)", () => {
    const sinceMs = 1_700_000_000_000;
    const { openDb } = makeFakeDb({
      row: { attributedBody: fakeAttributedBody("SMS passcodes: 1172584") },
      dateMs: sinceMs - 60_000, // a code from before this request
    });
    const reader = createImessagePasscodeReader({
      platform: "darwin",
      envFlagValue: "1",
      openDb,
    });
    assert.equal(reader.readFreshPasscode({ sinceMs }), undefined);
  });

  it("applies the back-grace to the threshold", () => {
    const sinceMs = 1_700_000_000_000;
    const { openDb, log } = makeFakeDb({
      row: { attributedBody: fakeAttributedBody("SMS passcodes: 4242424") },
      dateMs: sinceMs,
    });
    const reader = createImessagePasscodeReader({
      platform: "darwin",
      envFlagValue: "1",
      openDb,
    });
    reader.readFreshPasscode({ sinceMs });
    assert.equal(log.getThresholds[0], unixMsToAppleNanos(sinceMs - FRESHNESS_GRACE_MS));
  });

  it("falls back to the text column when the blob yields no code", () => {
    const sinceMs = 1_700_000_000_000;
    const { openDb } = makeFakeDb({
      row: { attributedBody: null, text: "SMS passcodes: 7654321" },
      dateMs: sinceMs + 1_000,
    });
    const reader = createImessagePasscodeReader({
      platform: "darwin",
      envFlagValue: "1",
      openDb,
    });
    assert.equal(reader.readFreshPasscode({ sinceMs }), "7654321");
  });

  it("uses DUO_SMS_SENDER by default", () => {
    let boundSender: string | undefined;
    const openDb = (): SqliteDatabase =>
      ({
        prepare() {
          return {
            get(params: unknown) {
              boundSender = (params as { sender: string }).sender;
              return undefined;
            },
            all: () => [],
            run: () => ({ changes: 0, lastInsertRowid: 0 }),
            iterate: () => [][Symbol.iterator](),
          };
        },
        exec() {},
        close() {},
      }) as unknown as SqliteDatabase;
    const reader = createImessagePasscodeReader({
      platform: "darwin",
      envFlagValue: "1",
      openDb,
    });
    reader.readFreshPasscode({ sinceMs: Date.now() });
    assert.equal(boundSender, DUO_SMS_SENDER);
  });
});

describe("createImessagePasscodeReader — never throws", () => {
  it("returns undefined when openDb throws", () => {
    const reader = createImessagePasscodeReader({
      platform: "darwin",
      envFlagValue: "1",
      openDb: () => {
        throw new Error("FDA not granted");
      },
    });
    assert.doesNotThrow(() => reader.readFreshPasscode({ sinceMs: Date.now() }));
    assert.equal(reader.readFreshPasscode({ sinceMs: Date.now() }), undefined);
  });

  it("closes the DB and returns undefined when the query throws", () => {
    const { openDb, log } = makeFakeDb({
      row: {},
      dateMs: Date.now(),
      throwOnGet: true,
    });
    const reader = createImessagePasscodeReader({
      platform: "darwin",
      envFlagValue: "1",
      openDb,
    });
    assert.equal(reader.readFreshPasscode({ sinceMs: Date.now() }), undefined);
    assert.equal(log.closed, 1, "DB must be closed even when the query throws");
  });
});
