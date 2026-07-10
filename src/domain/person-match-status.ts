/**
 * Person Match's queue-row status extensions.
 *
 * The whole point of a person-match run is the found / not-found answer, so a
 * completed run whose UCPath person search came back empty promotes to the
 * shared `notFound` display status (the automation succeeded — tracker status
 * stays `done` — but the queue should read "Not found", mirroring
 * person-lookup's rule in `person-lookup-status.ts`).
 *
 * Lives in the domain layer (not `src/workflows/person-match/`) so the
 * dashboard can resolve it without importing a `src/workflows/*` module — the
 * person-match `defineWorkflow` call re-exports this object as its
 * `statusExtensions` declaration.
 */
import type { WorkflowStatusExtensions } from "./queue-row-status.js";

export const personMatchStatusExtensions: WorkflowStatusExtensions = {
  derivedStatus: (entry) =>
    entry.status === "done" && entry.data?.found === "false" ? "notFound" : null,
};
