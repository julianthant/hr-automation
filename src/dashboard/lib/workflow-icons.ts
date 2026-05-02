import {
  Briefcase,
  ClipboardSignature,
  Download,
  FileScan,
  FileText,
  Phone,
  Search,
  UploadCloud,
  UserMinus,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";

/**
 * Static map from `iconName` (declared in `defineWorkflow`) to a lucide-react
 * component. Static imports are required so Vite tree-shakes lucide-react
 * properly — a fully dynamic resolver would pull the entire icon set into
 * the bundle.
 *
 * Adding a new workflow with an existing icon name = zero edits here.
 * Adding one with a new icon = one new entry below + one named import.
 */
const WORKFLOW_ICONS: Record<string, LucideIcon> = {
  Briefcase,
  ClipboardSignature,
  Download,
  FileScan,
  FileText,
  Phone,
  Search,
  UploadCloud,
  UserMinus,
  Users,
};

/**
 * Resolve an `iconName` string to a lucide component, falling back to the
 * generic `Workflow` icon for unknown / missing names. Logs a `console.warn`
 * once per unknown name in dev so misconfigured workflows are loud, not
 * silent.
 */
const warnedFor = new Set<string>();
export function getWorkflowIcon(iconName: string | undefined | null): LucideIcon {
  if (!iconName) return Workflow;
  const icon = WORKFLOW_ICONS[iconName];
  if (icon) return icon;
  if (!warnedFor.has(iconName)) {
    warnedFor.add(iconName);
    console.warn(
      `[workflow-icons] No lucide icon registered for iconName="${iconName}". ` +
        `Add an entry to src/dashboard/lib/workflow-icons.ts.`,
    );
  }
  return Workflow;
}
