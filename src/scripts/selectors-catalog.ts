// src/scripts/selectors-catalog.ts
//
// Walk every `src/systems/<sys>/selectors.ts`, extract every exported selector
// (top-level functions, top-level const arrow functions, and arrow functions
// nested inside exported object literals like `smartHR.tab.personalData`), and
// emit a `SELECTORS.md` per system with one H2 per selector.
//
// JSDoc summary, @tags directive, and `verified YYYY-MM-DD` date are all
// pulled from the leading JSDoc block. The file:line ref points back to
// the selector for click-through.
//
// Run with: `npm run selectors:catalog`
//
// Pure where possible: `extractSelectors(filePath)` is exported and unit-
// tested against in-memory fixtures. The `main()` driver only does I/O.

import { readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";

export interface SelectorRecord {
  /** Fully qualified name — e.g. `smartHR.tab.personalData` or top-level `getContentFrame`. */
  name: string;
  /** First line of JSDoc, with the `verified ...` suffix stripped. */
  summary: string;
  /** Tags from a `@tags a, b, c` JSDoc directive (split + trimmed). */
  tags: string[];
  /** ISO date from a `verified YYYY-MM-DD` mention in the JSDoc. */
  verifiedDate: string | null;
  /** 1-indexed line number of the selector definition. */
  line: number;
}

const SYSTEMS_DIR = "src/systems";

function isExported(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function getJsDocBlock(node: ts.Node): ts.JSDoc | undefined {
  const jsdocs = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc);
  return jsdocs[jsdocs.length - 1]; // The closest preceding block.
}

function extractSummaryTagsVerified(jsdoc: ts.JSDoc | undefined): {
  summary: string;
  tags: string[];
  verifiedDate: string | null;
} {
  if (!jsdoc) return { summary: "(no JSDoc)", tags: [], verifiedDate: null };
  const commentText =
    typeof jsdoc.comment === "string"
      ? jsdoc.comment
      : (jsdoc.comment ?? []).map((c) => c.text).join("");
  // Strip "verified YYYY-MM-DD" from the summary line so it doesn't appear twice.
  const verifiedMatch = commentText.match(/verified\s+(\d{4}-\d{2}-\d{2})/);
  const verifiedDate = verifiedMatch ? verifiedMatch[1] : null;
  const summary = commentText
    .split("\n")[0]
    .replace(/verified\s+\d{4}-\d{2}-\d{2}.*$/, "")
    .trim();

  const tags: string[] = [];
  for (const tag of jsdoc.tags ?? []) {
    if (tag.tagName.text === "tags") {
      const tagText =
        typeof tag.comment === "string"
          ? tag.comment
          : (tag.comment ?? []).map((c) => c.text).join("");
      tags.push(...tagText.split(",").map((t) => t.trim()).filter(Boolean));
    }
  }

  return { summary: summary || "(no summary)", tags, verifiedDate };
}

function visitObjectLiteral(
  obj: ts.ObjectLiteralExpression,
  prefix: string,
  sf: ts.SourceFile,
  out: SelectorRecord[],
): void {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    if (!ts.isIdentifier(prop.name)) continue;
    const propName = prop.name.text;
    const fqn = `${prefix}.${propName}`;
    const jsdoc = getJsDocBlock(prop);

    if (
      ts.isArrowFunction(prop.initializer) ||
      ts.isFunctionExpression(prop.initializer)
    ) {
      const { summary, tags, verifiedDate } = extractSummaryTagsVerified(jsdoc);
      const { line } = sf.getLineAndCharacterOfPosition(prop.getStart());
      out.push({ name: fqn, summary, tags, verifiedDate, line: line + 1 });
    } else if (ts.isObjectLiteralExpression(prop.initializer)) {
      visitObjectLiteral(prop.initializer, fqn, sf, out);
    }
  }
}

/**
 * Pure: parse a TypeScript source string and return all exported selectors.
 * `filePath` is used only for `ts.createSourceFile`'s file-name arg + line
 * computation — no disk reads.
 */
export function extractSelectors(filePath: string, source: string): SelectorRecord[] {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const out: SelectorRecord[] = [];

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && isExported(stmt)) {
      const jsdoc = getJsDocBlock(stmt);
      const { summary, tags, verifiedDate } = extractSummaryTagsVerified(jsdoc);
      const { line } = sf.getLineAndCharacterOfPosition(stmt.getStart());
      out.push({ name: stmt.name.text, summary, tags, verifiedDate, line: line + 1 });
    } else if (ts.isVariableStatement(stmt) && isExported(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const declName = decl.name.text;
        if (
          ts.isArrowFunction(decl.initializer) ||
          ts.isFunctionExpression(decl.initializer)
        ) {
          const jsdoc = getJsDocBlock(stmt);
          const { summary, tags, verifiedDate } = extractSummaryTagsVerified(jsdoc);
          const { line } = sf.getLineAndCharacterOfPosition(decl.getStart());
          out.push({ name: declName, summary, tags, verifiedDate, line: line + 1 });
        } else if (ts.isObjectLiteralExpression(decl.initializer)) {
          visitObjectLiteral(decl.initializer, declName, sf, out);
        }
      }
    }
  }
  return out;
}

/** Pure: build a SELECTORS.md from records. */
export function renderCatalog(system: string, records: SelectorRecord[]): string {
  const lines: string[] = [
    `# ${system} — Selector Catalog`,
    "",
    `_Auto-generated by \`npm run selectors:catalog\` from \`src/systems/${system}/selectors.ts\`. Do not hand-edit — re-run the script after changing selectors.ts._`,
    "",
    `**${records.length} selectors** · regenerated ${new Date().toISOString().slice(0, 10)}`,
    "",
    "---",
    "",
  ];
  for (const r of records) {
    const verified = r.verifiedDate ? ` — verified ${r.verifiedDate}` : "";
    lines.push(`## \`${r.name}()\`${verified}`, "");
    lines.push(r.summary, "");
    if (r.tags.length > 0) lines.push(`**Tags:** ${r.tags.join(", ")}`, "");
    lines.push(
      `**Source:** [\`src/systems/${system}/selectors.ts:${r.line}\`](./selectors.ts#L${r.line})`,
      "",
    );
  }
  return lines.join("\n");
}

function listSystems(): string[] {
  return readdirSync(SYSTEMS_DIR).filter((entry) => {
    try {
      const sel = join(SYSTEMS_DIR, entry, "selectors.ts");
      return statSync(sel).isFile();
    } catch {
      return false;
    }
  });
}

function main(): void {
  const systems = listSystems();
  let totalSelectors = 0;
  for (const sys of systems) {
    const filePath = join(SYSTEMS_DIR, sys, "selectors.ts");
    const source = readFileSync(filePath, "utf8");
    const records = extractSelectors(filePath, source);
    const md = renderCatalog(sys, records);
    const outPath = join(SYSTEMS_DIR, sys, "SELECTORS.md");
    writeFileSync(outPath, md, "utf8");
    console.log(`wrote ${outPath} (${records.length} selectors)`);
    totalSelectors += records.length;
  }
  console.log(`\nTotal: ${totalSelectors} selectors across ${systems.length} systems.`);
}

// Only run main when invoked directly. Importable for tests.
if (process.argv[1]?.endsWith("selectors-catalog.ts")) {
  main();
}
