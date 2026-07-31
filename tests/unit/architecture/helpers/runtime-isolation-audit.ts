import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { walkFiles } from "./guard-files.js";

export const SUPPORTED_FORBIDDEN_BRIDGE_CLASSES = [
  "continuous-runtime-lift",
  "cross-tree-filesystem-access",
  "cross-tree-module-edge",
  "cross-tree-process-invocation",
  "cross-tree-runtime-bridge",
  "cross-tree-state-access",
  "route-proxy-forward-remount",
  "shared-browser-session",
] as const;

export type ForbiddenBridgeClass = typeof SUPPORTED_FORBIDDEN_BRIDGE_CLASSES[number];

export interface RuntimeSideContract {
  readonly sourceRoot: string;
  readonly entrypoint: string;
  readonly commands: Readonly<Record<string, string>>;
  readonly stateRoot: string;
  readonly artifactRoot: string;
  readonly backendPort: number;
  readonly frontendPort: number;
  readonly processLockRoot: string;
  readonly browserProfileRoot: string;
  readonly browserSessionNamespace: string;
  readonly runtimeConfig?: {
    readonly module: string;
    readonly factory: string;
    readonly exportName: string;
  };
  readonly compositionRoots?: readonly {
    readonly path: string;
    readonly factory: string;
  }[];
}

export interface RuntimeIsolationContract {
  readonly phase: "pre-tree" | "active";
  readonly legacy: RuntimeSideContract;
  readonly rebuild: RuntimeSideContract;
  readonly forbiddenBridgeClasses: readonly ForbiddenBridgeClass[];
}

export interface RuntimeIsolationViolation {
  readonly bridgeClass: ForbiddenBridgeClass | "runtime-binding";
  readonly file: string;
  readonly detail: string;
}

const PROCESS_CALLS = new Set(["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"]);
const FILESYSTEM_CALLS = new Set([
  "access", "accessSync", "appendFile", "appendFileSync", "cp", "cpSync", "createReadStream",
  "createWriteStream", "existsSync", "lstat", "lstatSync", "open", "openSync", "readFile",
  "readFileSync", "readdir", "readdirSync", "rename", "renameSync", "rm", "rmSync", "stat",
  "statSync", "watch", "writeFile", "writeFileSync",
]);
const ROUTE_BRIDGE_CALLS = new Set([
  "createProxyMiddleware", "fetch", "forward", "mount", "proxy", "request", "use",
]);

function normalize(path: string): string {
  return path.replaceAll("\\", "/");
}

function parse(file: string): ts.SourceFile {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, kind);
}

function callName(expression: ts.LeftHandSideExpression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

interface ScanEnvironment {
  readonly strings: Map<string, readonly string[]>;
  readonly callAliases: Map<string, string>;
  readonly moduleNamespaces: Map<string, string>;
  readonly shadowedCalls: Set<string>;
}

const CLASSIFIED_CALLS = new Set([
  ...PROCESS_CALLS,
  ...FILESYSTEM_CALLS,
  ...ROUTE_BRIDGE_CALLS,
  "connect", "open", "send",
]);

function cloneEnvironment(environment: ScanEnvironment): ScanEnvironment {
  return {
    strings: new Map(environment.strings),
    callAliases: new Map(environment.callAliases),
    moduleNamespaces: new Map(environment.moduleNamespaces),
    shadowedCalls: new Set(environment.shadowedCalls),
  };
}

function canonicalCallName(
  expression: ts.LeftHandSideExpression,
  environment: ScanEnvironment,
): string | undefined {
  if (ts.isIdentifier(expression)) {
    return environment.callAliases.get(expression.text)
      ?? (environment.shadowedCalls.has(expression.text) ? undefined : expression.text);
  }
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression
    && ts.isStringLiteralLike(expression.argumentExpression)) return expression.argumentExpression.text;
  return undefined;
}

