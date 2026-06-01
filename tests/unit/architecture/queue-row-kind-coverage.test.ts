/**
 * Every workflow.ts with a defineWorkflow call must declare an explicit
 * `inputSubject:` (name | eid | email | kualiId | pdf | selector, or a
 * resolver) and a `code:` (2-char provenance prefix for trace ids + daemon
 * instance names). The presentation `queueRowKind` is derived from the input
 * subject; the kernel defaults a missing subject to "name" and a missing code
 * to the first two letters of the name, but explicit declarations keep the
 * input-subject axis visible and the codes collision-free.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const WORKFLOWS_DIR = join(process.cwd(), "src/workflows");

function workflowDirs(): string[] {
  return readdirSync(WORKFLOWS_DIR).filter((name) =>
    statSync(join(WORKFLOWS_DIR, name)).isDirectory(),
  );
}

const declaredCodes: Array<{ dir: string; code: string }> = [];

for (const dir of workflowDirs()) {
  const workflowFile = join(WORKFLOWS_DIR, dir, "workflow.ts");
  let src: string;
  try {
    src = readFileSync(workflowFile, "utf8");
  } catch {
    continue; // no workflow.ts — skip
  }
  if (!src.includes("defineWorkflow(")) continue;

  test(`${dir}/workflow.ts declares inputSubject`, () => {
    const hasLiteral = /inputSubject:\s*["'](name|eid|email|kualiId|pdf|selector)["']/.test(src);
    const hasResolver = /inputSubject:\s*(\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>/.test(src);
    assert.ok(
      hasLiteral || hasResolver,
      `src/workflows/${dir}/workflow.ts calls defineWorkflow but does not declare 'inputSubject:'. ` +
        `Add 'inputSubject: "name"|"eid"|"email"|"kualiId"|"pdf"|"selector"' (or a resolver: '(input) => ...').`,
    );
  });

  test(`${dir}/workflow.ts declares a 2-char code`, () => {
    const match = /\bcode:\s*["']([a-z0-9]{2})["']/.exec(src);
    assert.ok(
      match,
      `src/workflows/${dir}/workflow.ts must declare a 2-char lowercase 'code:' ` +
        `(provenance prefix for trace ids + daemon instance names).`,
    );
    declaredCodes.push({ dir, code: match![1] });
  });
}

test("workflow codes are unique across workflows", () => {
  const byCode = new Map<string, string[]>();
  for (const { dir, code } of declaredCodes) {
    byCode.set(code, [...(byCode.get(code) ?? []), dir]);
  }
  const collisions = [...byCode.entries()].filter(([, dirs]) => dirs.length > 1);
  assert.equal(
    collisions.length,
    0,
    `Duplicate workflow code(s): ${collisions
      .map(([code, dirs]) => `'${code}' used by ${dirs.join(", ")}`)
      .join("; ")}. Each workflow needs a unique 2-char code.`,
  );
});
