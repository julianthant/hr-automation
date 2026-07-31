import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, relative, resolve } from "node:path";
import ts from "typescript";
import { walkFiles } from "./guard-files.js";

export const REQUIRED_REBUILD_RATCHET_NAMES = [
  "fail-loud-catch-default",
  "nullish-literal-data-fallback",
  "wait-for-timeout-allowlist",
  "inline-selectors-workflows",
  "evaluate-named-fn",
  "import-cycles",
  "control-layering",
  "code-conventions",
  "frontend-tailwind-compliance",
] as const;

export type RebuildRatchetName = typeof REQUIRED_REBUILD_RATCHET_NAMES[number];

export interface RebuildRatchetFixture {
  readonly files: Readonly<Record<string, string>>;
  readonly expected: RegExp;
}

interface RebuildRatchetSpec {
  readonly roots: readonly string[];
  readonly select?: (repoRelativePath: string) => boolean;
  readonly fixture: RebuildRatchetFixture;
}

export interface RebuildRatchetAudit {
  readonly state: "planned-absent" | "active";
  readonly files: readonly string[];
  readonly violations: readonly string[];
}

const SPECS: Readonly<Record<RebuildRatchetName, RebuildRatchetSpec>> = {
  "fail-loud-catch-default": {
    roots: ["temp_src"],
    fixture: {
      files: { "temp_src/core/bad.ts": "export function bad() { try { throw new Error(); } catch { return []; } }\n" },
      expected: /bare default/,
    },
  },
  "nullish-literal-data-fallback": {
    roots: ["temp_src"],
    select: (path) => !path.startsWith("temp_src/dashboard/"),
    fixture: {
      files: { "temp_src/core/bad.ts": "export const bad = (data: { state?: string }) => data.state ?? \"queued\";\n" },
      expected: /nullish literal/,
    },
  },
  "wait-for-timeout-allowlist": {
    roots: ["temp_src/stores"],
    fixture: {
      files: { "temp_src/stores/ucpath/tasks/bad.ts": "export const bad = async (page: any) => page.waitForTimeout(25);\n" },
      expected: /waitForTimeout/,
    },
  },
  "inline-selectors-workflows": {
    roots: ["temp_src/stores"],
    select: (path) => path.includes("/tasks/"),
    fixture: {
      files: { "temp_src/stores/ucpath/tasks/bad.ts": "export const bad = (page: any) => page.locator(\"#employee\");\n" },
      expected: /raw page\/locator/,
    },
  },
  "evaluate-named-fn": {
    roots: ["temp_src/stores"],
    fixture: {
      files: { "temp_src/stores/ucpath/driver/bad.ts": "export const bad = (page: any) => page.evaluate(function named() { return true; });\n" },
      expected: /named evaluated function/,
    },
  },
  "import-cycles": {
    roots: ["temp_src"],
    fixture: {
      files: {
        "temp_src/domain/a.ts": "import { b } from \"./b.js\"; export const a = b;\n",
        "temp_src/domain/b.ts": "import { a } from \"./a.js\"; export const b = a;\n",
      },
      expected: /import cycle/,
    },
  },
  "control-layering": {
    roots: ["temp_src"],
    fixture: {
      files: {
        "temp_src/domain/bad.ts": "import { core } from \"../core/core.js\"; export const bad = core;\n",
        "temp_src/core/core.ts": "export const core = true;\n",
      },
      expected: /layer inversion/,
    },
  },
  "code-conventions": {
    roots: ["temp_src"],
    fixture: {
      files: { "temp_src/core/Bad_name.ts": "const value = true; export default value;\n" },
      expected: /default export|filename/,
    },
  },
  "frontend-tailwind-compliance": {
    roots: ["temp_src/dashboard"],
    fixture: {
      files: { "temp_src/dashboard/Bad.tsx": "export function Bad() { return <div className=\"bg-red-500\">bad</div>; }\n" },
      expected: /palette color/,
    },
  },
};

function normalize(path: string): string {
  return path.replaceAll("\\", "/");
}

function parse(file: string): ts.SourceFile {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, kind);
}

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

