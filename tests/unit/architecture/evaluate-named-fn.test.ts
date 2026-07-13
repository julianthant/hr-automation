import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Guard: NEVER declare a NAMED function inside a page-evaluated callback
 * (`page.evaluate`, `locator.evaluateAll`, `$$eval`, …).
 *
 * tsx/esbuild compiles with keep-names, so `const readField = (id) => …`
 * becomes `const readField = __name((id) => …, "readField")`. `__name` is a
 * helper esbuild injects into the NODE module scope — it does not exist in the
 * browser page, and Playwright serializes only the callback's source. The
 * callback therefore throws `ReferenceError: __name is not defined` INSIDE the
 * page, on every call.
 *
 * That failure is silent-by-shape: the evaluate rejects, a `catch` degrades to
 * a default, and the run reports a plausible-but-empty result. It shipped
 * exactly that way — live 2026-07-13, `searchPerson`'s match extraction threw
 * this on every found person, so all 5 UCPath matches in the separations I-9
 * check came back "found" with NO Empl ID and NO name. `job-summary.ts` had
 * already hit it twice and left warning comments; the next author reintroduced
 * it anyway. Hence a mechanical guard.
 *
 * The fix is always the same: INLINE the helper. Anonymous callbacks passed
 * straight to `.map` / `.filter` / `.find` are fine — only NAMED bindings
 * (`const f = …`, `function f() {}`) get the `__name` wrapper.
 */

const ROOT = process.cwd();
const SCAN_DIRS = ["src"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** Source span of each page-evaluated callback: from the call to its closing paren. */
function evaluateCallbackSpans(src: string): Array<{ index: number; body: string }> {
  const spans: Array<{ index: number; body: string }> = [];
  const call = /\.(?:evaluate|evaluateAll|evaluateHandle|\$\$eval|\$eval)\(/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(src)) !== null) {
    let depth = 0;
    let i = src.indexOf("(", m.index);
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    spans.push({ index: m.index, body: src.slice(start, i) });
  }
  return spans;
}

/** A named binding declared inside the callback — what esbuild wraps in `__name`. */
const NAMED_BINDING =
  /\b(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>|\bfunction\s+\w+\s*\(/;

/** Comments describing this very hazard are not offenders — match code only. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split("\n").length;
}

describe("architecture: no named functions inside page-evaluated callbacks", () => {
  it("every evaluate/evaluateAll callback declares only anonymous callbacks", () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of walk(join(ROOT, dir))) {
        const src = readFileSync(file, "utf8");
        for (const span of evaluateCallbackSpans(src)) {
          const hit = NAMED_BINDING.exec(stripComments(span.body));
          if (!hit) continue;
          offenders.push(
            `${relative(ROOT, file)}:${lineOf(src, span.index)} — named binding inside an evaluated callback: ${hit[0].trim()}`,
          );
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `Named function(s) declared inside a page-evaluated callback. esbuild keep-names wraps these in \`__name(...)\`, `
        + `which is undefined in the browser page — the callback throws ReferenceError at runtime, in the page, on every call.\n`
        + `Fix: inline the helper (anonymous .map/.find callbacks are fine).\n\n`
        + offenders.join("\n"),
    );
  });
});