function moduleSpecifierFrom(
  node: ts.Expression,
  environment: ScanEnvironment,
): string | undefined {
  const expression = ts.isAwaitExpression(node) ? node.expression : node;
  if (ts.isIdentifier(expression)) return environment.moduleNamespaces.get(expression.text);
  if (!ts.isCallExpression(expression)) return undefined;
  const name = callName(expression.expression);
  if (name !== "require" && expression.expression.kind !== ts.SyntaxKind.ImportKeyword) return undefined;
  const values = expression.arguments.flatMap((argument) => staticStrings(argument, environment.strings));
  return values.length === 1 ? values[0] : undefined;
}

function registerBindingName(
  name: ts.BindingName,
  initializer: ts.Expression | undefined,
  environment: ScanEnvironment,
): void {
  if (!initializer) return;
  if (ts.isIdentifier(name)) {
    const values = staticStrings(initializer, environment.strings);
    if (values.length > 0) environment.strings.set(name.text, values);

    const moduleSpecifier = moduleSpecifierFrom(initializer, environment);
    if (moduleSpecifier) environment.moduleNamespaces.set(name.text, moduleSpecifier);

    let canonical: string | undefined;
    if (ts.isIdentifier(initializer)) {
      canonical = environment.callAliases.get(initializer.text);
    } else if (ts.isPropertyAccessExpression(initializer)) {
      canonical = initializer.name.text;
    } else if (ts.isElementAccessExpression(initializer) && initializer.argumentExpression
      && ts.isStringLiteralLike(initializer.argumentExpression)) {
      canonical = initializer.argumentExpression.text;
    }
    if (canonical && CLASSIFIED_CALLS.has(canonical)) {
      environment.callAliases.set(name.text, canonical);
      environment.shadowedCalls.delete(name.text);
    }
    return;
  }

  if (!ts.isObjectBindingPattern(name)) return;
  const moduleSpecifier = moduleSpecifierFrom(initializer, environment);
  const namespaceKnown = ts.isIdentifier(initializer)
    && environment.moduleNamespaces.has(initializer.text);
  if (!moduleSpecifier && !namespaceKnown) return;
  for (const element of name.elements) {
    if (!ts.isIdentifier(element.name)) continue;
    const imported = element.propertyName && ts.isIdentifier(element.propertyName)
      ? element.propertyName.text
      : element.name.text;
    if (CLASSIFIED_CALLS.has(imported)) {
      environment.callAliases.set(element.name.text, imported);
      environment.shadowedCalls.delete(element.name.text);
    }
  }
}

function clearBindingName(name: ts.BindingName, environment: ScanEnvironment): void {
  if (ts.isIdentifier(name)) {
    environment.strings.delete(name.text);
    environment.callAliases.delete(name.text);
    environment.moduleNamespaces.delete(name.text);
    environment.shadowedCalls.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) clearBindingName(element.name, environment);
  }
}

function registerImports(
  statements: readonly ts.Statement[],
  environment: ScanEnvironment,
): void {
  for (const statement of statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      clearBindingName(bindings.name, environment);
      environment.moduleNamespaces.set(bindings.name.text, statement.moduleSpecifier.text);
    } else if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        clearBindingName(element.name, environment);
        const imported = element.propertyName?.text ?? element.name.text;
        if (CLASSIFIED_CALLS.has(imported)) {
          environment.callAliases.set(element.name.text, imported);
          environment.shadowedCalls.delete(element.name.text);
        }
      }
    }
    if (statement.importClause?.name) clearBindingName(statement.importClause.name, environment);
  }
}

function registerDirectDeclarations(
  statements: readonly ts.Statement[],
  environment: ScanEnvironment,
): void {
  for (const statement of statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        clearBindingName(declaration.name, environment);
      }
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      clearBindingName(statement.name, environment);
    }
  }

  // Fixed point lets a function declared before a same-scope const still see
  // that lexical binding, while nested blocks keep their own shadowing map.
  for (let pass = 0; pass <= statements.length; pass++) {
    const before = environment.strings.size + environment.callAliases.size + environment.moduleNamespaces.size;
    for (const statement of statements) {
      if (!ts.isVariableStatement(statement)
        || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
      for (const declaration of statement.declarationList.declarations) {
        registerBindingName(declaration.name, declaration.initializer, environment);
      }
    }
    const after = environment.strings.size + environment.callAliases.size + environment.moduleNamespaces.size;
    if (after === before) break;
  }
}

