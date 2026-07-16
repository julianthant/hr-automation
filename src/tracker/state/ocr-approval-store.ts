import { createHash } from "node:crypto";

import type { Database } from "../../infra/sqlite/index.js";

const DEFAULT_LEASE_MS = 30_000;

export interface OcrApprovalStore {
  db: Database;
  transaction<T>(body: () => T): T;
}

export interface OcrApprovalManifestChild {
  workflow: string;
  itemId: string;
  runId: string;
  input: unknown;
  kind: "record" | "document";
}

/** Everything a restarted dispatcher needs to finish the approval exactly once. */
export interface OcrApprovalManifest {
  version: 1;
  id: string;
  sessionId: string;
  runId: string;
  formType: string;
  parentRunId: string;
  operationWorkflow?: string;
  records: unknown[];
  reviewData: Record<string, string>;
  children: OcrApprovalManifestChild[];
}

export type BeginOcrApprovalResult =
  | { kind: "claimed"; manifest: OcrApprovalManifest; generation: number }
  | { kind: "pending"; manifest: OcrApprovalManifest }
  | { kind: "approved"; manifest: OcrApprovalManifest }
  | { kind: "failed"; manifest: OcrApprovalManifest; error: string }
  | { kind: "conflict"; manifest: OcrApprovalManifest }
  | { kind: "stale"; manifest: OcrApprovalManifest };

export type ExistingOcrApproval =
  | { kind: "awaiting" }
  | { kind: "approving" | "approved"; requestHash: string; manifest: OcrApprovalManifest }
  | {
      kind: "failed";
      requestHash: string | null;
      manifest?: OcrApprovalManifest;
      error: string;
    };

