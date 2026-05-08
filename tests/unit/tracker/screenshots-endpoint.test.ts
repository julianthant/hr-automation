import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  buildScreenshotsHandler,
  resolveScreenshotPath,
} from "../../../src/tracker/dashboard.js";
import { openStateDb, closeStateDbForTests, stateDbPath } from "../../../src/tracker/state/db.js";
import { trackEvent, emitScreenshotEvent } from "../../../src/tracker/jsonl.js";

const TEST_DIR = ".screenshots-test";

function writeFakePng(filename: string, bytes: number = 16): void {
  writeFileSync(join(TEST_DIR, filename), Buffer.alloc(bytes, 0x89));
}

describe("buildScreenshotsHandler", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("returns [] when directory does not exist", () => {
    const missing = ".screenshots-missing-" + Date.now();
    const handler = buildScreenshotsHandler(missing);
    assert.deepEqual(handler("onboarding", "jane@ucsd.edu"), []);
  });

  it("returns only files matching the <workflow>-<itemId>- prefix", () => {
    // Matching files
    writeFakePng("onboarding-jane@ucsd.edu-transaction-ucpath-1713370000000.png", 100);
    writeFakePng("onboarding-jane@ucsd.edu-transaction-crm-1713370001000.png", 110);
    // Non-matching: different workflow
    writeFakePng("separations-12345-kuali-ucpath-1713370000000.png", 50);
    // Non-matching: different itemId
    writeFakePng("onboarding-other@ucsd.edu-transaction-ucpath-1713370000000.png", 60);
    // Non-matching: wrong extension
    writeFakePng("onboarding-jane@ucsd.edu-notes.txt", 10);

    const handler = buildScreenshotsHandler(TEST_DIR);
    const list = handler("onboarding", "jane@ucsd.edu");
    assert.equal(list.length, 2);
    // Newest first — 1713370001000 > 1713370000000
    assert.equal(
      list[0].filename,
      "onboarding-jane@ucsd.edu-transaction-crm-1713370001000.png",
    );
    assert.equal(list[0].step, "transaction");
    assert.equal(list[0].sizeBytes, 110);
    assert.equal(
      list[1].filename,
      "onboarding-jane@ucsd.edu-transaction-ucpath-1713370000000.png",
    );
  });

  it("parses step names that themselves contain dashes", () => {
    writeFakePng("onboarding-jane-crm-auth-ucpath-1713370000000.png", 50);
    const handler = buildScreenshotsHandler(TEST_DIR);
    const list = handler("onboarding", "jane");
    assert.equal(list.length, 1);
    // Last two segments (ucpath + ts) are stripped; remainder is the step
    assert.equal(list[0].step, "crm-auth");
  });

  it("yields an ISO timestamp derived from the filename's numeric tail", () => {
    writeFakePng("onboarding-jane-step-ucpath-1713370000000.png", 1);
    const handler = buildScreenshotsHandler(TEST_DIR);
    const list = handler("onboarding", "jane");
    assert.equal(list.length, 1);
    // 1713370000000 ms → ISO string starting with the same year/month
    assert.match(list[0].ts, /^2024-/); // epoch ms in 2024
  });

  it("tolerates unparseable timestamps (leaves ts empty)", () => {
    writeFakePng("onboarding-jane-step-ucpath-garbage.png", 1);
    const handler = buildScreenshotsHandler(TEST_DIR);
    const list = handler("onboarding", "jane");
    assert.equal(list.length, 1);
    assert.equal(list[0].ts, "");
  });
});

describe("resolveScreenshotPath (path-traversal guard)", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("resolves a legitimate filename inside the root", () => {
    writeFakePng("onboarding-jane-step-ucpath-1713370000000.png", 1);
    const resolved = resolveScreenshotPath(
      "onboarding-jane-step-ucpath-1713370000000.png",
      TEST_DIR,
    );
    assert.ok(resolved);
    assert.equal(resolved, resolve(TEST_DIR, "onboarding-jane-step-ucpath-1713370000000.png"));
  });

  it("rejects filenames containing path separators", () => {
    assert.equal(resolveScreenshotPath("../etc/passwd", TEST_DIR), null);
    assert.equal(resolveScreenshotPath("sub/foo.png", TEST_DIR), null);
    assert.equal(resolveScreenshotPath("..\\foo.png", TEST_DIR), null);
    assert.equal(resolveScreenshotPath("foo\\bar.png", TEST_DIR), null);
  });

  it("rejects filenames containing traversal sequences", () => {
    assert.equal(resolveScreenshotPath("..foo.png", TEST_DIR), null);
    assert.equal(resolveScreenshotPath("foo..png", TEST_DIR), null);
  });

  it("returns null when file does not exist inside the root", () => {
    assert.equal(resolveScreenshotPath("nope.png", TEST_DIR), null);
  });

  it("rejects empty filenames", () => {
    assert.equal(resolveScreenshotPath("", TEST_DIR), null);
  });
});

describe("SQLite path vs disk fallback parity (grouped handler)", () => {
  let trackerDir: string;
  let shotsDir: string;

  beforeEach(() => {
    trackerDir = mkdtempSync(join(tmpdir(), "scr-ep-parity-"));
    shotsDir = join(trackerDir, "screenshots");
    mkdirSync(shotsDir, { recursive: true });
  });

  afterEach(() => {
    closeStateDbForTests(trackerDir);
    rmSync(trackerDir, { recursive: true, force: true });
  });

  it("SQLite path returns same shape as disk path", async () => {
    const ts = 1713370000000;
    const pngPath = join(shotsDir, `onboarding-jane-form-ucpath-${ts}.png`);
    writeFileSync(pngPath, Buffer.alloc(16, 0x89));

    // Open DB and seed a tracker entry so runs table has workflow+item_id.
    openStateDb(trackerDir);
    trackEvent(
      {
        workflow: "onboarding",
        timestamp: new Date(ts).toISOString(),
        id: "jane",
        runId: "run-ep-1",
        status: "running",
        data: {},
      },
      trackerDir,
    );

    // Emit screenshot event → seeds both sessions.jsonl and SQLite files table.
    emitScreenshotEvent(
      {
        type: "screenshot",
        runId: "run-ep-1",
        ts,
        timestamp: new Date(ts).toISOString(),
        kind: "form",
        label: "step-1",
        step: "onboarding-step",
        files: [{ system: "ucpath", path: pngPath }],
      },
      { dir: trackerDir },
    );

    const handler = buildScreenshotsHandler({
      dir: trackerDir,
      screenshotsDir: shotsDir,
    });
    const fromSqlite = await handler({ workflow: "onboarding", itemId: "jane" });

    // Force legacy fallback: close + delete DB.
    closeStateDbForTests(trackerDir);
    rmSync(stateDbPath(trackerDir), { force: true });

    const handler2 = buildScreenshotsHandler({
      dir: trackerDir,
      screenshotsDir: shotsDir,
    });
    const fromDisk = await handler2({ workflow: "onboarding", itemId: "jane" });

    assert.ok(fromSqlite.length > 0, "SQLite path returned no entries");
    assert.ok(fromDisk.length > 0, "Disk path returned no entries");

    // Spread for null-prototype-row compat before deepEqual.
    assert.deepEqual(
      fromDisk.map((e) => ({ ...e, files: e.files.map((f) => ({ ...f })) })),
      fromSqlite.map((e) => ({ ...e, files: e.files.map((f) => ({ ...f })) })),
    );
  });
});