function visitWithEnvironment(
  node: ts.Node,
  environment: ScanEnvironment,
  callback: (node: ts.Node, environment: ScanEnvironment) => void,
): void {
  callback(node, environment);

  if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) {
    const scope = cloneEnvironment(environment);
    registerImports(node.statements, scope);
    registerDirectDeclarations(node.statements, scope);
    for (const statement of node.statements) visitWithEnvironment(statement, scope, callback);
    return;
  }

  if (ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)) {
    const scope = cloneEnvironment(environment);
    for (const parameter of node.parameters) {
      clearBindingName(parameter.name, scope);
      if (parameter.initializer) visitWithEnvironment(parameter.initializer, scope, callback);
      registerBindingName(parameter.name, parameter.initializer, scope);
    }
    if (node.body) visitWithEnvironment(node.body, scope, callback);
    return;
  }

  if (ts.isCatchClause(node)) {
    const scope = cloneEnvironment(environment);
    if (node.variableDeclaration) clearBindingName(node.variableDeclaration.name, scope);
    visitWithEnvironment(node.block, scope, callback);
    return;
  }

  ts.forEachChild(node, (child) => visitWithEnvironment(child, environment, callback));
}

function staticStrings(
  node: ts.Node,
  bindings: ReadonlyMap<string, readonly string[]>,
): string[] {
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isNumericLiteral(node)) return [node.text];
  if (ts.isIdentifier(node)) return [...(bindings.get(node.text) ?? [])];
  if (ts.isParenthesizedExpression(node)) return staticStrings(node.expression, bindings);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStrings(node.left, bindings);
    const right = staticStrings(node.right, bindings);
    if (left.length === 1 && right.length === 1) return [`${left[0]}${right[0]}`];
    return [...left, ...right];
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expression = staticStrings(span.expression, bindings);
      if (expression.length !== 1) return [];
      value += expression[0] + span.literal.text;
    }
    return [value];
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.flatMap((element) => staticStrings(element, bindings));
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.flatMap((property) => {
      if (ts.isPropertyAssignment(property)) return staticStrings(property.initializer, bindings);
      if (ts.isShorthandPropertyAssignment(property)) return [...(bindings.get(property.name.text) ?? [])];
      return [];
    });
  }
  if (ts.isCallExpression(node) && ["join", "resolve"].includes(callName(node.expression) ?? "")) {
    return node.arguments.flatMap((argument) => staticStrings(argument, bindings));
  }
  return [];
}

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

function pathReference(value: string, target: string): boolean {
  const normalizedValue = normalize(value);
  const normalizedTarget = normalize(target);
  if (normalizedTarget.startsWith(".")) {
    return normalizedValue === normalizedTarget || normalizedValue.startsWith(`${normalizedTarget}/`)
      || normalizedValue.includes(`/${normalizedTarget}/`) || normalizedValue.endsWith(`/${normalizedTarget}`);
  }
  return new RegExp(`(?:^|[./])${normalizedTarget.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[/\\.]|$)`).test(normalizedValue);
}

function runtimeReferences(value: string, other: RuntimeSideContract): boolean {
  return [
    other.sourceRoot,
    other.entrypoint,
    other.stateRoot,
    other.artifactRoot,
    other.processLockRoot,
    other.browserProfileRoot,
    other.browserSessionNamespace,
    ...Object.keys(other.commands),
  ].some((target) => pathReference(value, target))
    || value === String(other.backendPort)
    || value === String(other.frontendPort)
    || value.includes(`:${other.backendPort}`)
    || value.includes(`:${other.frontendPort}`);
}

function stateReference(value: string, other: RuntimeSideContract): boolean {
  return [other.stateRoot, other.artifactRoot, other.processLockRoot]
    .some((target) => pathReference(value, target));
}

function profileReference(value: string, other: RuntimeSideContract): boolean {
  return pathReference(value, other.browserProfileRoot) || value === other.browserSessionNamespace;
}

