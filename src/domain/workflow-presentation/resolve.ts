// src/domain/workflow-presentation/resolve.ts
import type {
  NamingConfig,
  NamingPartSubtitle,
  NamingPartTitle,
  WorkflowPresentationConfig,
} from "./types.js";
import { resolveSubtitle, resolveTitle } from "./schemes.js";

/**
 * The back-compat default presentation derived from a workflow's input subject.
 * Mirrors today's `resolveQueueRowPresentation` kind dispatch so an undeclared
 * `presentation` renders identically to pre-this-feature behavior.
 */
export function defaultPresentationFromMetadata(args: {
  inputSubject?: string;
  archetype: string;
}): WorkflowPresentationConfig {
  const kind = subjectToKind(args.inputSubject);
  let title: NamingPartTitle;
  let subtitle: NamingPartSubtitle;
  if (kind === "file") {
    title = { scheme: "pdf-filename" };
    subtitle = { scheme: "trace-only" };
  } else if (kind === "catalog") {
    title = { scheme: "catalog-label" };
    subtitle = { scheme: "trace-only" };
  } else {
    title = { scheme: "person-name" };
    subtitle = { scheme: "eid-else-trace" };
  }
  const naming: NamingConfig = { title, subtitle, trace: { scheme: "code-time-runid" } };
  return { naming };
}

function subjectToKind(inputSubject?: string): "person" | "file" | "catalog" {
  switch (inputSubject) {
    case "pdf":
      return "file";
    case "selector":
      return "catalog";
    default:
      return "person"; // name | eid | email | kualiId | undefined
  }
}

/**
 * Resolve a row's title + subtitle from variables and a NamingConfig.
 * `preferTraceIdSubtitle` mirrors the queue-row-presentation flag: when the EID
 * already shows on the title line (batch/preview anchors, members), the subtitle
 * falls through to the trace id even under the eid-else-trace scheme.
 *
 * `naming.title` and `naming.subtitle` are optional; omitted parts fall back to
 * `person-name` and `eid-else-trace` respectively — identical to today's defaults.
 */
export function resolveNaming(
  vars: Record<string, string>,
  naming: NamingConfig,
  opts: { preferTraceIdSubtitle?: boolean } = {},
): { title: string; subtitle?: string } {
  const titlePart = naming.title ?? { scheme: "person-name" as const };
  const subtitlePart = naming.subtitle ?? { scheme: "eid-else-trace" as const };
  const title = resolveTitle(vars, titlePart);
  let subtitle: string;
  if (opts.preferTraceIdSubtitle && subtitlePart.scheme === "eid-else-trace") {
    const trace = (vars.traceId ?? vars.__traceId ?? "").trim();
    subtitle = trace || resolveSubtitle(vars, subtitlePart);
  } else {
    subtitle = resolveSubtitle(vars, subtitlePart);
  }
  return { title, subtitle: subtitle || undefined };
}

/**
 * Deep-merge an override over a base presentation. `naming.title`,
 * `naming.subtitle`, `naming.trace` merge part-by-part (override part wins
 * wholesale); `steps` and `delegation` replace wholesale when present in the
 * override (they are small, fully-specified blocks). Undefined override → base.
 */
export function mergePresentation(
  base: WorkflowPresentationConfig,
  override?: WorkflowPresentationConfig,
): WorkflowPresentationConfig {
  if (!override) return base;
  const merged: WorkflowPresentationConfig = { ...base };
  if (override.naming) {
    merged.naming = {
      title: override.naming.title ?? base.naming?.title ?? { scheme: "person-name" },
      subtitle: override.naming.subtitle ?? base.naming?.subtitle ?? { scheme: "eid-else-trace" },
      trace: override.naming.trace ?? base.naming?.trace,
    };
  }
  if (override.steps) merged.steps = override.steps;
  if (override.delegation) merged.delegation = { ...base.delegation, ...override.delegation };
  return merged;
}
