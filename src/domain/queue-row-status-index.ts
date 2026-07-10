/**
 * Static registration of every workflow's queue-row status extensions for the
 * **client** path.
 *
 * The dashboard (`EntryItem`) resolves status via `resolveQueueRowStatus`, which
 * reads the registry in `queue-row-status.ts`. That registry is normally
 * populated server-side by `defineWorkflow`, but `defineWorkflow` never runs in
 * the queue-panel bundle (it would pull every `src/workflows/*` module in). So
 * the client imports THIS index instead, which registers the same rule objects
 * directly. The rule objects live in the domain / tracker-dashboard layers
 * (client-bundle-safe — they import only the existing pure predicates), so no
 * `src/workflows/*` module reaches the bundle.
 *
 * Adding a workflow status extension means: define the rule object in a
 * client-safe module, declare it as `statusExtensions` on the workflow's
 * `defineWorkflow`, AND register it here so the client sees it too.
 */
import { registerWorkflowStatusExtensions } from "./queue-row-status.js";
import { personLookupStatusExtensions } from "./person-lookup-status.js";
import { personMatchStatusExtensions } from "./person-match-status.js";
import { separationsStatusExtensions } from "./separations-status.js";
import { identityApprovalStatusExtensions } from "./identity-approval.js";
import { oathSignatureStatusExtensions } from "./oath-signature-status.js";
import { ocrStatusExtensions } from "../tracker/dashboard/ocr-status.js";

registerWorkflowStatusExtensions("person-lookup", personLookupStatusExtensions);
registerWorkflowStatusExtensions("person-match", personMatchStatusExtensions);
registerWorkflowStatusExtensions("separations", separationsStatusExtensions);
// Onboarding shares the identity-approval gate (CRM record vs UCPath
// person-search match) — same derived awaitingApproval/dismissed badge.
registerWorkflowStatusExtensions("onboarding", identityApprovalStatusExtensions);
registerWorkflowStatusExtensions("oath-signature", oathSignatureStatusExtensions);
registerWorkflowStatusExtensions("ocr", ocrStatusExtensions);
