import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeStateDbForTests, openStateDb } from "../../../src/tracker/state/db.js";

describe("file registration snapshot integrity", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "file-register-race-"));
  });

  afterEach(() => {
    closeStateDbForTests(dir);
    vi.doUnmock("node:fs");
    vi.resetModules();
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("hashes and persists one immutable snapshot even if the source changes mid-registration", async () => {
    const source = join(dir, "upload.pdf");
    const original = Buffer.from("first complete upload");
    writeFileSync(source, original);
    const replacement = Buffer.from("different bytes written after the first read");
    let triggered = false;
    const paths: string[] = [];
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        readFileSync(path: import("node:fs").PathOrFileDescriptor, ...args: unknown[]) {
          paths.push(String(path));
          const bytes = actual.readFileSync(
            path,
            ...(args as Parameters<typeof actual.readFileSync> extends [unknown, ...infer Rest] ? Rest : never),
          );
          if (String(path) === source && !triggered) {
            triggered = true;
            actual.writeFileSync(source, replacement);
          }
          return bytes;
        },
      };
    });
    const { registerLocalFile } = await import("../../../src/tracker/files/files.js");

    const registered = registerLocalFile(openStateDb(dir), {
      trackerDir: dir,
      kind: "pdf",
      mimeType: "application/pdf",
      path: source,
      originalName: "upload.pdf",
      source: "test",
      workflow: "ocr",
      itemId: "item-1",
      runId: "run-1",
    });

    expect(triggered, `observed reads: ${paths.join(", ")}`).toBe(true);
    expect(registered.sha256).toBe(createHash("sha256").update(original).digest("hex"));
    expect(readFileSync(registered.storagePath)).toEqual(original);
  });
});
