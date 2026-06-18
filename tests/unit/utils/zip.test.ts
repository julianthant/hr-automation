import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { zipFolderInto, withFileLock } from "../../../src/utils/zip.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "zip-util-test-"));
}

/** List the entry paths stored inside a zip archive (via `unzip -Z1`). */
function listArchive(archivePath: string): string[] {
  const out = execFileSync("unzip", ["-Z1", archivePath], { encoding: "utf8" });
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

describe("zipFolderInto", () => {
  test("creates an archive containing the folder by its basename", async (t) => {
    const root = tmp();
    t.onTestFinished(() => { execFileSync("rm", ["-rf", root]); });
    const folder = join(root, "Smith, John (Johnny) Michael EID");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "offer.pdf"), "%PDF-1.4 fake");

    const archive = join(root, "out.zip");
    await zipFolderInto(archive, folder);

    assert.ok(existsSync(archive));
    const entries = listArchive(archive);
    assert.ok(
      entries.some((e) => e.startsWith("Smith, John (Johnny) Michael EID/")),
      `expected folder-name-prefixed entries, got: ${entries.join(", ")}`,
    );
    assert.ok(entries.some((e) => e.endsWith("offer.pdf")));
    // Stored by basename, never the absolute path.
    assert.ok(!entries.some((e) => e.includes(root)));
  });

  test("appends a second folder into the same archive", async (t) => {
    const root = tmp();
    t.onTestFinished(() => { execFileSync("rm", ["-rf", root]); });
    const a = join(root, "Doe, Jane EID");
    const b = join(root, "Roe, Rick EID");
    for (const f of [a, b]) {
      mkdirSync(f, { recursive: true });
      writeFileSync(join(f, "doc.pdf"), "%PDF-1.4 fake");
    }

    const archive = join(root, "combined.zip");
    await zipFolderInto(archive, a);
    await zipFolderInto(archive, b);

    const entries = listArchive(archive);
    assert.ok(entries.some((e) => e.startsWith("Doe, Jane EID/")));
    assert.ok(entries.some((e) => e.startsWith("Roe, Rick EID/")));
  });
});

describe("withFileLock", () => {
  test("serializes concurrent critical sections", async (t) => {
    const root = tmp();
    t.onTestFinished(() => { execFileSync("rm", ["-rf", root]); });
    const lock = join(root, "x.lock");

    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    const run = (n: number) =>
      withFileLock(
        lock,
        async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 15));
          order.push(n);
          active -= 1;
        },
        { retryMs: 5 },
      );

    await Promise.all([run(1), run(2), run(3)]);

    assert.equal(maxActive, 1, "only one holder at a time");
    assert.deepEqual([...order].sort(), [1, 2, 3]);
    assert.ok(!existsSync(lock), "lock released after use");
  });

  test("steals an abandoned (stale) lock", async (t) => {
    const root = tmp();
    t.onTestFinished(() => { execFileSync("rm", ["-rf", root]); });
    const lock = join(root, "stale.lock");
    writeFileSync(lock, ""); // pre-existing lock from a "crashed" holder

    let ran = false;
    await withFileLock(lock, async () => { ran = true; }, { staleMs: 0, retryMs: 5 });

    assert.ok(ran, "stole the stale lock and ran");
    assert.ok(!existsSync(lock));
  });

  test("releases the lock even when the body throws", async (t) => {
    const root = tmp();
    t.onTestFinished(() => { execFileSync("rm", ["-rf", root]); });
    const lock = join(root, "throw.lock");

    await assert.rejects(
      withFileLock(lock, async () => { throw new Error("boom"); }),
      /boom/,
    );
    assert.ok(!existsSync(lock), "lock released after throw");
    assert.ok(readdirSync(root).length === 0);
  });
});
