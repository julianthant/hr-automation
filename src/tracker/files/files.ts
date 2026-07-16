import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { type Database } from "../../infra/sqlite/index.js";
import { isFileAttachmentId } from "./file-id.js";
import { blobFilePath } from "../paths.js";
import { writeFileAtomic } from "../fs-atomic.js";

export interface RegisterLocalFileInput {
  trackerDir: string;
  kind: "pdf" | "screenshot" | "page-image" | "image" | "other";
  mimeType: string;
  path: string;
  originalName: string;
  source: string;
  workflow?: string;
  itemId?: string;
  runId?: string;
  parentRunId?: string;
  trackerDate?: string;
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
  trackerDate?: string;
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
  db: Database,
  input: RegisterLocalFileInput,
): RegisteredFile {
  if (!existsSync(input.path)) throw new Error(`file does not exist: ${input.path}`);
  const stat = statSync(input.path);
  if (!stat.isFile()) throw new Error(`not a file: ${input.path}`);
  const sourceBytes = readFileSync(input.path);
  const sha256 = createHash("sha256").update(sourceBytes).digest("hex");
  const bytes = sourceBytes.byteLength;
  const now = new Date().toISOString();
  const immutablePath = blobFilePath(input.trackerDir, sha256);
  mkdirSync(dirname(immutablePath), { recursive: true });
  if (!existsSync(immutablePath)) {
    writeFileAtomic(immutablePath, sourceBytes);
  }
  const immutable = hashFile(immutablePath);
  if (immutable.sha256 !== sha256 || immutable.bytes !== bytes) {
    throw new Error(`content-addressed blob integrity mismatch for ${sha256}`);
  }
  const existingBlob = db.prepare(
    "SELECT bytes, storage_path AS storagePath FROM file_blobs WHERE sha256 = ?",
  ).get(sha256) as { bytes: number; storagePath: string | null } | undefined;
  if (existingBlob && existingBlob.bytes !== bytes) {
    throw new Error(`file blob size conflict for ${sha256}`);
  }
  const attachmentKey = createHash("sha256")
    .update(JSON.stringify({
      sha256,
      kind: input.kind,
      path: input.path,
      source: input.source,
      workflow: input.workflow ?? null,
      itemId: input.itemId ?? null,
      runId: input.runId ?? null,
      parentRunId: input.parentRunId ?? null,
      trackerDate: input.trackerDate ?? null,
    }))
    .digest("hex");
  const proposedFileId = randomUUID();
  db.prepare(`
    INSERT INTO file_blobs (blob_id, sha256, bytes, storage_path, created_at)
    VALUES (@blobId, @sha256, @bytes, @storagePath, @createdAt)
    ON CONFLICT(sha256) DO UPDATE SET
      storage_path = CASE
        WHEN file_blobs.storage_path IS NULL THEN excluded.storage_path
        ELSE file_blobs.storage_path
      END
  `).run({ blobId: sha256, sha256, bytes, storagePath: immutablePath, createdAt: now });
  db.prepare(`
    INSERT INTO files (
      file_id, kind, mime_type, original_name, storage_path, sha256, bytes,
      workflow, item_id, run_id, parent_run_id, source, metadata_json, created_at,
      blob_id, attachment_key, tracker_date
    ) VALUES (
      @fileId, @kind, @mimeType, @originalName, @storagePath, @sha256, @bytes,
      @workflow, @itemId, @runId, @parentRunId, @source, @metadataJson, @createdAt,
      @blobId, @attachmentKey, @trackerDate
    )
    ON CONFLICT(attachment_key) DO UPDATE SET
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
      metadata_json = excluded.metadata_json,
      blob_id = excluded.blob_id,
      tracker_date = COALESCE(excluded.tracker_date, files.tracker_date)
  `).run({
    fileId: proposedFileId,
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
    blobId: sha256,
    attachmentKey,
    trackerDate: input.trackerDate ?? null,
  });
  const attachment = db.prepare(
    "SELECT file_id AS fileId FROM files WHERE attachment_key = ?",
  ).get(attachmentKey) as { fileId: string } | undefined;
  if (!attachment) throw new Error("file attachment registration did not persist");
  const fileId = attachment.fileId;
  return {
    fileId,
    kind: input.kind,
    mimeType: input.mimeType,
    originalName: input.originalName,
    storagePath: immutablePath,
    sha256,
    bytes,
    workflow: input.workflow,
    itemId: input.itemId,
    runId: input.runId,
    parentRunId: input.parentRunId,
    trackerDate: input.trackerDate,
    source: input.source,
    metadata: input.metadata,
  };
}

export function getRegisteredFile(
  db: Database,
  fileId: string,
): RegisteredFile | null {
  if (!isFileAttachmentId(fileId)) return null;
  const row = db.prepare(`
    SELECT files.*,
           COALESCE(file_blobs.storage_path, files.storage_path) AS resolved_storage_path,
           file_blobs.sha256 AS blob_sha256,
           file_blobs.bytes AS blob_bytes
    FROM files
    LEFT JOIN file_blobs ON file_blobs.blob_id = files.blob_id
    WHERE files.file_id = ?
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
    tracker_date: string | null;
    source: string;
    metadata_json: string | null;
    resolved_storage_path: string;
    blob_sha256: string | null;
    blob_bytes: number | null;
  } | undefined;
  if (!row) return null;
  if (row.blob_sha256 && (row.blob_sha256 !== row.sha256 || row.blob_bytes !== row.bytes)) {
    throw new Error(`file attachment/blob metadata mismatch for ${fileId}`);
  }
  if (row.blob_sha256) {
    if (!existsSync(row.resolved_storage_path)) {
      throw new Error(`content-addressed blob is missing for ${fileId}`);
    }
    const actual = hashFile(row.resolved_storage_path);
    if (actual.sha256 !== row.sha256 || actual.bytes !== row.bytes) {
      throw new Error(`content-addressed blob integrity mismatch for ${fileId}`);
    }
  }
  db.prepare("UPDATE files SET last_accessed_at = ? WHERE file_id = ?")
    .run(new Date().toISOString(), fileId);
  return {
    fileId: row.file_id,
    kind: row.kind,
    mimeType: row.mime_type,
    originalName: row.original_name,
    storagePath: row.resolved_storage_path,
    sha256: row.sha256,
    bytes: row.bytes,
    workflow: row.workflow ?? undefined,
    itemId: row.item_id ?? undefined,
    runId: row.run_id ?? undefined,
    parentRunId: row.parent_run_id ?? undefined,
    trackerDate: row.tracker_date ?? undefined,
    source: row.source,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) as Record<string, unknown> : undefined,
  };
}
