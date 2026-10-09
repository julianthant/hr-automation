/**
 * A token template string interpolated against a flat string record.
 * Tokens are `{name}`-style; see `template.ts` for the resolution + vocabulary.
 * Example: "{name} ({emplId})", "{code}-{HHMMSS}-{runId4}".
 */
export type PresentationTemplate = string;

/** Curated title schemes. `custom-template` reads `NamingPart.template`. */
export type TitleSchemeId =
  | "person-name" // resolved employee name (current person-kind title)
  | "pdf-filename" // data.pdfOriginalName (current file-kind title)
  | "catalog-label" // registry/spec label (current catalog-kind title)
  | "operation-anchor" // no title — count badge identifies the row
  | "custom-template";

/** Curated subtitle schemes. */
export type SubtitleSchemeId =
  | "eid-else-trace" // EID if present, else trace id (current default)
  | "trace-only" // trace id only
  | "eid-only"
  | "email"
  | "custom-template";

/**
 * Trace schemes. Conservative by design — defaults to the universal scheme.
 * `custom-template` is advanced; it changes only how NEW runs compose their
 * frozen trace id, never an existing row's stamped `__traceId`.
 */
export type TraceSchemeId =
  | "code-time-runid" // {code}-{HHMMSS}-{runId4} (current universal scheme)
  | "custom-template";

export interface NamingPartTitle {
  scheme: TitleSchemeId;
  /** Required iff scheme === "custom-template". */
  template?: PresentationTemplate;
}
export interface NamingPartSubtitle {
  scheme: SubtitleSchemeId;
  template?: PresentationTemplate;
}
export interface NamingPartTrace {
  scheme: TraceSchemeId;
  template?: PresentationTemplate;
}

export interface NamingConfig {
  title?: NamingPartTitle;
  subtitle?: NamingPartSubtitle;
  /** Optional — omitted means the universal `code-time-runid` scheme. */
  trace?: NamingPartTrace;
}

/** One displayed step's presentational rule. Purely display — never execution. */
export interface StepDisplayRule {
  /** Must match a `WorkflowConfig.steps` entry or an `auth:<system>` step. */
  step: string;
  /** Hide this step from the timeline. */
  hidden?: boolean;
  /** Override the displayed label (default: formatStepName(step)). */
  label?: string;
  /** Render this step folded into another step's chip (generalizes OCR folding). */
  foldInto?: string;
}

export interface StepDisplayConfig {
  /** Explicit display order of step ids; unlisted steps keep declared order, appended. */
  order?: string[];
  rules?: StepDisplayRule[];
}

export interface DelegationDisplayConfig {
  /** Title naming for delegated member rows. */
  memberTitle?: NamingPartTitle;
  /** Subtitle naming for delegated member rows. */
  memberSubtitle?: NamingPartSubtitle;
  /** Title naming for OCR prep rows. */
  prepTitle?: NamingPartTitle;
  /** Suffix appended to an operation coordinator's label (e.g. "Operation"). */
  coordinatorLabelSuffix?: string;
}

/** The uniform presentation block. All parts optional — undeclared falls to defaults. */
export interface WorkflowPresentationConfig {
  naming?: NamingConfig;
  steps?: StepDisplayConfig;
  delegation?: DelegationDisplayConfig;
}

/**
 * The override file shape persisted under `config/workflow-presentation/<workflow>.json`.
 * Every field optional — only set keys override the code defaults. `presentation`
 * is deep-merged; the scalar/array fields replace wholesale.
 */
export interface WorkflowOverride {
  label?: string;
  category?: string;
  iconName?: string;
  detailFields?: Array<{
    key: string;
    label: string;
    editable?: boolean;
    displayInGrid?: boolean;
    multiline?: boolean;
    conditional?: boolean;
  }>;
  presets?: Array<{ id: string; label: string; skipSteps: string[]; description?: string }>;
  presentation?: WorkflowPresentationConfig;
}