interface ApprovalRow {
  state: "awaiting-approval" | "approving" | "approved" | "failed";
  request_hash: string | null;
  manifest_json: string | null;
  error: string | null;
  lease_expires_at_ms: number | null;
  claim_generation: number;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export function hashOcrApprovalRequest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function readManifest(row: ApprovalRow, sessionId: string, runId: string): OcrApprovalManifest {
  if (!row.manifest_json) throw new Error(`OCR approval ${sessionId}/${runId} has no persisted fan-out manifest`);
  try {
    const value = JSON.parse(row.manifest_json) as OcrApprovalManifest;
    validateManifest(value, sessionId, runId);
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OCR approval ${sessionId}/${runId} has a corrupt fan-out manifest: ${message}`, { cause: error });
  }
}

function validateManifest(value: OcrApprovalManifest, sessionId: string, runId: string): void {
  const children = Array.isArray(value?.children) ? value.children : [];
  const identityKeys = children.map((child) => `${child?.workflow}\0${child?.itemId}\0${child?.runId}`);
  const runIds = children.map((child) => child?.runId);
  if (
      value?.version !== 1 ||
      typeof value.id !== "string" ||
      value.sessionId !== sessionId ||
      value.runId !== runId ||
      typeof value.formType !== "string" ||
      typeof value.parentRunId !== "string" ||
      (value.operationWorkflow !== undefined && typeof value.operationWorkflow !== "string") ||
      !Array.isArray(value.records) ||
      !value.reviewData || typeof value.reviewData !== "object" || Array.isArray(value.reviewData) ||
      Object.values(value.reviewData).some((item) => typeof item !== "string") ||
      !Array.isArray(value.children) ||
      children.some((child) =>
        !child || typeof child !== "object" ||
        (child.kind !== "record" && child.kind !== "document") ||
        typeof child.workflow !== "string" || child.workflow.length === 0 ||
        typeof child.itemId !== "string" || child.itemId.length === 0 ||
        typeof child.runId !== "string" || child.runId.length === 0 ||
        !Object.prototype.hasOwnProperty.call(child, "input")
      ) ||
      new Set(identityKeys).size !== identityKeys.length ||
      new Set(runIds).size !== runIds.length
  ) {
    throw new Error("invalid or cross-run v1 manifest shape");
  }
}

/**
 * Read a durable approval outcome before consulting JSONL presentation data.
 * This keeps identical replays authoritative after tracker compaction/loss.
 */
export function readExistingOcrApproval(
  store: Pick<OcrApprovalStore, "db">,
  args: { sessionId: string; runId: string },
): ExistingOcrApproval | null {
  const row = store.db.prepare(`
    SELECT state, request_hash, manifest_json, error,
           lease_expires_at_ms, claim_generation
    FROM ocr_approvals
    WHERE session_id = @sessionId AND run_id = @runId
  `).get(args) as ApprovalRow | undefined;
  if (!row) return null;
  if (row.state === "awaiting-approval") return { kind: "awaiting" };
  if (row.state === "failed" && row.request_hash === null && row.manifest_json === null) {
    if (!row.error) throw new Error(`OCR approval ${args.sessionId}/${args.runId} is failed without a durable error`);
    return { kind: "failed", requestHash: null, error: row.error };
  }
  if (!row.request_hash) {
    throw new Error(`OCR approval ${args.sessionId}/${args.runId} has no persisted request hash`);
  }
  const manifest = readManifest(row, args.sessionId, args.runId);
  if (row.state === "failed") {
    if (!row.error) {
      throw new Error(`OCR approval ${args.sessionId}/${args.runId} is failed without a durable error`);
    }
    return {
      kind: "failed",
      requestHash: row.request_hash,
      manifest,
      error: row.error,
    };
  }
  return { kind: row.state, requestHash: row.request_hash, manifest };
}

export function markOcrAwaitingApproval(
  store: OcrApprovalStore,
  args: { sessionId: string; runId: string; now?: string },
): void {
  const now = args.now ?? new Date().toISOString();
  store.db.prepare(`
    INSERT INTO ocr_approvals (session_id, run_id, state, created_at, updated_at)
    VALUES (@sessionId, @runId, 'awaiting-approval', @now, @now)
    ON CONFLICT(session_id, run_id) DO NOTHING
  `).run({ ...args, now });
}

export function beginOcrApproval(
  store: OcrApprovalStore,
  args: {
    sessionId: string;
    runId: string;
    requestHash: string;
    manifest: OcrApprovalManifest;
    ownerToken: string;
    now?: string;
    nowMs?: number;
    leaseMs?: number;
    /** True only when the exact latest tracker row is running/awaiting-approval. */
    allowAwaitingClaim?: boolean;
  },
): BeginOcrApprovalResult {
  const now = args.now ?? new Date().toISOString();
  const nowMs = args.nowMs ?? Date.now();
  const leaseExpiresAtMs = nowMs + (args.leaseMs ?? DEFAULT_LEASE_MS);
  validateManifest(args.manifest, args.sessionId, args.runId);
  return store.transaction(() => {
    let row = store.db.prepare(`
      SELECT state, request_hash, manifest_json, error, lease_expires_at_ms, claim_generation
      FROM ocr_approvals WHERE session_id = @sessionId AND run_id = @runId
    `).get(args) as ApprovalRow | undefined;
    if (!row) {
      if (!args.allowAwaitingClaim) return { kind: "stale", manifest: args.manifest };
      const inserted = store.db.prepare(`
        INSERT INTO ocr_approvals (
          session_id, run_id, state, request_hash, manifest_json, manifest_id,
          owner_token, lease_expires_at_ms, claim_generation, created_at, updated_at
        ) VALUES (
          @sessionId, @runId, 'approving', @requestHash, @manifestJson, @manifestId,
          @ownerToken, @leaseExpiresAtMs, 1, @now, @now
        ) ON CONFLICT(session_id, run_id) DO NOTHING
      `).run({
        ...args,
        manifestJson: JSON.stringify(args.manifest),
        manifestId: args.manifest.id,
        leaseExpiresAtMs,
        now,
      });
      if (inserted.changes === 1) return { kind: "claimed", manifest: args.manifest, generation: 1 };
      row = store.db.prepare(`
        SELECT state, request_hash, manifest_json, error, lease_expires_at_ms, claim_generation
        FROM ocr_approvals WHERE session_id = @sessionId AND run_id = @runId
      `).get(args) as ApprovalRow | undefined;
      if (!row) throw new Error(`OCR approval ${args.sessionId}/${args.runId} disappeared during claim`);
    }

    if (row.state === "awaiting-approval" && row.request_hash === null) {
      if (!args.allowAwaitingClaim) return { kind: "stale", manifest: args.manifest };
      const update = store.db.prepare(`
        UPDATE ocr_approvals
        SET state = 'approving', request_hash = @requestHash, manifest_json = @manifestJson,
            manifest_id = @manifestId, owner_token = @ownerToken,
            lease_expires_at_ms = @leaseExpiresAtMs, claim_generation = claim_generation + 1,
            updated_at = @now
        WHERE session_id = @sessionId AND run_id = @runId
          AND state = 'awaiting-approval' AND request_hash IS NULL
      `).run({ ...args, manifestJson: JSON.stringify(args.manifest), manifestId: args.manifest.id, leaseExpiresAtMs, now });
      if (update.changes === 1) return { kind: "claimed", manifest: args.manifest, generation: row.claim_generation + 1 };
    }

    // Explicit discard can terminalize a parked approval before any request
    // hash/manifest exists. It must stay terminal and reject every later POST.
    if (row.state === "failed" && row.request_hash === null && row.manifest_json === null) {
      if (typeof row.error !== "string" || row.error.length === 0) {
        throw new Error(`OCR approval ${args.sessionId}/${args.runId} is failed without a durable error`);
      }
      return { kind: "failed", manifest: args.manifest, error: row.error };
    }

    if (row.request_hash !== args.requestHash) {
      return { kind: "conflict", manifest: readManifest(row, args.sessionId, args.runId) };
    }
    const persistedManifest = readManifest(row, args.sessionId, args.runId);
    if (row.state === "approved") return { kind: "approved", manifest: persistedManifest };
    if (row.state === "failed") return { kind: "failed", manifest: persistedManifest, error: row.error ?? "approval failed" };

    if ((row.lease_expires_at_ms ?? 0) <= nowMs) {
      const update = store.db.prepare(`
        UPDATE ocr_approvals
        SET owner_token = @ownerToken, lease_expires_at_ms = @leaseExpiresAtMs,
            claim_generation = claim_generation + 1, updated_at = @now
        WHERE session_id = @sessionId AND run_id = @runId
          AND state = 'approving' AND request_hash = @requestHash
          AND COALESCE(lease_expires_at_ms, 0) <= @nowMs
      `).run({ ...args, leaseExpiresAtMs, now, nowMs });
      if (update.changes === 1) {
        row = { ...row, claim_generation: row.claim_generation + 1 };
        return { kind: "claimed", manifest: persistedManifest, generation: row.claim_generation };
      }
    }
    return { kind: "pending", manifest: persistedManifest };
  });
}

export function completeOcrApproval(
  store: OcrApprovalStore,
  args: { sessionId: string; runId: string; requestHash: string; ownerToken: string; generation: number; now?: string },
): void {
  transitionApproval(store, { ...args, state: "approved" });
}

export function failOcrApproval(
  store: OcrApprovalStore,
  args: {
    sessionId: string;
    runId: string;
    requestHash: string;
    ownerToken: string;
    generation: number;
    error: string;
    now?: string;
  },
): void {
  transitionApproval(store, { ...args, state: "failed" });
}

/** Keep a live dispatcher from being reclaimed while it performs side effects. */
export function renewOcrApprovalLease(
  store: OcrApprovalStore,
  args: {
    sessionId: string;
    runId: string;
    requestHash: string;
    ownerToken: string;
    generation: number;
    now?: string;
    nowMs?: number;
    leaseMs?: number;
  },
): void {
  const now = args.now ?? new Date().toISOString();
  const leaseExpiresAtMs = (args.nowMs ?? Date.now()) + (args.leaseMs ?? DEFAULT_LEASE_MS);
  const result = store.db.prepare(`
    UPDATE ocr_approvals
    SET lease_expires_at_ms = @leaseExpiresAtMs, updated_at = @now
    WHERE session_id = @sessionId AND run_id = @runId
      AND state = 'approving' AND request_hash = @requestHash
      AND owner_token = @ownerToken AND claim_generation = @generation
  `).run({ ...args, leaseExpiresAtMs, now });
  if (result.changes !== 1) {
    throw new Error(`OCR approval ${args.sessionId}/${args.runId} lost its dispatch lease`);
  }
}

export function listRecoverableOcrApprovals(
  store: OcrApprovalStore,
  nowMs: number = Date.now(),
): OcrApprovalManifest[] {
  const rows = store.db.prepare(`
    SELECT session_id, run_id, state, request_hash, manifest_json, error,
           lease_expires_at_ms, claim_generation
    FROM ocr_approvals
    WHERE state = 'approving' AND COALESCE(lease_expires_at_ms, 0) <= @nowMs
    ORDER BY updated_at ASC
  `).all({ nowMs }) as Array<ApprovalRow & { session_id: string; run_id: string }>;
  return rows.map((row) => readManifest(row, row.session_id, row.run_id));
}

/** Approved, not-yet-projected manifests are the JSONL repair authority. */
export function listUnpresentedApprovedOcrApprovals(store: OcrApprovalStore): OcrApprovalManifest[] {
  const rows = store.db.prepare(`
    SELECT session_id, run_id, state, request_hash, manifest_json, error,
           lease_expires_at_ms, claim_generation
    FROM ocr_approvals
    WHERE state = 'approved' AND presented_at IS NULL
    ORDER BY updated_at ASC
  `).all() as Array<ApprovalRow & { session_id: string; run_id: string }>;
  return rows.map((row) => readManifest(row, row.session_id, row.run_id));
}

export function markOcrApprovalPresented(
  store: Pick<OcrApprovalStore, "db">,
  args: { sessionId: string; runId: string; now?: string },
): void {
  const now = args.now ?? new Date().toISOString();
  const result = store.db.prepare(`
    UPDATE ocr_approvals
    SET presented_at = @now, updated_at = @now
    WHERE session_id = @sessionId AND run_id = @runId
      AND state = 'approved' AND presented_at IS NULL
  `).run({ ...args, now });
  if (result.changes !== 1) {
    const row = store.db.prepare(`
      SELECT state, presented_at FROM ocr_approvals
      WHERE session_id = @sessionId AND run_id = @runId
    `).get(args) as { state: string; presented_at: string | null } | undefined;
    if (row?.state === "approved" && row.presented_at !== null) return;
    throw new Error(`OCR approval ${args.sessionId}/${args.runId} could not checkpoint its presentation`);
  }
}

export function isOcrApprovalPresentationPending(
  store: Pick<OcrApprovalStore, "db">,
  args: { sessionId: string; runId: string },
): boolean {
  const row = store.db.prepare(`
    SELECT 1 AS pending FROM ocr_approvals
    WHERE session_id = @sessionId AND run_id = @runId
      AND state = 'approved' AND presented_at IS NULL
  `).get(args) as { pending: 1 } | undefined;
  return row?.pending === 1;
}

/**
 * A dispatch-phase failure may follow one or more committed idempotent child
 * enqueues. Keep the approval recoverable instead of falsely terminalizing it.
 */
export function releaseOcrApprovalForRecovery(
  store: Pick<OcrApprovalStore, "db">,
  args: {
    sessionId: string;
    runId: string;
    requestHash: string;
    ownerToken: string;
    generation: number;
    error: string;
    now?: string;
  },
): void {
  const now = args.now ?? new Date().toISOString();
  const result = store.db.prepare(`
    UPDATE ocr_approvals
    SET owner_token = NULL, lease_expires_at_ms = 0, error = @error, updated_at = @now
    WHERE session_id = @sessionId AND run_id = @runId
      AND state = 'approving' AND request_hash = @requestHash
      AND owner_token = @ownerToken AND claim_generation = @generation
  `).run({ ...args, now });
  if (result.changes !== 1) {
    throw new Error(`OCR approval ${args.sessionId}/${args.runId} lost its dispatch lease before recovery release`);
  }
}

/** Terminalize a parked/in-flight approval after an explicit operator discard. */
export type DiscardOcrApprovalResult =
  | "discarded"
  | "already-approved"
  | "already-failed"
  | "not-found";

export function discardOcrApproval(
  store: Pick<OcrApprovalStore, "db" | "transaction">,
  args: { sessionId: string; runId: string; error: string; now?: string },
): DiscardOcrApprovalResult {
  const now = args.now ?? new Date().toISOString();
  return store.transaction(() => {
    const updated = store.db.prepare(`
      UPDATE ocr_approvals
      SET state = 'failed', error = @error, completed_at = @now, updated_at = @now,
          owner_token = NULL, lease_expires_at_ms = NULL
      WHERE session_id = @sessionId AND run_id = @runId
        AND state IN ('awaiting-approval', 'approving')
    `).run({ ...args, now });
    if (updated.changes === 1) return "discarded";
    const inserted = store.db.prepare(`
      INSERT INTO ocr_approvals (
        session_id, run_id, state, created_at, updated_at, completed_at, error
      ) VALUES (
        @sessionId, @runId, 'failed', @now, @now, @now, @error
      ) ON CONFLICT(session_id, run_id) DO NOTHING
    `).run({ ...args, now });
    if (inserted.changes === 1) return "discarded";
    const row = store.db.prepare(`
      SELECT state FROM ocr_approvals
      WHERE session_id = @sessionId AND run_id = @runId
    `).get(args) as { state: ApprovalRow["state"] } | undefined;
    if (!row) return "not-found";
    return row.state === "approved" ? "already-approved" : "already-failed";
  });
}

function transitionApproval(
  store: OcrApprovalStore,
  args: {
    sessionId: string;
    runId: string;
    requestHash: string;
    ownerToken: string;
    generation: number;
    state: "approved" | "failed";
    error?: string;
    now?: string;
  },
): void {
  const now = args.now ?? new Date().toISOString();
  const result = store.db.prepare(`
    UPDATE ocr_approvals
    SET state = @state, error = @error, updated_at = @now, completed_at = @now,
        owner_token = NULL, lease_expires_at_ms = NULL
    WHERE session_id = @sessionId AND run_id = @runId
      AND state = 'approving' AND request_hash = @requestHash
      AND owner_token = @ownerToken AND claim_generation = @generation
  `).run({ ...args, error: args.error ?? null, now });
  if (result.changes !== 1) {
    throw new Error(
      `OCR approval ${args.sessionId}/${args.runId} lost its dispatch lease before ${args.state}`,
    );
  }
}
