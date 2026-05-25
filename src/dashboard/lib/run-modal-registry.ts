/**
 * Run-modal registry — declares per-workflow behavior for the file-upload
 * `RunModal` (PDF picker + roster/form-type/duplicate-check sections +
 * submit dispatch). Mirrors the shape of `quick-run-registry.ts`.
 *
 * Adding a file-upload workflow:
 *   1. Add an entry here with a title / submitUrl /
 *      sections / buildSuccessToast.
 *   2. That's it — `RunModal` and `TopBarRunButton` (queue toolbar) derive their behavior
 *      and visibility from this map automatically. No edits to either
 *      component file are needed.
 *
 * The default `workflow="emergency-contact"` fallback that used to live
 * on the RunModal prop is gone — callers must pass a registered workflow
 * name. Unregistered workflows render nothing (and log to console) so a
 * misconfigured caller fails loud instead of silently posting to the
 * wrong endpoint.
 */

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
 */
export interface RunModalSections {
  formType?: boolean;
  roster?: boolean;
  duplicateCheck?: boolean;
  dryRun?: boolean;
  oathUploadMode?: boolean;
}

export interface RunModalConfig {
  /** Modal title (top of header). */
  title: (ctx: RunModalContext) => string;
  /** Screen reader description — rendered as Radix DialogDescription (typically sr-only). */
  srDescription: (ctx: RunModalContext) => string;
  /** POST endpoint for the upload. Receives the same ctx so reupload routing is per-workflow. */
  submitUrl: (ctx: RunModalContext) => string;
  sections: RunModalSections;
  /** Sonner toast emitted on a successful submit. */
  buildSuccessToast: (resp: RunModalSubmitResponse, file: File) => RunModalToast;
  /** Allow selecting and submitting multiple PDFs as grouped single-file runs. */
  allowMultipleFiles?: boolean;
  /**
   * If set, the workflow's run modal locks the OCR `formType` to this value
   * — picker is hidden, the field is force-injected on submit. Used so
   * `emergency-contact` and `oath-signature` can each surface a dedicated
   * Run button that delegates to the shared `/api/ocr/prepare` endpoint
   * without making the operator pick the form type a second time.
   */
  lockedFormType?: string;
}

export const RUN_MODAL_REGISTRY: Record<string, RunModalConfig> = {
  "emergency-contact": {
    title: () => "Run Emergency Contact",
    srDescription: () =>
      "Upload a PDF of the emergency contact form, choose roster source, optionally enable dry run, then submit to start OCR preparation.",
    submitUrl: ({ reuploadFor }) =>
      reuploadFor ? "/api/ocr/reupload" : "/api/ocr/prepare",
    sections: { roster: true, dryRun: true },
    lockedFormType: "emergency-contact",
    allowMultipleFiles: true,
    buildSuccessToast: (_resp, file) => ({
      title: "Preparation started",
      description: file.name,
    }),
  },
  "oath-signature": {
    title: () => "Run Oath Signature",
    srDescription: () =>
      "Upload a PDF for oath preparation, choose roster source, optionally enable dry run, then submit to run OCR.",
    submitUrl: ({ reuploadFor }) =>
      reuploadFor ? "/api/ocr/reupload" : "/api/ocr/prepare",
    sections: { roster: true, dryRun: true },
    lockedFormType: "oath",
    allowMultipleFiles: true,
    buildSuccessToast: (_resp, file) => ({
      title: "Preparation started",
      description: file.name,
    }),
  },
  ocr: {
    title: ({ lockedFormType }) =>
      lockedFormType === "oath" ? "Run Oath Signature" : "OCR — Prepare",
    srDescription: ({ lockedFormType }) =>
      lockedFormType === "oath"
        ? "Upload a PDF for oath preparation, choose roster source and form handling options, then submit."
        : "Upload a PDF to run OCR preparation; choose roster source and form type, then submit.",
    submitUrl: ({ reuploadFor }) =>
      reuploadFor ? "/api/ocr/reupload" : "/api/ocr/prepare",
    // Dedicated OCR runs have no Approve flow (just inspecting OCR output),
    // so dry-run is meaningless here. Delegations from oath-signature /
    // emergency-contact / oath-upload keep their own dry-run toggles.
    sections: { roster: true, formType: true },
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
        ? "Upload a paper oath PDF for ServiceNow filing only — OCR and signature delegation are skipped. The workflow files an HR ticket with the PDF attached and nothing else."
        : "Upload a paper oath PDF. Full process dispatches OCR + per-signer signatures into the Oath Signature tab (where the operator approves OCR and the per-signer batch runs); after every signer completes, oath-upload files the HR ticket. Pick roster source, duplicate check, and dry run.",
    submitUrl: () => "/api/oath-upload/start",
    // Roster picker is required for Full process because oath-upload's dispatch
    // step starts an OCR + signature batch in the oath-signature tab, which
    // needs a roster to match the OCR'd names → EIDs before fanning out.
    sections: { roster: true, duplicateCheck: true, dryRun: true, oathUploadMode: true },
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
  return RUN_MODAL_REGISTRY[workflow];
}

export function isRunModalEnabled(workflow: string): boolean {
  return workflow in RUN_MODAL_REGISTRY;
}
