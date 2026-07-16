import { createHash } from "node:crypto";

import type { Database } from "../../infra/sqlite/index.js";

export interface OcrPrepareInputStore {
  db: Database;
}

interface OcrPrepareInputRow {
  schema_version: number;
  input_hash: string;
  input_json: string;
}

function hashJson(json: string): string {
  return createHash("sha256").update(json).digest("hex");
}

/**
 * Persist the immutable launch contract for an in-process OCR prepare run.
 * Repeating the exact write is idempotent; any disagreement is corruption or
 * identity reuse and fails loudly.
 */
export function persistOcrPrepareInput(
  store: OcrPrepareInputStore,
  args: { sessionId: string; runId: string; input: unknown; now?: string },
): void {
  const inputJson = JSON.stringify(args.input);
  if (inputJson === undefined) {
    throw new Error(`OCR prepare ${args.sessionId}/${args.runId} input is not JSON-serializable`);
  }
  const inputHash = hashJson(inputJson);
  const now = args.now ?? new Date().toISOString();
  const result = store.db.prepare(`
    INSERT INTO ocr_prepare_inputs (
      session_id, run_id, schema_version, input_hash, input_json, created_at
    ) VALUES (@sessionId, @runId, 1, @inputHash, @inputJson, @now)
    ON CONFLICT(session_id, run_id) DO NOTHING
  `).run({ ...args, inputHash, inputJson, now });
  if (result.changes === 1) return;

  const existing = store.db.prepare(`
    SELECT schema_version, input_hash, input_json
    FROM ocr_prepare_inputs
    WHERE session_id = @sessionId AND run_id = @runId
  `).get(args) as OcrPrepareInputRow | undefined;
  if (
    !existing ||
    existing.schema_version !== 1 ||
    existing.input_hash !== inputHash ||
    existing.input_json !== inputJson
  ) {
    throw new Error(
      `OCR prepare ${args.sessionId}/${args.runId} already has a different persisted launch input`,
    );
  }
}

/** Read and integrity-check the exact persisted OCR prepare launch input. */
export function readOcrPrepareInput(
  store: OcrPrepareInputStore,
  args: { sessionId: string; runId: string },
): unknown | undefined {
  const row = store.db.prepare(`
    SELECT schema_version, input_hash, input_json
    FROM ocr_prepare_inputs
    WHERE session_id = @sessionId AND run_id = @runId
  `).get(args) as OcrPrepareInputRow | undefined;
  if (!row) return undefined;
  if (row.schema_version !== 1 || hashJson(row.input_json) !== row.input_hash) {
    throw new Error(`OCR prepare ${args.sessionId}/${args.runId} has a corrupt persisted launch input`);
  }
  try {
    return JSON.parse(row.input_json) as unknown;
  } catch (error) {
    throw new Error(
      `OCR prepare ${args.sessionId}/${args.runId} has invalid persisted launch JSON`,
      { cause: error },
    );
  }
}