function moduleCrosses(file: string, specifier: string, ownRoot: string, otherRoot: string): boolean {
  const otherRootName = basename(otherRoot);
  if (specifier === otherRootName || specifier.startsWith(`${otherRootName}/`)) return true;
  if (!specifier.startsWith(".")) return false;
  const target = normalize(resolve(dirname(file), specifier.replace(/\.(?:js|mjs|cjs)$/, "")));
  const other = normalize(otherRoot);
  const own = normalize(ownRoot);
  return target === other || target.startsWith(`${other}/`) && !target.startsWith(`${own}/`);
}

function moduleResolvesTo(file: string, specifier: string, expectedFile: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const raw = resolve(dirname(file), specifier);
  const candidates = [
    raw,
    raw.replace(/\.(?:js|mjs|cjs)$/, ".ts"),
    raw.replace(/\.(?:js|mjs|cjs)$/, ".tsx"),
  ].map(normalize);
  return candidates.includes(normalize(expectedFile));
}

function valuesInCall(node: ts.CallExpression | ts.NewExpression, bindings: ReadonlyMap<string, readonly string[]>): string[] {
  return (node.arguments ?? []).flatMap((argument) => staticStrings(argument, bindings));
}

function callHasOtherRuntimeHint(node: ts.CallExpression, other: RuntimeSideContract): boolean {
  const pattern = other.sourceRoot === "src" ? /legacy/i : /(?:rebuild|temp_?src)/i;
  let found = false;
  for (const argument of node.arguments) {
    visit(argument, (child) => {
      if (ts.isIdentifier(child) && pattern.test(child.text)) found = true;
      if (ts.isPropertyAccessExpression(child) && pattern.test(child.name.text)) found = true;
    });
  }
  return found;
}

function addViolation(
  output: RuntimeIsolationViolation[],
  bridgeClass: RuntimeIsolationViolation["bridgeClass"],
  repoRoot: string,
  file: string,
  detail: string,
): void {
  output.push({ bridgeClass, file: normalize(relative(repoRoot, file)), detail });
}

function scanTree(
  repoRoot: string,
  own: RuntimeSideContract,
  other: RuntimeSideContract,
): RuntimeIsolationViolation[] {
  const root = resolve(repoRoot, own.sourceRoot);
  if (!existsSync(root)) return [];
  const otherRoot = resolve(repoRoot, other.sourceRoot);
  const output: RuntimeIsolationViolation[] = [];

  for (const file of walkFiles(root)) {
    const source = parse(file);
    const environment: ScanEnvironment = {
      strings: new Map(),
      callAliases: new Map(),
      moduleNamespaces: new Map(),
      shadowedCalls: new Set(),
    };
    visitWithEnvironment(source, environment, (node, scope) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
        && moduleCrosses(file, node.moduleSpecifier.text, root, otherRoot)) {
        addViolation(output, "cross-tree-module-edge", repoRoot, file, `static module edge to ${node.moduleSpecifier.text}`);
      }
      if (!ts.isCallExpression(node)) return;
      const name = canonicalCallName(node.expression, scope);
      const values = valuesInCall(node, scope.strings);
      const otherRuntimeHint = callHasOtherRuntimeHint(node, other);
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if ((isDynamicImport || name === "require")
        && values.some((value) => moduleCrosses(file, value, root, otherRoot))) {
        addViolation(output, "cross-tree-module-edge", repoRoot, file, `${isDynamicImport ? "dynamic import" : "require"} crosses runtime tree`);
      }
      if (name && PROCESS_CALLS.has(name)
        && (otherRuntimeHint || values.some((value) => runtimeReferences(value, other)))) {
        addViolation(output, "cross-tree-process-invocation", repoRoot, file, `${name} invokes the other runtime`);
      }
      if (name && FILESYSTEM_CALLS.has(name)) {
        if (otherRuntimeHint || values.some((value) => pathReference(value, other.sourceRoot))) {
          addViolation(output, "cross-tree-filesystem-access", repoRoot, file, `${name} accesses the other source tree`);
        }
        if (otherRuntimeHint || values.some((value) => stateReference(value, other))) {
          addViolation(output, "cross-tree-state-access", repoRoot, file, `${name} accesses the other runtime state`);
        }
        if (otherRuntimeHint || values.some((value) => profileReference(value, other))) {
          addViolation(output, "shared-browser-session", repoRoot, file, `${name} accesses the other browser profile/session`);
        }
      }
      if (name && ROUTE_BRIDGE_CALLS.has(name)
        && (otherRuntimeHint || values.some((value) => runtimeReferences(value, other)))) {
        addViolation(output, "route-proxy-forward-remount", repoRoot, file, `${name} forwards/remounts the other runtime`);
      }
      if (name && ["connect", "fetch", "open", "request", "send"].includes(name)
        && (otherRuntimeHint || values.some((value) => runtimeReferences(value, other)))) {
        addViolation(output, "cross-tree-runtime-bridge", repoRoot, file, `${name} connects to the other runtime`);
      }
      if (name && /(?:legacy.*(?:lift|sync|mirror|replay|adapter|bridge)|(?:lift|sync|mirror|replay|adapter|bridge).*legacy|rebuild.*(?:lift|sync|mirror|replay|adapter|bridge)|(?:lift|sync|mirror|replay|adapter|bridge).*rebuild)/i.test(name)) {
        addViolation(output, "continuous-runtime-lift", repoRoot, file, `${name} is a live compatibility bridge`);
      }
      if ((otherRuntimeHint && name && /(?:browser|context|profile|session)/i.test(name))
        || values.some((value) => profileReference(value, other))) {
        addViolation(output, "shared-browser-session", repoRoot, file, `${name ?? "call"} references the other browser session`);
      }
    });
  }
  return output;
}

