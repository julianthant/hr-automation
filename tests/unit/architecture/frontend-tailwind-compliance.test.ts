import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const DASHBOARD = join(ROOT, "src/dashboard");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else if (
      entry.endsWith(".ts") ||
      entry.endsWith(".tsx") ||
      entry.endsWith(".css")
    ) {
      out.push(full);
    }
  }
  return out;
}

function rel(path: string): string {
  return relative(ROOT, path);
}

function lineOf(sourceFile: ts.SourceFile, pos: number): number {
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
}

function getJsxAttribute(
  attributes: ts.JsxAttributes,
  name: string,
): ts.JsxAttribute | undefined {
  return attributes.properties.find(
    (prop): prop is ts.JsxAttribute =>
      ts.isJsxAttribute(prop) &&
      ts.isIdentifier(prop.name) &&
      prop.name.text === name,
  );
}

function collectDashboardImageIssues(): string[] {
  const issues: string[] = [];
  for (const file of walk(DASHBOARD).filter((item) => item.endsWith(".tsx"))) {
    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );

    function visit(node: ts.Node): void {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node;
        if (opening.tagName.getText(sourceFile) === "img") {
          for (const attr of ["srcSet", "sizes"]) {
            if (!getJsxAttribute(opening.attributes, attr)) {
              issues.push(`${rel(file)}:${lineOf(sourceFile, node.pos)} missing ${attr}`);
            }
          }
          if (
            !getJsxAttribute(opening.attributes, "loading") &&
            !getJsxAttribute(opening.attributes, "fetchPriority")
          ) {
            issues.push(
              `${rel(file)}:${lineOf(sourceFile, node.pos)} missing loading/fetchPriority`,
            );
          }
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }
  return issues;
}

describe("dashboard Tailwind compliance", () => {
  it("keeps dashboard animation on Tailwind utilities with reduced-motion coverage", () => {
    const violations: string[] = [];
    for (const file of walk(DASHBOARD)) {
      const path = rel(file);
      const text = readFileSync(file, "utf8");
      if (/@keyframes\b/.test(text)) violations.push(`${path} uses @keyframes`);
      if (/\banimate-\[[^\]]+\]/.test(text)) {
        violations.push(`${path} uses arbitrary animate-[...]`);
      }
      if (/\banimation\s*:/.test(text)) {
        violations.push(`${path} sets animation outside Tailwind utilities`);
      }

      text.split("\n").forEach((line, index) => {
        if (!/\banimate-(spin|pulse|ping|bounce)\b/.test(line)) return;
        if (
          !/\bmotion-safe:animate-(spin|pulse|ping|bounce)\b/.test(line) &&
          !/\bmotion-reduce:animate-none\b/.test(line)
        ) {
          violations.push(`${path}:${index + 1} animation lacks reduced-motion coverage`);
        }
      });
    }

    assert.deepEqual(violations.sort(), []);
  });

  it("uses the Tailwind z-index scale and current flex shorthand in dashboard code", () => {
    const violations = walk(DASHBOARD)
      .flatMap((file) => {
        const path = rel(file);
        const text = readFileSync(file, "utf8");
        const out: string[] = [];
        if (/\bz-\[[^\]]+\]/.test(text)) out.push(`${path} uses arbitrary z-index`);
        if (/\bflex-shrink-0\b/.test(text)) out.push(`${path} uses flex-shrink-0`);
        return out;
      })
      .sort();

    assert.deepEqual(violations, []);
  });

  it("keeps dashboard images responsive and explicit about loading priority", () => {
    assert.deepEqual(collectDashboardImageIssues().sort(), []);
  });
});
