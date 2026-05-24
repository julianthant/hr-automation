/**
 * Contract 3 — delegateToAllImpl escape hatch guard.
 *
 * `delegateToAllImpl` exposes internal hooks used only by OCR's
 * orchestrator-level eid-lookup fan-out. Production code should normally
 * call the public `ctx.delegateToAll` API; adding a second direct consumer
 * means the hooks need to be promoted to that public options object with
 * explicit tests.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SRC_DIR = join(ROOT, "src");

const ALLOWED_CALLERS = new Set<string>([
  "src/workflows/ocr/orchestrator.ts",
]);

const IGNORED_FILES = new Set<string>([
  // Definition plus public ctx.delegateToAll wrapper internals.
  "src/core/delegate.ts",
]);

function listSourceFiles(dir: string): string[] {
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

function stripCommentsPreserveLines(src: string): string {
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

test("delegateToAllImpl direct production callers stay limited to OCR orchestrator", () => {
  const offenders: Array<{ file: string; line: number; match: string }> = [];
  const callPattern = /\bdelegateToAllImpl(?:\s*<[^;\n]*?>)?\s*\(/;

  for (const file of listSourceFiles(SRC_DIR)) {
    const rel = relative(ROOT, file);
    if (IGNORED_FILES.has(rel) || ALLOWED_CALLERS.has(rel)) continue;

    const src = stripCommentsPreserveLines(readFileSync(file, "utf8"));
    const lines = src.split("\n");

    lines.forEach((line, idx) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("import ")) return;
      if (!callPattern.test(line)) return;
      offenders.push({ file: rel, line: idx + 1, match: line.trim() });
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `delegateToAllImpl is an OCR-orchestrator-only escape hatch. New production callers should use ctx.delegateToAll, or promote the internal hooks to the public options object with explicit tests.\n` +
      offenders.map((o) => `  ${o.file}:${o.line}  ${o.match}`).join("\n"),
  );
});
