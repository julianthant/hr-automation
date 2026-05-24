/**
 * Shared utilities for architecture tests that scan the source tree.
 *
 * Extracted from the three architecture test files that previously inlined
 * these helpers: delegate-to-usage.test.ts, tracker-row-emission.test.ts,
 * and delegate-to-all-impl-callers.test.ts.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Recursively collect all `.ts` / `.tsx` files under `dir`, excluding `.d.ts`
 * declaration files. Returns absolute paths.
 */
export function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if ((name.endsWith(".ts") || name.endsWith(".tsx")) && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Strip single-line (`//`) and block (`/* … *\/`) comments from TypeScript
 * source while preserving line numbers. String literals (single, double,
 * template) are passed through verbatim so comment-like sequences inside
 * strings don't trigger stripping.
 *
 * Used by architecture guards that pattern-match against source lines so a
 * `/* runWorkflow(...) *\/` comment doesn't false-positive as a live call.
 */
export function stripCommentsPreserveLines(src: string): string {
  let out = "";
  let inBlock = false;
  let inLine = false;
  let quote: '"' | "'" | "`" | undefined;
  let escaped = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i] ?? "";
    const next = src[i + 1] ?? "";

    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += "\n";
      } else {
        out += " ";
      }
      continue;
    }

    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        out += "  ";
        i += 1;
      } else {
        out += ch === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (quote) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = undefined;
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      inLine = true;
      out += "  ";
      i += 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlock = true;
      out += "  ";
      i += 1;
      continue;
    }

    if (ch === "\"" || ch === "'" || ch === "`") {
      quote = ch;
    }
    out += ch;
  }

  return out;
}
