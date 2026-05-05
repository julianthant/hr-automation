import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import type Database from "better-sqlite3";

export interface RegisterLocalFileInput {
  kind: "pdf" | "screenshot" | "page-image" | "image" | "other";
  mimeType: string;
  path: string;
  originalName: string;
  source: string;
  workflow?: string;
  itemId?: string;
  runId?: string;
  parentRunId?: string;
  metadata?: Record<string, unknown>;
}

export interface RegisteredFile {
  fileId: string;
  kind: string;
  mimeType: string;
  originalName: string;
  storagePath: string;
  sha256: string;
  bytes: number;
  workflow?: string;
  itemId?: string;
  runId?: string;
  parentRunId?: string;
  source: string;
  metadata?: Record<string, unknown>;
}

export function hashFile(path: string): { sha256: string; bytes: number } {
  const bytes = readFileSync(path);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
  };
}

export function registerLocalFile(
  db: Database.Database,
  input: RegisterLocalFileInput,
): RegisteredFile {
  if (!existsSync(input.path)) throw new Error(`file does not exist: ${input.path}`);
  const stat = statSync(input.path);
  if (!stat.isFile()) throw new Error(`not a file: ${input.path}`);
  const { sha256, bytes } = hashFile(input.path);
  const fileId = sha256.slice(0, 32);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO files (
      file_id, kind, mime_type, original_name, storage_path, sha256, bytes,
      workflow, item_id, run_id, parent_run_id, source, metadata_json, created_at
    ) VALUES (
      @fileId, @kind, @mimeType, @originalName, @storagePath, @sha256, @bytes,
      @workflow, @itemId, @runId, @parentRunId, @source, @metadataJson, @createdAt
    )
    ON CONFLICT(file_id) DO UPDATE SET
      kind = excluded.kind,
      mime_type = excluded.mime_type,
      original_name = excluded.original_name,
      storage_path = excluded.storage_path,
      bytes = excluded.bytes,
      workflow = COALESCE(excluded.workflow, files.workflow),
      item_id = COALESCE(excluded.item_id, files.item_id),
      run_id = COALESCE(excluded.run_id, files.run_id),
      parent_run_id = COALESCE(excluded.parent_run_id, files.parent_run_id),
      source = excluded.source,
      metadata_json = excluded.metadata_json
  `).run({
    fileId,
    kind: input.kind,
    mimeType: input.mimeType,
    originalName: input.originalName,
    storagePath: input.path,
    sha256,
    bytes,
    workflow: input.workflow ?? null,
    itemId: input.itemId ?? null,
    runId: input.runId ?? null,
    parentRunId: input.parentRunId ?? null,
    source: input.source,
    metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
    createdAt: now,
  });
  return {
    fileId,
    kind: input.kind,
    mimeType: input.mimeType,
    originalName: input.originalName,
    storagePath: input.path,
    sha256,
    bytes,
    workflow: input.workflow,
    itemId: input.itemId,
    runId: input.runId,
    parentRunId: input.parentRunId,
    source: input.source,
    metadata: input.metadata,
  };
}

export function getRegisteredFile(
  db: Database.Database,
  fileId: string,
): RegisteredFile | null {
  if (!/^[a-f0-9]{32,64}$/.test(fileId)) return null;
  const row = db.prepare(`
    SELECT * FROM files WHERE file_id = ?
  `).get(fileId) as {
    file_id: string;
    kind: string;
    mime_type: string;
    original_name: string;
    storage_path: string;
    sha256: string;
    bytes: number;
    workflow: string | null;
    item_id: string | null;
    run_id: string | null;
    parent_run_id: string | null;
    source: string;
    metadata_json: string | null;
  } | undefined;
  if (!row) return null;
  db.prepare("UPDATE files SET last_accessed_at = ? WHERE file_id = ?")
    .run(new Date().toISOString(), fileId);
  return {
    fileId: row.file_id,
    kind: row.kind,
    mimeType: row.mime_type,
    originalName: row.original_name,
    storagePath: row.storage_path,
    sha256: row.sha256,
    bytes: row.bytes,
    workflow: row.workflow ?? undefined,
    itemId: row.item_id ?? undefined,
    runId: row.run_id ?? undefined,
    parentRunId: row.parent_run_id ?? undefined,
    source: row.source,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) as Record<string, unknown> : undefined,
  };
}
