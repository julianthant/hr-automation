/**
 * Upload-run registry — declares per-workflow behavior for the file-upload
 * `RunModal` (PDF picker + roster/form-type/duplicate-check sections +
 * submit dispatch). Mirrors the shape of `input-run-registry.ts`.
 *
 * Adding an upload-run workflow:
 *   1. Add an entry here with a title / submitUrl /
 *      sections / buildSuccessToast.
 *   2. Add the workflow name to `DASHBOARD_UPLOAD_RUN_WORKFLOWS`.
 *      That's it — `RunModal` and `TopBarRunButton` (queue toolbar) derive their behavior
 *      and visibility from this map automatically. No edits to either
 *      component file are needed.
 *
 * The default `workflow="emergency-contact"` fallback that used to live
 * on the RunModal prop is gone — callers must pass a registered workflow
 * name. Unregistered workflows render nothing (and log to console) so a
 * misconfigured caller fails loud instead of silently posting to the
 * wrong endpoint.
 */

import { DASHBOARD_UPLOAD_RUN_WORKFLOWS } from "../../domain/dashboard-run-surfaces.js";

type DashboardUploadRunWorkflow = (typeof DASHBOARD_UPLOAD_RUN_WORKFLOWS)[number];

/**
 * Shared OCR-prep endpoint. The `targetWorkflow` operation intent only rides
 * this submit path — `resolveTargetWorkflow` checks the resolved `submitUrl`
 * against this constant so the endpoint-string knowledge stays in the registry
 * (its owner) and never leaks into the `RunModal` component.
 */
export const OCR_PREPARE_SUBMIT_URL = "/api/ocr/prepare";

export interface RunModalContext {
  reuploadFor?: { sessionId: string; previousRunId: string };
  lockedFormType?: string;
  oathUploadMode?: "full" | "upload-only";
}

export interface RunModalSubmitResponse {
  ok: boolean;
  parentRunId?: string;
  sessionId?: string;
  runId?: string;
  error?: string;
}

export interface RunModalToast {
  title: string;
  description?: string;
}

/**
 * Which optional sections this workflow's modal renders. Each is
 * independent — set the ones you need, omit the rest.
 *
 * - `formType`: OCR-style radio picker for which form template to parse.
 * - `roster`: roster-mode picker (use latest local | download fresh).
 * - `duplicateCheck`: hash the PDF on pick and surface prior runs.
 * - `oathUploadMode`: full delegated flow vs ServiceNow upload-only.
 * - `workers`: Automation-workers picker — how many browser workers to target
 *   for the OCR-backed run's downstream fan-out. Only meaningful for the
 *   `/api/ocr/prepare` path (hidden in oath-upload's upload-only mode).
 */
export interface RunModalSections {
  formType?: boolean;
  roster?: boolean;
  duplicateCheck?: boolean;
  dryRun?: boolean;
  oathUploadMode?: boolean;
  workers?: boolean;
}

export interface RunModalConfig {
  /** Modal title (top of header). */
  title: (ctx: RunModalContext) => string;
  /** Screen reader description — rendered as Radix DialogDescription (typically sr-only). */
  srDescription: (ctx: RunModalContext) => string;
  /** POST endpoint for the upload. Receives the same ctx so reupload routing is per-workflow. */
  submitUrl: (ctx: RunModalContext) => string;
  /**
   * The target workflow whose operation / single coordinator row owns this OCR
   * run, sent to `/api/ocr/prepare` as `targetWorkflow`. This is what lets the
   * backend tell an oath-signature PDF run (`"oath-signature"`) from an
   * oath-upload full run (`"oath-upload"`) — both submit `formType=oath`. Return
   * `undefined` for a standalone OCR prep (no coordinator row). Only sent when
   * the submit goes to `/api/ocr/prepare`.
   */
  targetWorkflow?: (ctx: RunModalContext) => string | undefined;
  sections: RunModalSections;
  /** Sonner toast emitted on a successful submit. */
  buildSuccessToast: (resp: RunModalSubmitResponse, file: File) => RunModalToast;
  /** Allow selecting and submitting multiple PDFs as grouped single-file runs. */
  allowMultipleFiles?: boolean;
  /**
   * Opt this workflow into the in-modal "Capture photos" upload method — a
   * mobile-photo → PDF → OCR-prepare flow that produces the same OCR prep row
   * as a file upload. When `true`, the RunModal shows an "Upload file | Capture
   * photos" mode switch (gated additionally on a live capture registration from
   * `GET /api/capture/registry`, so the option only appears when the backend
   * actually registered a capture handler for the workflow). Declarative
   * counterpart to the server-side `captureRegistrations` entry (Commit 4).
   */
  capture?: boolean;
  /**
   * If set, the workflow's run modal locks the OCR `formType` to this value
   * — picker is hidden, the field is force-injected on submit. Used so
   * `emergency-contact`, `oath-signature`, and `oath-upload` can each
   * surface a dedicated Run button that delegates to the shared
   * `/api/ocr/prepare` endpoint without making the operator pick the form
   * type a second time.
   */
  lockedFormType?: string;
}

