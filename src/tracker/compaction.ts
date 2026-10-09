import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";

import { transaction, type Database } from "../infra/sqlite/index.js";
import { readDeletedRunKeys } from "./deletions/visible.js";
import { unlinkFileDurable, writeFileAtomic } from "./fs-atomic.js";
import { withExclusiveFileLock, withJsonlAppendLock } from "./jsonl-lock.js";
import { truncateToLastNewline } from "./jsonl-recovery.js";
import {
  compactionArchiveFile,
  compactionJournalFile,
  compactionLockFile,
  compactionPendingFile,
  compactionRuntimeDir,
  logFilePath,
  logsDir,
  parseWorkflowDateFilename,
  rowFilePath,
  rowsDir,
} from "./paths.js";
import { rebuildProjectionForAllDates } from "./state/rebuild.js";

interface CompactionJournal {
  sourcePath: string;
  pendingPath: string;
  archivePath: string;
  originalSha256: string;
  compactedSha256: string;
  generation: number;
  phase: "prepared" | "replaced";
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function readJournal(path: string): CompactionJournal {
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<CompactionJournal>;
  if (
    typeof value.sourcePath !== "string" || typeof value.pendingPath !== "string" ||
    typeof value.archivePath !== "string" || typeof value.originalSha256 !== "string" ||
    typeof value.compactedSha256 !== "string" ||
    !Number.isInteger(value.generation) || (value.generation ?? 0) < 2 ||
    (value.phase !== "prepared" && value.phase !== "replaced")
  ) throw new Error(`Invalid tracker compaction journal: ${path}`);
  return value as CompactionJournal;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !resolve(root, rel).startsWith(`${resolve(root)}..`));
}

function validateJournalPaths(dir: string, journal: CompactionJournal): void {
  const sourceParent = dirname(resolve(journal.sourcePath));
  const kind = sourceParent === resolve(rowsDir(dir))
    ? "rows"
    : sourceParent === resolve(logsDir(dir))
      ? "logs"
      : null;
  const parsed = parseWorkflowDateFilename(basename(journal.sourcePath));
  if (!kind || !parsed || !isInside(dir, journal.sourcePath)) {
    throw new Error(`Invalid compaction source outside tracker root: ${journal.sourcePath}`);
  }
  if (resolve(journal.pendingPath) !== resolve(compactionPendingFile(dir))) {
    throw new Error(`Invalid compaction pending path: ${journal.pendingPath}`);
  }
  const expectedArchive = compactionArchiveFile(
    dir,
    journal.generation - 1,
    kind,
    basename(journal.sourcePath),
  );
  if (
    !isInside(dir, journal.archivePath) ||
    resolve(journal.archivePath) !== resolve(expectedArchive)
  ) {
    throw new Error(`Invalid compaction archive path: ${journal.archivePath}`);
  }
}

function resetAndRebuildProjection(db: Database, dir: string): void {
  transaction(db, () => {
    db.exec("DELETE FROM run_events");
    db.exec("DELETE FROM logs");
    db.exec("DELETE FROM session_events");
    db.exec("DELETE FROM runs");
    db.exec("DELETE FROM items");
    db.exec("DELETE FROM projection_sources");
  });
  rebuildProjectionForAllDates(db, { dir });
}

function finishJournal(db: Database, dir: string): void {
  const journalPath = compactionJournalFile(dir);
  if (!existsSync(journalPath)) return;
  const journal = readJournal(journalPath);
  validateJournalPaths(dir, journal);
  journal.sourcePath = resolve(journal.sourcePath);
  journal.pendingPath = resolve(journal.pendingPath);
  journal.archivePath = resolve(journal.archivePath);
  const archived = existsSync(journal.archivePath) ? readFileSync(journal.archivePath) : null;
  if (archived === null || sha256(archived) !== journal.originalSha256) {
    throw new Error(`Compaction recovery archive hash mismatch: ${journal.archivePath}`);
  }
  let pending: Buffer;
  if (existsSync(journal.pendingPath)) {
    pending = readFileSync(journal.pendingPath);
    if (sha256(pending) !== journal.compactedSha256) {
      throw new Error(`Compaction recovery hash mismatch: ${journal.pendingPath}`);
    }
  } else {
    const replaced = journal.phase === "replaced" && existsSync(journal.sourcePath)
      ? readFileSync(journal.sourcePath)
      : null;
    if (replaced === null || sha256(replaced) !== journal.compactedSha256) {
      throw new Error(`Compaction recovery is missing pending source: ${journal.pendingPath}`);
    }
    pending = replaced;
  }
  withJsonlAppendLock(journal.sourcePath, () => {
    const source = existsSync(journal.sourcePath) ? readFileSync(journal.sourcePath) : null;
    const alreadyReplaced = source !== null && (
      pending.length > 0
        ? source.subarray(0, pending.length).equals(pending)
        : !source.subarray(0, archived.length).equals(archived)
    );
    const stillOriginal = source !== null && sha256(source) === journal.originalSha256;
    if (!alreadyReplaced) {
      if (source !== null && !stillOriginal) {
        throw new Error(
          `Compaction recovery refused to overwrite changed source: ${journal.sourcePath}`,
        );
      }
      writeFileAtomic(journal.sourcePath, pending);
    }
    transaction(db, () => {
      const current = currentGeneration(db, journal.sourcePath);
      if (current !== journal.generation && current !== journal.generation - 1) {
        throw new Error(
          `Compaction generation mismatch for ${journal.sourcePath}: current ${current}, journal ${journal.generation}`,
        );
      }
      if (current === journal.generation - 1) {
        db.prepare(`
          INSERT INTO source_generations(path, generation, updated_at)
          VALUES (@path, @generation, @updatedAt)
          ON CONFLICT(path) DO UPDATE SET
            generation = excluded.generation,
            updated_at = excluded.updated_at
        `).run({
          path: journal.sourcePath,
          generation: journal.generation,
          updatedAt: new Date().toISOString(),
        });
      }
    });
  });
  resetAndRebuildProjection(db, dir);
  unlinkFileDurable(journalPath);
  unlinkFileDurable(journal.pendingPath);
}

