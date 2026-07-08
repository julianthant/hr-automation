/**
 * Shared base for bespoke, code-discriminated workflow errors.
 *
 * The default in this codebase is a plain `Error` with a descriptive message
 * (root CLAUDE.md "Fail loud" — the message names the offending value/EID/
 * field). Subclass `WorkflowError` only when a CALLER needs to branch on the
 * failure programmatically — an `instanceof` check to escape a step's
 * generic catch-and-continue for one specific fatal condition (see
 * `EmplIdNotRecognizedError`), or a `code` a route handler switches on to
 * pick an HTTP status (see `RetryPageError`). Do not subclass just to carry a
 * message; a plain `throw new Error(...)` remains correct for the ~90 other
 * throw sites in the codebase that nobody branches on.
 *
 * `code` is optional and generic so a subclass can narrow it to its own
 * closed string union (e.g. `WorkflowError<"row-not-found" | "spec-missing">`)
 * while callers that only need `instanceof` can ignore it entirely.
 */
export class WorkflowError<TCode extends string = string> extends Error {
  public readonly code?: TCode;

  constructor(message: string, code?: TCode) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
  }
}