function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  if (!property.name) return undefined;
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name)) {
    return property.name.text;
  }
  return undefined;
}

function literalValue(node: ts.Expression): string | number | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  return undefined;
}

function executableRuntimeBinding(
  repoRoot: string,
  side: RuntimeSideContract,
): RuntimeIsolationViolation[] {
  const output: RuntimeIsolationViolation[] = [];
  const config = side.runtimeConfig;
  if (!config) {
    addViolation(output, "runtime-binding", repoRoot, repoRoot, "active rebuild contract has no runtimeConfig binding");
    return output;
  }
  const configFile = resolve(repoRoot, config.module);
  if (!existsSync(configFile)) {
    addViolation(output, "runtime-binding", repoRoot, configFile, "runtime config module is missing");
    return output;
  }
  const source = parse(configFile);
  let bound: Record<string, string | number> | undefined;
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== config.exportName
        || !declaration.initializer || !ts.isCallExpression(declaration.initializer)
        || callName(declaration.initializer.expression) !== config.factory) continue;
      const argument = declaration.initializer.arguments[0];
      if (!argument || !ts.isObjectLiteralExpression(argument)) continue;
      bound = {};
      for (const property of argument.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const name = propertyName(property);
        const value = literalValue(property.initializer);
        if (name && value !== undefined) bound[name] = value;
      }
    }
  }
  const expected = {
    stateRoot: side.stateRoot,
    artifactRoot: side.artifactRoot,
    backendPort: side.backendPort,
    frontendPort: side.frontendPort,
    processLockRoot: side.processLockRoot,
    browserProfileRoot: side.browserProfileRoot,
    browserSessionNamespace: side.browserSessionNamespace,
  };
  const boundKeys = Object.keys(bound ?? {}).sort();
  const expectedKeys = Object.keys(expected).sort();
  const exactBinding = JSON.stringify(boundKeys) === JSON.stringify(expectedKeys)
    && expectedKeys.every((key) => bound?.[key] === expected[key as keyof typeof expected]);
  if (!exactBinding) {
    addViolation(output, "runtime-binding", repoRoot, configFile, "defineRuntimeIsolation call does not bind the exact isolated values");
  }

  for (const composition of side.compositionRoots ?? []) {
    const file = resolve(repoRoot, composition.path);
    if (!existsSync(file)) {
      addViolation(output, "runtime-binding", repoRoot, file, "composition root is missing");
      continue;
    }
    const rootSource = parse(file);
    let importsBinding = false;
    let consumesBinding = false;
    visit(rootSource, (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
        && moduleResolvesTo(file, node.moduleSpecifier.text, configFile)) {
        const elements = node.importClause?.namedBindings;
        if (elements && ts.isNamedImports(elements)) {
          importsBinding ||= elements.elements.some((element) => element.name.text === config.exportName);
        }
      }
      if (!ts.isCallExpression(node) || callName(node.expression) !== composition.factory) return;
      for (const argument of node.arguments) {
        visit(argument, (child) => {
          if (ts.isIdentifier(child) && child.text === config.exportName) consumesBinding = true;
        });
      }
    });
    if (!importsBinding || !consumesBinding) {
      addViolation(output, "runtime-binding", repoRoot, file, "composition root must import and pass the isolation binding to an executable call");
    }
  }
  return output;
}