function compactedRowsForFile(
  path: string,
  kind: "rows" | "logs",
  workflow: string,
  trackerDate: string,
  deleted: Set<string>,
): string {
  const raw = readFileSync(path, "utf8");
  const lastNewline = raw.lastIndexOf("\n");
  const complete = lastNewline === -1 ? "" : raw.slice(0, lastNewline + 1);
  const kept: string[] = [];
  for (const [index, line] of complete.split("\n").entries()) {
    if (!line) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`Cannot compact malformed JSONL ${path}:${index + 1}`, { cause: error });
    }
    const itemId = kind === "rows" ? parsed.id : parsed.itemId;
    if (typeof itemId !== "string" || itemId.length === 0) {
      throw new Error(`Cannot compact invalid ${kind} row ${path}:${index + 1}`);
    }
    const runId = typeof parsed.runId === "string" ? parsed.runId : `${itemId}#1`;
    const key = `${workflow}\0${trackerDate}\0${itemId}\0${runId}`;
    if (!deleted.has(key)) kept.push(line);
  }
  return kept.length > 0 ? `${kept.join("\n")}\n` : "";
}

function currentGeneration(db: Database, path: string): number {
  const row = db.prepare("SELECT generation FROM source_generations WHERE path = ?").get(path) as {
    generation: number;
  } | undefined;
  return row?.generation ?? 1;
}

function compactFile(
  db: Database,
  dir: string,
  args: { path: string; kind: "rows" | "logs"; workflow: string; trackerDate: string },
  deleted: Set<string>,
): boolean {
  let changed = false;
  withJsonlAppendLock(args.path, () => {
    truncateToLastNewline(args.path);
    const original = readFileSync(args.path);
    const compacted = compactedRowsForFile(args.path, args.kind, args.workflow, args.trackerDate, deleted);
    if (Buffer.compare(original, Buffer.from(compacted)) === 0) return;
    const oldGeneration = currentGeneration(db, args.path);
    const generation = oldGeneration + 1;
    const archivePath = compactionArchiveFile(dir, oldGeneration, args.kind, basename(args.path));
    const pendingPath = compactionPendingFile(dir);
    const journalPath = compactionJournalFile(dir);
    mkdirSync(compactionRuntimeDir(dir), { recursive: true });
    mkdirSync(dirname(archivePath), { recursive: true });
    if (existsSync(archivePath)) {
      if (sha256(readFileSync(archivePath)) !== sha256(original)) {
        throw new Error(`Compaction archive hash mismatch: ${archivePath}`);
      }
    } else {
      writeFileAtomic(archivePath, original);
    }
    writeFileAtomic(pendingPath, compacted);
    const journal: CompactionJournal = {
      sourcePath: args.path,
      pendingPath,
      archivePath,
      originalSha256: sha256(original),
      compactedSha256: sha256(compacted),
      generation,
      phase: "prepared",
    };
    writeFileAtomic(journalPath, `${JSON.stringify(journal)}\n`);
    writeFileAtomic(args.path, compacted);
    writeFileAtomic(journalPath, `${JSON.stringify({ ...journal, phase: "replaced" })}\n`);
    changed = true;
  });
  if (changed) finishJournal(db, dir);
  return changed;
}

/** Resume any interrupted file replacement, then compact tombstoned row/log records. */
export function compactTracker(
  db: Database,
  dir: string,
  options: { lockTimeoutMs?: number } = {},
): { filesCompacted: number } {
  const trackerDir = resolve(dir);
  mkdirSync(compactionRuntimeDir(trackerDir), { recursive: true });
  return withExclusiveFileLock(
    compactionLockFile(trackerDir),
    () => {
      finishJournal(db, trackerDir);
      const deleted = readDeletedRunKeys(trackerDir);
      let filesCompacted = 0;
      for (const rootKind of ["rows", "logs"] as const) {
        const root = rootKind === "rows" ? rowsDir(trackerDir) : logsDir(trackerDir);
        if (!existsSync(root)) continue;
        for (const name of readdirSync(root).sort()) {
          const parsed = parseWorkflowDateFilename(name);
          if (!parsed) continue;
          const path = rootKind === "rows"
            ? rowFilePath(parsed.workflow, parsed.date, trackerDir)
            : logFilePath(parsed.workflow, parsed.date, trackerDir);
          if (compactFile(db, trackerDir, {
            path,
            kind: rootKind,
            workflow: parsed.workflow,
            trackerDate: parsed.date,
          }, deleted)) {
            filesCompacted += 1;
          }
        }
      }
      return { filesCompacted };
    },
    options.lockTimeoutMs,
    `tracker compaction lock: ${compactionLockFile(trackerDir)}`,
  );
}
