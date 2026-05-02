/**
 * Run-modal registry — declares per-workflow behavior for the file-upload
 * `RunModal` (PDF picker + roster/form-type/duplicate-check sections +
 * submit dispatch). Mirrors the shape of `quick-run-registry.ts`.
 *
 * Adding a file-upload workflow:
 *   1. Add an entry here with a title / description / submitUrl /
 *      sections / buildSuccessToast.
 *   2. That's it — `RunModal` and `TopBarRunButton` derive their behavior
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
 */
export interface RunModalSections {
  formType?: boolean;
  roster?: boolean;
  duplicateCheck?: boolean;
}

export interface RunModalConfig {
  /** Modal title (top of header). */
  title: (ctx: RunModalContext) => string;
  /** Sub-title under the modal title. */
  description: (ctx: RunModalContext) => string;
  /** POST endpoint for the upload. Receives the same ctx so reupload routing is per-workflow. */
  submitUrl: (ctx: RunModalContext) => string;
  sections: RunModalSections;
  /** Sonner toast emitted on a successful submit. */
  buildSuccessToast: (resp: RunModalSubmitResponse, file: File) => RunModalToast;
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
    description: ({ reuploadFor }) =>
      reuploadFor
        ? "Upload a corrected PDF — resolved EIDs from the previous run carry forward."
        : "Upload a scanned PDF. We’ll OCR it, match against the roster, then approve before queuing.",
    submitUrl: ({ reuploadFor }) =>
      reuploadFor ? "/api/ocr/reupload" : "/api/ocr/prepare",
    sections: { roster: true },
    lockedFormType: "emergency-contact",
    buildSuccessToast: (_resp, file) => ({
      title: "Preparation started",
      description: file.name,
    }),
  },
  "oath-signature": {
    title: () => "Run Oath Signature",
    description: ({ reuploadFor }) =>
      reuploadFor
        ? "Upload a corrected oath PDF — resolved EIDs from the previous run carry forward."
        : "Upload a scanned oath PDF. We’ll OCR it, match against the roster, then approve before queuing oath-signature for each match.",
    submitUrl: ({ reuploadFor }) =>
      reuploadFor ? "/api/ocr/reupload" : "/api/ocr/prepare",
    sections: { roster: true },
    lockedFormType: "oath",
    buildSuccessToast: (_resp, file) => ({
      title: "Preparation started",
      description: file.name,
    }),
  },
  ocr: {
    title: ({ lockedFormType }) =>
      lockedFormType === "oath" ? "Run Oath Signature" : "OCR — Prepare",
    description: ({ reuploadFor, lockedFormType }) => {
      if (reuploadFor) {
        return "Upload a corrected PDF — resolved EIDs from the previous run carry forward.";
      }
      if (lockedFormType === "oath") {
        return "Upload a scanned oath PDF. We’ll OCR it, match against the roster, then approve before queuing oath-signature for each match.";
      }
      return "Upload a scanned PDF. We’ll OCR it, match against the roster, then approve before queuing.";
    },
    submitUrl: ({ reuploadFor }) =>
      reuploadFor ? "/api/ocr/reupload" : "/api/ocr/prepare",
    sections: { roster: true, formType: true },
    buildSuccessToast: (_resp, file) => ({
      title: "Preparation started",
      description: file.name,
    }),
  },
  "oath-upload": {
    title: () => "Upload Oath PDF",
    description: () =>
      "Pick a scanned oath PDF and a roster source — we’ll OCR it, match against the roster, fan out signatures, and file the HR ticket.",
    submitUrl: () => "/api/oath-upload/start",
    // Roster picker is required because oath-upload delegates to OCR, which needs
    // a roster to match the OCR'd names → EIDs before fanning out oath-signature.
    sections: { roster: true, duplicateCheck: true },
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