function isBareDefault(node: ts.Expression): boolean {
  return node.kind === ts.SyntaxKind.NullKeyword
    || node.kind === ts.SyntaxKind.TrueKeyword
    || node.kind === ts.SyntaxKind.FalseKeyword
    || (ts.isIdentifier(node) && node.text === "undefined")
    || (ts.isNumericLiteral(node) && node.text === "0")
    || (ts.isStringLiteral(node) && node.text === "")
    || (ts.isArrayLiteralExpression(node) && node.elements.length === 0)
    || (ts.isObjectLiteralExpression(node) && node.properties.length === 0);
}

function auditBareDefaults(files: readonly string[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    visit(parse(file), (node) => {
      if (ts.isCatchClause(node) && node.block.statements.length === 1) {
        const statement = node.block.statements[0];
        const expression = ts.isReturnStatement(statement)
          ? statement.expression
          : ts.isExpressionStatement(statement)
            && ts.isBinaryExpression(statement.expression)
            && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
            ? statement.expression.right
            : undefined;
        if (expression && isBareDefault(expression)) violations.push(`${file}: catch returns/assigns a bare default`);
      }
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)
        || node.expression.name.text !== "catch") return;
      const handler = node.arguments[0];
      if (!handler || (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler))) return;
      if (!ts.isBlock(handler.body) && isBareDefault(handler.body)) {
        violations.push(`${file}: promise catch returns a bare default`);
      }
    });
  }
  return violations;
}

function auditNullish(files: readonly string[]): string[] {
  const roots = new Set(["data", "row", "input", "item", "entry", "record", "payload", "fields", "opts", "args"]);
  const violations: string[] = [];
  for (const file of files) {
    visit(parse(file), (node) => {
      if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken) return;
      let left: ts.Expression = node.left;
      while (ts.isPropertyAccessExpression(left)) left = left.expression;
      const literal = ts.isStringLiteral(node.right)
        || (ts.isNumericLiteral(node.right) && node.right.text === "0")
        || node.right.kind === ts.SyntaxKind.TrueKeyword;
      if (literal && ts.isIdentifier(left) && roots.has(left.text)) {
        violations.push(`${file}: data-shaped nullish literal fallback`);
      }
    });
  }
  return violations;
}

function auditCalls(files: readonly string[], names: ReadonlySet<string>, message: string): string[] {
  const violations: string[] = [];
  for (const file of files) {
    visit(parse(file), (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && names.has(node.expression.name.text)) violations.push(`${file}: ${message}`);
    });
  }
  return violations;
}

function auditInlineSelectors(files: readonly string[]): string[] {
  const methods = new Set(["locator", "getByRole", "getByText", "getByLabel", "getByTestId", "frameLocator"]);
  const violations = auditCalls(files, methods, "raw page/locator call in task implementation");
  for (const file of files) {
    visit(parse(file), (node) => {
      if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)
        && (node.typeName.text === "Page" || node.typeName.text === "Locator")) {
        violations.push(`${file}: raw page/locator type in task implementation`);
      }
    });
  }
  return violations;
}

function auditEvaluate(files: readonly string[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    visit(parse(file), (node) => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)
        || !["evaluate", "evaluateAll"].includes(node.expression.name.text)) return;
      const callback = node.arguments[0];
      if (callback && ts.isFunctionExpression(callback) && callback.name) {
        violations.push(`${file}: named evaluated function ${callback.name.text}`);
      }
    });
  }
  return violations;
}

function moduleSpecifiers(file: string): string[] {
  const specs: string[] = [];
  visit(parse(file), (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specs.push(node.moduleSpecifier.text);
  });
  return specs;
}

function resolveModule(file: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const raw = resolve(dirname(file), specifier);
  const candidates = [raw, raw.replace(/\.js$/, ".ts"), raw.replace(/\.js$/, ".tsx"), resolve(raw, "index.ts")];
  return candidates.find(existsSync);
}

