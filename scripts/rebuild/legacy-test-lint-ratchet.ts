import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { ESLint } from "eslint";
import { isDirectExecution, resolveScopeFiles } from "./scope-files.js";

const ROOT = process.cwd();
const PRESERVATION_PATH = resolve(ROOT, "config/rebuild/legacy-preservation.json");
const MANIFEST_PATH = resolve(ROOT, "config/rebuild/legacy-test-lint.json");

interface PreservationManifest {
  readonly baselineCommit: string;
  readonly roots: readonly { readonly root: string; readonly files: readonly string[] }[];
}

interface LintFingerprint {
  readonly file: string;
  readonly ruleId: string | null;
  readonly message: string;
  readonly severity: 1 | 2;
  readonly startColumn: number;
  readonly endColumn: number | null;
  readonly sourceLineSha256: string;
}

interface LintManifest {
  readonly schemaVersion: 1;
  readonly baselineCommit: string;
  readonly baselineLintedFileCount: number;
  readonly baselineDiagnosticFileCount: number;
  readonly baselineErrorCount: number;
  readonly baselineWarningCount: number;
  readonly diagnostics: readonly LintFingerprint[];
}

function parseJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function lintable(path: string): boolean {
  return /\.(?:ts|tsx|js|cjs|mjs)$/.test(path);
}

function sourceLine(result: ESLint.LintResult, line: number | undefined): string {
  if (line === undefined || result.source === undefined) return "";
  return result.source.split(/\r?\n/)[line - 1] ?? "";
}

function toFingerprint(
  result: ESLint.LintResult,
  message: ESLint.LintResult["messages"][number],
): LintFingerprint {
  const repoPath = relative(ROOT, result.filePath).replaceAll("\\", "/");
  const semanticMessage = message.messageId ?? message.message;
  return {
    file: repoPath,
    ruleId: message.ruleId,
    message: semanticMessage,
    severity: message.severity,
    startColumn: message.column,
    endColumn: message.endColumn ?? null,
    sourceLineSha256: createHash("sha256")
      .update(sourceLine(result, message.line))
      .digest("hex"),
  };
}

function fingerprintKey(fingerprint: LintFingerprint): string {
  return JSON.stringify(fingerprint);
}

function sortedFingerprints(results: readonly ESLint.LintResult[]): LintFingerprint[] {
  return results
    .flatMap((result) => result.messages.map((message) => toFingerprint(result, message)))
    .sort((a, b) => fingerprintKey(a).localeCompare(fingerprintKey(b)));
}

function countKeys(fingerprints: readonly LintFingerprint[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const fingerprint of fingerprints) {
    const key = fingerprintKey(fingerprint);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

async function lintFiles(files: readonly string[]): Promise<ESLint.LintResult[]> {
  const eslint = new ESLint();
  return eslint.lintFiles(files.map((file) => resolve(ROOT, file)));
}

function baselineTestFiles(preservation: PreservationManifest): string[] {
  const testRoot = preservation.roots.find(({ root }) => root === "tests");
  if (!testRoot) throw new Error("legacy-preservation.json is missing the tests root.");
  return testRoot.files.filter(lintable);
}

async function currentLegacyTestFiles(): Promise<string[]> {
  const scope = resolveScopeFiles(resolve(ROOT, "tests"), [".ts", ".tsx", ".js", ".cjs", ".mjs"]);
  return scope.files
    .map((path) => relative(ROOT, path).replaceAll("\\", "/"))
    .filter((path) => !path.startsWith("tests/rebuild/"));
}

export async function buildBaselineManifest(): Promise<LintManifest> {
  const preservation = parseJson<PreservationManifest>(PRESERVATION_PATH);
  const files = baselineTestFiles(preservation);
  const results = await lintFiles(files);
  const diagnostics = sortedFingerprints(results);
  return {
    schemaVersion: 1,
    baselineCommit: preservation.baselineCommit,
    baselineLintedFileCount: files.length,
    baselineDiagnosticFileCount: new Set(diagnostics.map(({ file }) => file)).size,
    baselineErrorCount: diagnostics.filter(({ severity }) => severity === 2).length,
    baselineWarningCount: diagnostics.filter(({ severity }) => severity === 1).length,
    diagnostics,
  };
}

export async function verifyLegacyTestLintDebt(): Promise<void> {
  const manifest = parseJson<LintManifest>(MANIFEST_PATH);
  const current = sortedFingerprints(await lintFiles(await currentLegacyTestFiles()));
  const allowed = countKeys(manifest.diagnostics);
  const seen = new Map<string, number>();
  const newDiagnostics: LintFingerprint[] = [];

  for (const diagnostic of current) {
    const key = fingerprintKey(diagnostic);
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count > (allowed.get(key) ?? 0)) newDiagnostics.push(diagnostic);
  }

  if (newDiagnostics.length > 0) {
    throw new Error(
      `Legacy test lint debt ratchet found ${newDiagnostics.length} new/replaced diagnostic(s):\n` +
        newDiagnostics.slice(0, 30).map((entry) => JSON.stringify(entry)).join("\n"),
    );
  }

  const errors = current.filter(({ severity }) => severity === 2).length;
  const warnings = current.filter(({ severity }) => severity === 1).length;
  const removed = manifest.diagnostics.length - current.length;
  console.log(
    `Legacy test lint ratchet: ${errors} error(s), ${warnings} warning(s); ${removed} baseline diagnostic(s) removed; zero new/replaced fingerprints.`,
  );
}

if (isDirectExecution(import.meta.url)) {
  if (process.argv.includes("--print-baseline")) {
    console.log(JSON.stringify(await buildBaselineManifest(), null, 2));
  } else {
    await verifyLegacyTestLintDebt();
  }
}