function validateCommands(
  repoRoot: string,
  side: RuntimeSideContract,
  scripts: Readonly<Record<string, string>>,
): RuntimeIsolationViolation[] {
  const output: RuntimeIsolationViolation[] = [];
  for (const [name, expected] of Object.entries(side.commands)) {
    if (scripts[name] !== expected) {
      addViolation(output, "runtime-binding", repoRoot, resolve(repoRoot, "package.json"), `${name} must equal ${expected}`);
    }
  }
  return output;
}

export function auditRuntimeIsolation(
  repoRoot: string,
  contract: RuntimeIsolationContract,
  scripts: Readonly<Record<string, string>>,
): RuntimeIsolationViolation[] {
  const output: RuntimeIsolationViolation[] = [];
  const configured = [...contract.forbiddenBridgeClasses].sort();
  const supported = [...SUPPORTED_FORBIDDEN_BRIDGE_CLASSES].sort();
  if (new Set(configured).size !== configured.length || JSON.stringify(configured) !== JSON.stringify(supported)) {
    addViolation(output, "runtime-binding", repoRoot, resolve(repoRoot, "config/rebuild/runtime-isolation.json"), "forbiddenBridgeClasses must register every executable detector exactly once");
  }

  const declaredRebuildCommands = Object.keys(contract.rebuild.commands).sort();
  const actualRebuildCommands = Object.keys(scripts).filter((name) => name.startsWith("rebuild:")).sort();
  if (JSON.stringify(actualRebuildCommands) !== JSON.stringify(
    contract.phase === "active" ? declaredRebuildCommands : [],
  )) {
    addViolation(output, "runtime-binding", repoRoot, resolve(repoRoot, "package.json"), "rebuild:* command set must exactly match the active isolation contract");
  }

  output.push(...validateCommands(repoRoot, contract.legacy, scripts));
  const rebuildRoot = resolve(repoRoot, contract.rebuild.sourceRoot);
  if (!existsSync(rebuildRoot)) {
    if (contract.phase !== "pre-tree") {
      addViolation(output, "runtime-binding", repoRoot, rebuildRoot, "missing temp_src requires phase=pre-tree");
    }
    for (const name of Object.keys(contract.rebuild.commands)) {
      if (scripts[name] !== undefined) {
        addViolation(output, "runtime-binding", repoRoot, resolve(repoRoot, "package.json"), `${name} exists before temp_src activation`);
      }
    }
    for (const path of [
      contract.rebuild.runtimeConfig?.module,
      ...(contract.rebuild.compositionRoots ?? []).map(({ path }) => path),
    ]) {
      if (path && existsSync(resolve(repoRoot, path))) {
        addViolation(output, "runtime-binding", repoRoot, resolve(repoRoot, path), "rebuild runtime binding exists before source activation");
      }
    }
  } else {
    if (contract.phase !== "active") {
      addViolation(output, "runtime-binding", repoRoot, rebuildRoot, "active temp_src requires phase=active");
    }
    output.push(...validateCommands(repoRoot, contract.rebuild, scripts));
    output.push(...executableRuntimeBinding(repoRoot, contract.rebuild));
  }

  output.push(...scanTree(repoRoot, contract.legacy, contract.rebuild));
  output.push(...scanTree(repoRoot, contract.rebuild, contract.legacy));
  return output;
}