export const RUN_MODAL_REGISTRY: Record<DashboardUploadRunWorkflow, RunModalConfig> = {
  "emergency-contact": {
    title: () => "Run Emergency Contact",
    srDescription: () =>
      "Upload a PDF of the emergency contact form, choose roster source, optionally enable dry run, then submit to start OCR preparation.",
    submitUrl: ({ reuploadFor }) =>
      reuploadFor ? "/api/ocr/reupload" : "/api/ocr/prepare",
    targetWorkflow: () => "emergency-contact",
    sections: { roster: true, dryRun: true, workers: true },
    lockedFormType: "emergency-contact",
    allowMultipleFiles: true,
    capture: true,
    buildSuccessToast: (_resp, file) => ({
      title: "Preparation started",
      description: file.name,
    }),
  },
  "oath-signature": {
    title: () => "Run Oath Signature",
    srDescription: () =>
      "Upload a PDF of the paper oath roster, choose roster source, optionally enable dry run, then submit to start OCR preparation. On approve, OCR fans out one signer per approved record into the Oath Signature queue.",
    submitUrl: ({ reuploadFor }) =>
      reuploadFor ? "/api/ocr/reupload" : "/api/ocr/prepare",
    targetWorkflow: () => "oath-signature",
    sections: { roster: true, dryRun: true, workers: true },
    lockedFormType: "oath",
    allowMultipleFiles: true,
    capture: true,
    buildSuccessToast: (_resp, file) => ({
      title: "Preparation started",
      description: file.name,
    }),
  },
  ocr: {
    title: () => "OCR — Prepare",
    srDescription: () =>
      "Upload a PDF to run OCR preparation; choose roster source and form type, then submit.",
    submitUrl: ({ reuploadFor }) =>
      reuploadFor ? "/api/ocr/reupload" : "/api/ocr/prepare",
    // Dedicated OCR runs have no Approve flow (just inspecting OCR output),
    // so dry-run is meaningless here. Delegations from emergency-contact /
    // oath keep their own dry-run toggles.
    sections: { roster: true, formType: true, workers: true },
    allowMultipleFiles: true,
    buildSuccessToast: (_resp, file) => ({
      title: "Preparation started",
      description: file.name,
    }),
  },
  "oath-upload": {
    title: () => "Upload Oath PDF",
    srDescription: ({ oathUploadMode }) =>
      oathUploadMode === "upload-only"
        ? "Upload a paper oath PDF for ServiceNow filing only — OCR and signatures are skipped. The workflow files an HR ticket with the PDF attached and nothing else."
        : "Upload a paper oath PDF. Full process starts OCR prep (approve the extracted rows in the OCR queue); on approve, OCR fans out one signer per approved record into the Oath Signature tab AND one ServiceNow ticket row that waits for every signer to finish before filing. Pick roster source, duplicate check, and dry run.",
    // Full process is the OCR-hub entry: it starts an OCR prep locked to the
    // oath form. OCR owns approval and the dual fan-out (oath-signature signers
    // + oath-upload ticket). upload-only stays a direct oath-upload run that
    // files the ticket without OCR/signers.
    submitUrl: ({ reuploadFor, oathUploadMode }) =>
      reuploadFor
        ? "/api/ocr/reupload"
        : oathUploadMode === "upload-only"
          ? "/api/oath-upload/start"
          : "/api/ocr/prepare",
    // Full mode (the OCR-hub entry) is born as the oath-upload single row;
    // upload-only posts straight to /api/oath-upload/start (no OCR prep).
    targetWorkflow: ({ oathUploadMode }) =>
      oathUploadMode === "upload-only" ? undefined : "oath-upload",
    lockedFormType: "oath",
    // Roster picker is required for Full process because the OCR prep needs a
    // roster to match the OCR'd names → EIDs before fanning out. Workers only
    // apply to Full process (the OCR-hub fan-out); the section self-hides in
    // upload-only mode.
    sections: { roster: true, duplicateCheck: true, dryRun: true, oathUploadMode: true, workers: true },
    allowMultipleFiles: true,
    buildSuccessToast: (resp, file) => ({
      title: resp.sessionId
        ? `Oath upload queued — session ${resp.sessionId.slice(0, 8)}`
        : "Oath upload queued",
      description: file.name,
    }),
  },
};

export function getRunModalConfig(workflow: string): RunModalConfig | undefined {
  return RUN_MODAL_REGISTRY[workflow as DashboardUploadRunWorkflow];
}

/**
 * The `targetWorkflow` operation intent to append to the upload `FormData`, or
 * `undefined` when none should be sent. Declarative replacement for the old
 * `submitUrl.endsWith("/api/ocr/prepare")` string-sniff that lived inside the
 * `RunModal` component: a target is sent only when the entry declares one for
 * this ctx AND the resolved submit goes to the shared OCR-prep endpoint
 * ({@link OCR_PREPARE_SUBMIT_URL}). Keeps endpoint-string branching in the
 * registry (the owner of `submitUrl`).
 */
export function resolveTargetWorkflow(
  config: RunModalConfig,
  ctx: RunModalContext,
): string | undefined {
  if (config.submitUrl(ctx) !== OCR_PREPARE_SUBMIT_URL) return undefined;
  return config.targetWorkflow?.(ctx);
}

export function isRunModalEnabled(workflow: string): boolean {
  return workflow in RUN_MODAL_REGISTRY;
}

/**
 * Whether this workflow's run modal declares the in-modal "Capture photos"
 * upload method. The actual mode switch is shown only when this is true AND a
 * live capture registration exists server-side (`GET /api/capture/registry`).
 */
export function isRunModalCaptureCapable(workflow: string): boolean {
  return getRunModalConfig(workflow)?.capture === true;
}
