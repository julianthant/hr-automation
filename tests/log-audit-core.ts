/**
 * Stderr allowlist for vitest runs. See tests/log-audit.ts for per-test hooks.
 *
 * Vitest `onConsoleLog` only sees `console.*` output. Libraries such as pdfjs
 * write directly to `process.stderr`; we patch `process.stderr.write` in
 * log-audit.ts to capture those lines too.
 */

export interface StderrViolation {
  file: string;
  log: string;
}

const violations: StderrViolation[] = [];

let activeTestFile = "";
let stderrHookInstalled = false;
let origStderrWrite: typeof process.stderr.write | undefined;

/**
 * Lines tests may emit on stderr without failing the audit.
 * Use `files` to scope allowlist entries to specific test files when the line
 * is expected only in that fixture.
 */
/** Library noise we contract-test elsewhere — never fail the audit. */
const IGNORED_STDERR: RegExp[] = [
  // pdfjs when opening valid pdf-lib fixtures; see render-pages + orchestrator setup asserts
  /^Warning: Indexing all PDF objects$/,
];

const ALLOWED_STDERR: Array<{ pattern: RegExp; files?: RegExp }> = [
  // log.error — intentional failure-path tests
  { pattern: /^✗ / },
  // sse-hub-client malformed envelope test
  { pattern: /^SseHub: malformed envelope/ },
];

function testFilePath(entity: unknown): string {
  if (!entity || typeof entity !== "object") return "";
  const e = entity as { file?: { filepath?: string }; name?: string };
  return e.file?.filepath ?? e.name ?? "";
}

function isAllowedStderr(log: string, file: string): boolean {
  const trimmed = log.trimEnd();
  return ALLOWED_STDERR.some(({ pattern, files }) => {
    if (!pattern.test(trimmed)) return false;
    if (!files) return true;
    return files.test(file);
  });
}

function recordStderrLine(line: string, file: string): void {
  const trimmed = line.trimEnd();
  if (!trimmed) return;
  if (IGNORED_STDERR.some((p) => p.test(trimmed))) return;
  if (isAllowedStderr(trimmed, file)) return;
  violations.push({ file: file || "(unknown file)", log: trimmed });
}

function drainStderrChunk(chunk: string, file: string): void {
  for (const line of chunk.split(/\r?\n/)) {
    recordStderrLine(line, file);
  }
}

/** Called from vitest.config.ts onConsoleLog for stderr lines. */
export function recordConsoleLog(
  log: string,
  type: "stdout" | "stderr",
  entity?: unknown,
): void {
  if (type !== "stderr") return;
  const file = testFilePath(entity) || activeTestFile;
  recordStderrLine(log, file);
}

export function setActiveTestFileForStderrAudit(file: string): void {
  activeTestFile = file;
}

export function installStderrWriteCapture(): void {
  if (stderrHookInstalled) return;
  origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error) => void),
    cb?: (err?: Error) => void,
  ): boolean => {
    const encoding =
      typeof encodingOrCb === "string" ? encodingOrCb : "utf8";
    const text =
      typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk).toString(encoding);
    drainStderrChunk(text, activeTestFile);
    return origStderrWrite!(chunk, encodingOrCb as never, cb as never);
  }) as typeof process.stderr.write;
  stderrHookInstalled = true;
}

export function uninstallStderrWriteCapture(): void {
  if (!stderrHookInstalled || !origStderrWrite) return;
  process.stderr.write = origStderrWrite;
  stderrHookInstalled = false;
  origStderrWrite = undefined;
}

export function resetStderrAudit(): void {
  violations.length = 0;
}

export function assertNoUnexpectedStderr(): void {
  if (violations.length === 0) return;
  const detail = violations
    .map((v) => `  [${v.file}]\n    ${v.log}`)
    .join("\n");
  throw new Error(
    `Unexpected stderr (${violations.length} line(s)) — not on the test allowlist. ` +
      `Add a scoped entry to ALLOWED_STDERR in tests/log-audit-core.ts only when the line is intentional test output:\n${detail}`,
  );
}
