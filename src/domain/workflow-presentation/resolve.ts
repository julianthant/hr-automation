// src/domain/workflow-presentation/resolve.ts
import type {
  NamingConfig,
  NamingPartSubtitle,
  NamingPartTitle,
  WorkflowPresentationConfig,
} from "./types.js";

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