function auditCycles(files: readonly string[]): string[] {
  const fileSet = new Set(files.map((file) => resolve(file)));
  const edges = new Map<string, string[]>();
  for (const file of files) {
    edges.set(resolve(file), moduleSpecifiers(file)
      .map((specifier) => resolveModule(file, specifier))
      .filter((target): target is string => target !== undefined && fileSet.has(resolve(target)))
      .map((target) => resolve(target)));
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const violations: string[] = [];
  function walk(node: string, path: readonly string[]): void {
    if (visiting.has(node)) {
      violations.push(`import cycle: ${[...path, node].map((item) => basename(item)).join(" -> ")}`);
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const target of edges.get(node) ?? []) walk(target, [...path, node]);
    visiting.delete(node);
    visited.add(node);
  }
  for (const file of files) walk(resolve(file), []);
  return violations;
}

const LAYERS = new Map([
  ["domain", 0],
  ["infra", 1], ["services", 1], ["systems", 1], ["stores", 1],
  ["core", 2],
  ["control", 3], ["workflows", 3], ["server", 3],
]);

function layer(path: string): number | undefined {
  const first = normalize(path).split("/")[0];
  return first ? LAYERS.get(first) : undefined;
}

function auditLayering(files: readonly string[], root: string): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const sourceRelative = normalize(relative(root, file));
    const sourceLayer = layer(sourceRelative);
    if (sourceLayer === undefined) continue;
    for (const specifier of moduleSpecifiers(file)) {
      const target = resolveModule(file, specifier);
      if (!target) continue;
      const targetLayer = layer(normalize(relative(root, target)));
      if (targetLayer !== undefined && sourceLayer < targetLayer) {
        violations.push(`${sourceRelative}: layer inversion imports ${normalize(relative(root, target))}`);
      }
    }
  }
  return violations;
}

function auditConventions(files: readonly string[], root: string): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const path = normalize(relative(root, file));
    const name = basename(file, extname(file));
    if (!path.startsWith("temp_src/dashboard/") && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      violations.push(`${path}: filename is not kebab-case`);
    }
    if (file.endsWith(".tsx") && !path.startsWith("temp_src/dashboard/")) {
      violations.push(`${path}: TSX outside dashboard`);
    }
    visit(parse(file), (node) => {
      if (ts.isExportAssignment(node) && !node.isExportEquals) violations.push(`${path}: default export`);
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "console") {
        violations.push(`${path}: console call`);
      }
    });
  }
  return violations;
}

function auditFrontend(files: readonly string[]): string[] {
  const palette = /\b(?:bg|text|border|ring|from|to|via|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|100|200|300|400|500|600|700|800|900|950)\b/;
  const hex = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b/;
  const violations: string[] = [];
  for (const file of files) {
    visit(parse(file), (node) => {
      if (!ts.isStringLiteralLike(node) && !ts.isJsxText(node)) return;
      if (palette.test(node.text)) violations.push(`${file}: palette color class`);
      if (hex.test(node.text.replace(/#4ade80|#fbbf24/gi, ""))) violations.push(`${file}: raw hex color`);
    });
  }
  return violations;
}

function resolveFiles(name: RebuildRatchetName, repoRoot: string): RebuildRatchetAudit {
  const spec = SPECS[name];
  const roots = spec.roots.map((root) => resolve(repoRoot, root)).filter(existsSync);
  if (roots.length === 0) return { state: "planned-absent", files: [], violations: [] };
  const files = roots.flatMap((root) => walkFiles(root)).filter((file) => {
    const path = normalize(relative(repoRoot, file));
    return spec.select?.(path) ?? true;
  });
  if (files.length === 0) return { state: "planned-absent", files: [], violations: [] };
  return { state: "active", files, violations: [] };
}

export function auditRebuildRatchetArm(name: RebuildRatchetName, repoRoot: string): RebuildRatchetAudit {
  const resolved = resolveFiles(name, repoRoot);
  if (resolved.state === "planned-absent") return resolved;
  const tempRoot = resolve(repoRoot, "temp_src");
  let violations: string[];
  switch (name) {
    case "fail-loud-catch-default": violations = auditBareDefaults(resolved.files); break;
    case "nullish-literal-data-fallback": violations = auditNullish(resolved.files); break;
    case "wait-for-timeout-allowlist": violations = auditCalls(resolved.files, new Set(["waitForTimeout"]), "waitForTimeout is forbidden"); break;
    case "inline-selectors-workflows": violations = auditInlineSelectors(resolved.files); break;
    case "evaluate-named-fn": violations = auditEvaluate(resolved.files); break;
    case "import-cycles": violations = auditCycles(resolved.files); break;
    case "control-layering": violations = auditLayering(resolved.files, tempRoot); break;
    case "code-conventions": violations = auditConventions(resolved.files, repoRoot); break;
    case "frontend-tailwind-compliance": violations = auditFrontend(resolved.files); break;
  }
  return { ...resolved, violations };
}

export function rebuildRatchetFixture(name: RebuildRatchetName): RebuildRatchetFixture {
  return SPECS[name].fixture;
}
