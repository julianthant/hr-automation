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
    readonly factoryModule: string;
    readonly factoryExport: string;
    readonly exportName: string;
  };
  readonly compositionRoots?: readonly {
    readonly path: string;
    readonly factory: string;
    readonly factoryModule: string;
    readonly factoryExport: string;
    readonly bindingPath: string;
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
const ROUTE_BRIDGE_CALLS = new Set(["createProxyMiddleware", "forward", "mount", "proxy", "use"]);
const RUNTIME_CALLS = new Set(["connect", "fetch", "open", "request", "send"]);
const PROFILE_CALLS = new Set(["connectOverCDP", "launchPersistentContext", "newContext"]);
const MODULE_LOADER_CALLS = new Set(["createRequire", "require"]);
const MODULE_FACTORY_CALLS = new Set(["createRequire"]);

interface StaticResolution {
  readonly values: readonly string[];
  readonly resolved: boolean;
  readonly exactValue: boolean;
}

interface DangerousCapability {
  readonly name: string;
  readonly bridgeClasses: readonly ForbiddenBridgeClass[];
}

interface ScanEnvironment {
  readonly strings: Map<string, StaticResolution>;
  readonly capabilities: Map<string, DangerousCapability>;
  readonly moduleNamespaces: Map<string, string>;
  readonly runtimeBindings: Map<string, Readonly<Record<string, string>>>;
  readonly shadowedCalls: Set<string>;
}

interface ScanContext {
  readonly repoRoot: string;
  readonly file: string;
  readonly own: RuntimeSideContract;
}

function normalize(path: string): string {
  return path.replaceAll("\\", "/");
}

function parse(file: string): ts.SourceFile {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, kind);
}

function callName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression
    && ts.isStringLiteralLike(expression.argumentExpression)) return expression.argumentExpression.text;
  if (ts.isParenthesizedExpression(expression)) return callName(expression.expression);
  return undefined;
}

function cloneEnvironment(environment: ScanEnvironment): ScanEnvironment {
  return {
    strings: new Map(environment.strings),
    capabilities: new Map(environment.capabilities),
    moduleNamespaces: new Map(environment.moduleNamespaces),
    runtimeBindings: new Map(environment.runtimeBindings),
    shadowedCalls: new Set(environment.shadowedCalls),
  };
}

function moduleBridgeClasses(specifier: string): readonly ForbiddenBridgeClass[] {
  const bare = specifier.replace(/^node:/, "");
  if (bare === "fs" || bare === "fs/promises") return ["cross-tree-filesystem-access"];
  if (bare === "child_process") return ["cross-tree-process-invocation"];
  if (bare === "module") return ["cross-tree-module-edge"];
  if (["http", "https", "net", "tls", "undici"].includes(bare)) return ["cross-tree-runtime-bridge"];
  if (/^(?:@playwright\/test|playwright|playwright-core|puppeteer)/.test(bare)) return ["shared-browser-session"];
  if (/(?:proxy|forward)/i.test(bare)) return ["route-proxy-forward-remount"];
  return [];
}

function capabilityForName(name: string, moduleSpecifier?: string): DangerousCapability | undefined {
  const moduleClasses = moduleSpecifier ? moduleBridgeClasses(moduleSpecifier) : [];
  const classes = new Set<ForbiddenBridgeClass>();
  const accepts = (bridgeClass: ForbiddenBridgeClass): boolean =>
    moduleClasses.length === 0 || moduleClasses.includes(bridgeClass);

  if (PROCESS_CALLS.has(name) && accepts("cross-tree-process-invocation")) {
    classes.add("cross-tree-process-invocation");
  }
  if (FILESYSTEM_CALLS.has(name) && accepts("cross-tree-filesystem-access")) {
    classes.add("cross-tree-filesystem-access");
  }
  if (ROUTE_BRIDGE_CALLS.has(name) && accepts("route-proxy-forward-remount")) {
    classes.add("route-proxy-forward-remount");
  }
  if (RUNTIME_CALLS.has(name) && accepts("cross-tree-runtime-bridge")) {
    classes.add("cross-tree-runtime-bridge");
  }
  if (PROFILE_CALLS.has(name) && accepts("shared-browser-session")) {
    classes.add("shared-browser-session");
  }
  if (MODULE_LOADER_CALLS.has(name) && accepts("cross-tree-module-edge")) {
    classes.add("cross-tree-module-edge");
  }
  return classes.size > 0 ? { name, bridgeClasses: [...classes] } : undefined;
}

function capabilityFromExpression(
  expression: ts.Expression,
  environment: ScanEnvironment,
): DangerousCapability | undefined {
  if (ts.isParenthesizedExpression(expression)) return capabilityFromExpression(expression.expression, environment);
  if (ts.isIdentifier(expression)) {
    const bound = environment.capabilities.get(expression.text);
    if (bound) return bound;
    const namespaceModule = environment.moduleNamespaces.get(expression.text);
    const namespaceClasses = namespaceModule && moduleBridgeClasses(namespaceModule);
    if (namespaceClasses && namespaceClasses.length > 0) {
      return { name: `${expression.text} namespace`, bridgeClasses: namespaceClasses };
    }
    if (environment.shadowedCalls.has(expression.text)) return undefined;
    return capabilityForName(expression.text);
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const moduleSpecifier = ts.isIdentifier(expression.expression)
      ? environment.moduleNamespaces.get(expression.expression.text)
      : undefined;
    return moduleSpecifier ? capabilityForName(expression.name.text, moduleSpecifier) : undefined;
  }
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression
    && ts.isStringLiteralLike(expression.argumentExpression)) {
    const moduleSpecifier = ts.isIdentifier(expression.expression)
      ? environment.moduleNamespaces.get(expression.expression.text)
      : undefined;
    return moduleSpecifier ? capabilityForName(expression.argumentExpression.text, moduleSpecifier) : undefined;
  }
  return undefined;
}

function directCallCapability(
  expression: ts.Expression,
  environment: ScanEnvironment,
): DangerousCapability | undefined {
  const bound = capabilityFromExpression(expression, environment);
  if (bound) return bound;
  const name = callName(expression);
  if (!name || ts.isIdentifier(expression) && environment.shadowedCalls.has(name)) return undefined;
  return capabilityForName(name);
}

function staticResolution(node: ts.Node, environment: ScanEnvironment): StaticResolution {
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) {
    return { values: [node.text], resolved: true, exactValue: true };
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword
    || node.kind === ts.SyntaxKind.NullKeyword) {
    return { values: [node.getText()], resolved: true, exactValue: true };
  }
  if (ts.isIdentifier(node)) {
    return environment.strings.has(node.text)
      ? environment.strings.get(node.text) ?? { values: [], resolved: false, exactValue: false }
      : { values: [], resolved: false, exactValue: false };
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
    || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)
    || ts.isNonNullExpression(node)) {
    return staticResolution(node.expression, environment);
  }
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    const values = environment.runtimeBindings.get(node.expression.text);
    const value = values?.[node.name.text];
    return value === undefined
      ? { values: [], resolved: false, exactValue: false }
      : { values: [value], resolved: true, exactValue: true };
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticResolution(node.left, environment);
    const right = staticResolution(node.right, environment);
    return left.resolved && right.resolved && left.values.length === 1 && right.values.length === 1
      ? { values: [`${left.values[0]}${right.values[0]}`], resolved: true, exactValue: true }
      : { values: [...left.values, ...right.values], resolved: false, exactValue: false };
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    const known: string[] = [];
    for (const span of node.templateSpans) {
      const expression = staticResolution(span.expression, environment);
      known.push(...expression.values);
      if (!expression.resolved || expression.values.length !== 1) {
        return { values: known, resolved: false, exactValue: false };
      }
      value += expression.values[0] + span.literal.text;
    }
    return { values: [value], resolved: true, exactValue: true };
  }
  if (ts.isArrayLiteralExpression(node)) {
    const parts = node.elements.map((element) => staticResolution(element, environment));
    return {
      values: parts.flatMap(({ values }) => values),
      resolved: parts.every(({ resolved }) => resolved),
      exactValue: false,
    };
  }
  if (ts.isObjectLiteralExpression(node)) {
    const parts = node.properties.map((property): StaticResolution => {
      if (ts.isPropertyAssignment(property)) return staticResolution(property.initializer, environment);
      if (ts.isShorthandPropertyAssignment(property)) return staticResolution(property.name, environment);
      return { values: [], resolved: false, exactValue: false };
    });
    return {
      values: parts.flatMap(({ values }) => values),
      resolved: parts.every(({ resolved }) => resolved),
      exactValue: parts.every(({ resolved }) => resolved),
    };
  }
  if (ts.isCallExpression(node)) {
    const name = callName(node.expression);
    if (name === "join" && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = staticResolution(node.expression.expression, environment);
      const separator = node.arguments[0]
        ? staticResolution(node.arguments[0], environment)
        : { values: [","], resolved: true, exactValue: true };
      if (receiver.resolved && separator.resolved && separator.values.length === 1) {
        return { values: [receiver.values.join(separator.values[0])], resolved: true, exactValue: true };
      }
      return { values: [...receiver.values, ...separator.values], resolved: false, exactValue: false };
    }
    const parts = node.arguments.map((argument) => staticResolution(argument, environment));
    return { values: parts.flatMap(({ values }) => values), resolved: false, exactValue: false };
  }
  return { values: [], resolved: false, exactValue: false };
}

function moduleSpecifierFrom(node: ts.Expression, environment: ScanEnvironment): string | undefined {
  const expression = ts.isAwaitExpression(node) ? node.expression : node;
  if (ts.isIdentifier(expression)) return environment.moduleNamespaces.get(expression.text);
  if (!ts.isCallExpression(expression)
    || callName(expression.expression) !== "require"
      && expression.expression.kind !== ts.SyntaxKind.ImportKeyword) return undefined;
  const target = expression.arguments[0] && staticResolution(expression.arguments[0], environment);
  return target?.resolved && target.exactValue && target.values.length === 1 ? target.values[0] : undefined;
}

function registerBindingName(
  name: ts.BindingName,
  initializer: ts.Expression | undefined,
  environment: ScanEnvironment,
  allowStaticStrings: boolean,
): void {
  if (!initializer) return;
  if (ts.isIdentifier(name)) {
    const resolution = staticResolution(initializer, environment);
    if (allowStaticStrings && resolution.resolved && resolution.values.length > 0) {
      environment.strings.set(name.text, resolution);
    }

    const moduleSpecifier = moduleSpecifierFrom(initializer, environment);
    if (moduleSpecifier) environment.moduleNamespaces.set(name.text, moduleSpecifier);

    const capability = capabilityFromExpression(initializer, environment);
    if (capability) {
      environment.capabilities.set(name.text, capability);
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
    const capability = capabilityForName(imported, moduleSpecifier);
    if (capability) {
      environment.capabilities.set(element.name.text, capability);
      environment.shadowedCalls.delete(element.name.text);
    }
  }
}

function clearBindingName(name: ts.BindingName, environment: ScanEnvironment): void {
  if (ts.isIdentifier(name)) {
    environment.strings.delete(name.text);
    environment.capabilities.delete(name.text);
    environment.moduleNamespaces.delete(name.text);
    environment.runtimeBindings.delete(name.text);
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
  context: ScanContext,
): void {
  for (const statement of statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.importClause?.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      clearBindingName(bindings.name, environment);
      environment.moduleNamespaces.set(bindings.name.text, specifier);
    } else if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        clearBindingName(element.name, environment);
        if (element.isTypeOnly) continue;
        const imported = element.propertyName?.text ?? element.name.text;
        const capability = capabilityForName(imported, specifier);
        if (capability) {
          environment.capabilities.set(element.name.text, capability);
          environment.shadowedCalls.delete(element.name.text);
        }
        if (imported === "promises" && moduleBridgeClasses(specifier).includes("cross-tree-filesystem-access")) {
          environment.moduleNamespaces.set(element.name.text, specifier);
        }
        const config = context.own.runtimeConfig;
        if (config && imported === config.exportName && element.name.text === config.exportName
          && moduleResolvesTo(context.file, specifier, resolve(context.repoRoot, config.module))) {
          environment.runtimeBindings.set(element.name.text, runtimeTokenValues(context.own));
        }
      }
    }
    if (statement.importClause?.name) {
      clearBindingName(statement.importClause.name, environment);
      environment.moduleNamespaces.set(statement.importClause.name.text, specifier);
    }
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
    const before = environment.strings.size + environment.capabilities.size + environment.moduleNamespaces.size;
    for (const statement of statements) {
      if (!ts.isVariableStatement(statement)) continue;
      const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
      for (const declaration of statement.declarationList.declarations) {
        registerBindingName(declaration.name, declaration.initializer, environment, isConst);
      }
    }
    const after = environment.strings.size + environment.capabilities.size + environment.moduleNamespaces.size;
    if (after === before) break;
  }
}

function visitWithEnvironment(
  node: ts.Node,
  environment: ScanEnvironment,
  context: ScanContext,
  callback: (node: ts.Node, environment: ScanEnvironment) => void,
): void {
  callback(node, environment);

  if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) {
    const scope = cloneEnvironment(environment);
    registerImports(node.statements, scope, context);
    registerDirectDeclarations(node.statements, scope);
    for (const statement of node.statements) visitWithEnvironment(statement, scope, context, callback);
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
      if (parameter.initializer) visitWithEnvironment(parameter.initializer, scope, context, callback);
      registerBindingName(parameter.name, parameter.initializer, scope, false);
    }
    if (node.body) visitWithEnvironment(node.body, scope, context, callback);
    return;
  }

  if (ts.isCatchClause(node)) {
    const scope = cloneEnvironment(environment);
    if (node.variableDeclaration) clearBindingName(node.variableDeclaration.name, scope);
    visitWithEnvironment(node.block, scope, context, callback);
    return;
  }

  ts.forEachChild(node, (child) => visitWithEnvironment(child, environment, context, callback));
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

function runtimeTokenValues(side: RuntimeSideContract): Readonly<Record<string, string>> {
  return {
    stateRoot: side.stateRoot,
    artifactRoot: side.artifactRoot,
    backendPort: String(side.backendPort),
    frontendPort: String(side.frontendPort),
    processLockRoot: side.processLockRoot,
    browserProfileRoot: side.browserProfileRoot,
    browserSessionNamespace: side.browserSessionNamespace,
  };
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

function isTypeOnlyReference(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isTypeNode(current) || ts.isJSDoc(current)) return true;
    if (ts.isImportClause(current) && current.isTypeOnly
      || ts.isImportSpecifier(current) && current.isTypeOnly
      || ts.isExportDeclaration(current) && current.isTypeOnly
      || ts.isExportSpecifier(current) && current.isTypeOnly) return true;
    if (ts.isStatement(current) || ts.isSourceFile(current)) return false;
  }
  return false;
}

function isDeclarationIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)
      || ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent)
      || ts.isClassExpression(parent) || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent)
      || ts.isEnumDeclaration(parent) || ts.isTypeParameterDeclaration(parent)) && parent.name === node
    || ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent)
    || ts.isImportEqualsDeclaration(parent)
    || ts.isPropertyAccessExpression(parent) && parent.name === node
    || ts.isPropertyAssignment(parent) && parent.name === node
    || ts.isMethodDeclaration(parent) && parent.name === node
    || ts.isPropertyDeclaration(parent) && parent.name === node;
}

function isDirectAuditedCalleeReference(node: ts.Expression, environment: ScanEnvironment): boolean {
  let current: ts.Expression = node;
  while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
  if ((ts.isPropertyAccessExpression(current.parent) || ts.isElementAccessExpression(current.parent))
    && current.parent.expression === current
    && capabilityFromExpression(current.parent, environment)) {
    current = current.parent;
  }
  while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
  return ts.isCallExpression(current.parent) && current.parent.expression === current
    && directCallCapability(current, environment) !== undefined;
}

function escapedCapability(
  node: ts.Node,
  environment: ScanEnvironment,
): DangerousCapability | undefined {
  if (!ts.isExpression(node) || isTypeOnlyReference(node)) return undefined;
  if (ts.isIdentifier(node)) {
    if (isDeclarationIdentifier(node)) return undefined;
    const parent = node.parent;
    if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent))
      && parent.expression === node && capabilityFromExpression(parent, environment)) return undefined;
  }
  const capability = capabilityFromExpression(node, environment);
  if (!capability || isDirectAuditedCalleeReference(node, environment)) return undefined;
  return capability;
}

function boundModuleCapability(
  node: ts.Node,
  environment: ScanEnvironment,
): DangerousCapability | undefined {
  if (!ts.isVariableDeclaration(node) || !node.initializer) return undefined;
  const moduleSpecifier = moduleSpecifierFrom(node.initializer, environment);
  const bridgeClasses = moduleSpecifier && moduleBridgeClasses(moduleSpecifier);
  return bridgeClasses && bridgeClasses.length > 0
    ? { name: `${moduleSpecifier} module namespace`, bridgeClasses }
    : undefined;
}

function loadBearingArguments(name: string, node: ts.CallExpression): readonly ts.Expression[] {
  if (PROCESS_CALLS.has(name)) return node.arguments.slice(0, 2);
  if (FILESYSTEM_CALLS.has(name)) {
    return ["cp", "cpSync", "rename", "renameSync"].includes(name)
      ? node.arguments.slice(0, 2)
      : node.arguments.slice(0, 1);
  }
  if (ROUTE_BRIDGE_CALLS.has(name)) return [...node.arguments];
  if (RUNTIME_CALLS.has(name) || PROFILE_CALLS.has(name)) return node.arguments.slice(0, 1);
  return [];
}

function resourceResolution(
  name: string,
  node: ts.CallExpression,
  environment: ScanEnvironment,
): StaticResolution {
  const argumentsToResolve = loadBearingArguments(name, node);
  if (argumentsToResolve.length === 0) return { values: [], resolved: false, exactValue: false };
  const parts = argumentsToResolve.map((argument) => staticResolution(argument, environment));
  const exactOperands = PROCESS_CALLS.has(name)
    ? (parts[0]?.exactValue ?? false) && parts.slice(1).every(({ resolved }) => resolved)
    : parts.every(({ exactValue }) => exactValue);
  return {
    values: parts.flatMap(({ values }) => values),
    resolved: exactOperands && parts.every(({ resolved, values }) => resolved && values.length > 0),
    exactValue: exactOperands,
  };
}

function reportCapabilityEscape(
  output: RuntimeIsolationViolation[],
  capability: DangerousCapability,
  repoRoot: string,
  file: string,
): void {
  for (const bridgeClass of capability.bridgeClasses) {
    addViolation(output, bridgeClass, repoRoot, file, `${capability.name} capability escapes direct audited-call normal form`);
  }
}

function reportModuleReExport(
  output: RuntimeIsolationViolation[],
  node: ts.ExportDeclaration,
  repoRoot: string,
  file: string,
): void {
  if (node.isTypeOnly || !node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) return;
  const specifier = node.moduleSpecifier.text;
  if (!node.exportClause) {
    for (const bridgeClass of moduleBridgeClasses(specifier)) {
      addViolation(output, bridgeClass, repoRoot, file, `dangerous module namespace capability ${specifier} is re-exported`);
    }
    return;
  }
  if (!ts.isNamedExports(node.exportClause)) {
    for (const bridgeClass of moduleBridgeClasses(specifier)) {
      addViolation(output, bridgeClass, repoRoot, file, `dangerous module namespace capability ${specifier} is re-exported`);
    }
    return;
  }
  for (const element of node.exportClause.elements) {
    if (element.isTypeOnly) continue;
    const imported = element.propertyName?.text ?? element.name.text;
    const capability = capabilityForName(imported, specifier);
    if (capability) reportCapabilityEscape(output, capability, repoRoot, file);
  }
}

function auditDirectCall(
  output: RuntimeIsolationViolation[],
  node: ts.CallExpression,
  environment: ScanEnvironment,
  repoRoot: string,
  file: string,
  ownRoot: string,
  otherRoot: string,
  other: RuntimeSideContract,
): void {
  const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
  const capability = isDynamicImport ? undefined : directCallCapability(node.expression, environment);
  const name = isDynamicImport ? "import" : capability?.name;

  if (isDynamicImport || name === "require") {
    const target = node.arguments[0] && staticResolution(node.arguments[0], environment);
    if (!target?.resolved || !target.exactValue || target.values.length !== 1) {
      addViolation(output, "cross-tree-module-edge", repoRoot, file, `${name} target is not one exact statically resolved value`);
    } else if (moduleCrosses(file, target.values[0], ownRoot, otherRoot)) {
      addViolation(output, "cross-tree-module-edge", repoRoot, file, `${name} crosses runtime tree`);
    }
  }

  if (!capability) return;
  if (MODULE_FACTORY_CALLS.has(capability.name)) {
    addViolation(output, "cross-tree-module-edge", repoRoot, file, `${capability.name} creates an unauditable module-loader capability`);
    return;
  }
  if (capability.bridgeClasses.length === 1 && capability.bridgeClasses[0] === "cross-tree-module-edge") return;

  const target = resourceResolution(capability.name, node, environment);
  if (!target.resolved) {
    for (const bridgeClass of capability.bridgeClasses) {
      addViolation(output, bridgeClass, repoRoot, file, `${capability.name} load-bearing target is unresolved`);
    }
  }

  if (capability.bridgeClasses.includes("cross-tree-process-invocation")
    && target.values.some((value) => runtimeReferences(value, other))) {
    addViolation(output, "cross-tree-process-invocation", repoRoot, file, `${capability.name} invokes the other runtime`);
  }
  if (capability.bridgeClasses.includes("cross-tree-filesystem-access")) {
    if (target.values.some((value) => pathReference(value, other.sourceRoot))) {
      addViolation(output, "cross-tree-filesystem-access", repoRoot, file, `${capability.name} accesses the other source tree`);
    }
    if (target.values.some((value) => stateReference(value, other))) {
      addViolation(output, "cross-tree-state-access", repoRoot, file, `${capability.name} accesses the other runtime state`);
    }
    if (target.values.some((value) => profileReference(value, other))) {
      addViolation(output, "shared-browser-session", repoRoot, file, `${capability.name} accesses the other browser profile/session`);
    }
  }
  if (capability.bridgeClasses.includes("route-proxy-forward-remount")
    && target.values.some((value) => runtimeReferences(value, other))) {
    addViolation(output, "route-proxy-forward-remount", repoRoot, file, `${capability.name} forwards/remounts the other runtime`);
  }
  if (capability.bridgeClasses.includes("cross-tree-runtime-bridge")
    && target.values.some((value) => runtimeReferences(value, other))) {
    addViolation(output, "cross-tree-runtime-bridge", repoRoot, file, `${capability.name} connects to the other runtime`);
  }
  if (capability.bridgeClasses.includes("shared-browser-session")
    && target.values.some((value) => profileReference(value, other))) {
    addViolation(output, "shared-browser-session", repoRoot, file, `${capability.name} references the other browser session`);
  }
}

function scanTree(
  repoRoot: string,
  own: RuntimeSideContract,
  other: RuntimeSideContract,
): RuntimeIsolationViolation[] {
  const root = resolve(repoRoot, own.sourceRoot);
  if (!existsSync(root)) return [];
  const otherRoot = resolve(repoRoot, other.sourceRoot);
  const coexistenceActive = existsSync(otherRoot);
  const output: RuntimeIsolationViolation[] = [];

  for (const file of walkFiles(root)) {
    const source = parse(file);
    const environment: ScanEnvironment = {
      strings: new Map(),
      capabilities: new Map(),
      moduleNamespaces: new Map(),
      runtimeBindings: new Map(),
      shadowedCalls: new Set(),
    };
    const context = { repoRoot, file, own };
    visitWithEnvironment(source, environment, context, (node, scope) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
        && !(ts.isImportDeclaration(node) && node.importClause?.isTypeOnly)
        && !(ts.isExportDeclaration(node) && node.isTypeOnly)
        && moduleCrosses(file, node.moduleSpecifier.text, root, otherRoot)) {
        addViolation(output, "cross-tree-module-edge", repoRoot, file, `static module edge to ${node.moduleSpecifier.text}`);
      }
      if (coexistenceActive && ts.isExportDeclaration(node)) reportModuleReExport(output, node, repoRoot, file);

      const escaped = coexistenceActive
        ? escapedCapability(node, scope) ?? boundModuleCapability(node, scope)
        : undefined;
      if (escaped) reportCapabilityEscape(output, escaped, repoRoot, file);
      if (!ts.isCallExpression(node)) return;
      const name = callName(node.expression);
      if (coexistenceActive) auditDirectCall(output, node, scope, repoRoot, file, root, otherRoot, other);
      if (name && /(?:legacy.*(?:lift|sync|mirror|replay|adapter|bridge)|(?:lift|sync|mirror|replay|adapter|bridge).*legacy|rebuild.*(?:lift|sync|mirror|replay|adapter|bridge)|(?:lift|sync|mirror|replay|adapter|bridge).*rebuild)/i.test(name)) {
        addViolation(output, "continuous-runtime-lift", repoRoot, file, `${name} is a live compatibility bridge`);
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

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);
}

function hasExactNamedImport(
  source: ts.SourceFile,
  importerFile: string,
  expectedModuleFile: string,
  importedName: string,
  localName: string,
): boolean {
  return source.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || !moduleResolvesTo(importerFile, statement.moduleSpecifier.text, expectedModuleFile)) return false;
    const bindings = statement.importClause?.namedBindings;
    return bindings && ts.isNamedImports(bindings) && bindings.elements.some((element) =>
      !element.isTypeOnly
      && (element.propertyName?.text ?? element.name.text) === importedName
      && element.name.text === localName);
  });
}

function hasTopLevelValueDeclaration(source: ts.SourceFile, name: string): boolean {
  return source.statements.some((statement) => {
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.some((declaration) =>
        ts.isIdentifier(declaration.name) && declaration.name.text === name);
    }
    return (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement))
      && statement.name?.text === name;
  });
}

function exactBindingArgument(
  call: ts.CallExpression,
  bindingPath: string,
  bindingName: string,
): boolean {
  const match = /^(\d+)(?:\.([A-Za-z_$][\w$]*))?$/.exec(bindingPath);
  if (!match) return false;
  const index = Number(match[1]);
  if (call.arguments.length !== index + 1) return false;
  const argument = call.arguments[index];
  const property = match[2];
  if (!property) return ts.isIdentifier(argument) && argument.text === bindingName;
  if (!ts.isObjectLiteralExpression(argument) || argument.properties.length !== 1) return false;
  const member = argument.properties[0];
  return ts.isPropertyAssignment(member) && propertyName(member) === property
    && ts.isIdentifier(member.initializer) && member.initializer.text === bindingName;
}

function hasExactTopLevelCompositionCall(
  source: ts.SourceFile,
  factory: string,
  bindingPath: string,
  bindingName: string,
): boolean {
  return source.statements.some((statement) => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
    const call = statement.expression;
    return ts.isIdentifier(call.expression) && call.expression.text === factory
      && exactBindingArgument(call, bindingPath, bindingName);
  });
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
  const configFactoryFile = resolve(repoRoot, config.factoryModule);
  if (!existsSync(configFactoryFile)) {
    addViolation(output, "runtime-binding", repoRoot, configFactoryFile, "runtime config factory module is missing");
  }
  const source = parse(configFile);
  const importsFactory = hasExactNamedImport(
    source,
    configFile,
    configFactoryFile,
    config.factoryExport,
    config.factory,
  );
  const factoryIsShadowed = hasTopLevelValueDeclaration(source, config.factory);
  let bound: Record<string, string | number> | undefined;
  let boundShapeExact = false;
  let boundPropertyCount = 0;
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)
      || (statement.declarationList.flags & ts.NodeFlags.Const) === 0
      || !hasModifier(statement, ts.SyntaxKind.ExportKeyword)
      || statement.declarationList.declarations.length !== 1) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== config.exportName
        || !declaration.initializer || !ts.isCallExpression(declaration.initializer)
        || !ts.isIdentifier(declaration.initializer.expression)
        || declaration.initializer.expression.text !== config.factory
        || declaration.initializer.arguments.length !== 1) continue;
      const argument = declaration.initializer.arguments[0];
      if (!argument || !ts.isObjectLiteralExpression(argument)) continue;
      bound = {};
      boundPropertyCount = argument.properties.length;
      boundShapeExact = argument.properties.every((property) =>
        ts.isPropertyAssignment(property)
        && propertyName(property) !== undefined
        && literalValue(property.initializer) !== undefined);
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
  const exactBinding = importsFactory && !factoryIsShadowed && boundShapeExact
    && boundPropertyCount === expectedKeys.length
    && JSON.stringify(boundKeys) === JSON.stringify(expectedKeys)
    && expectedKeys.every((key) => bound?.[key] === expected[key as keyof typeof expected]);
  if (!exactBinding) {
    addViolation(output, "runtime-binding", repoRoot, configFile, `runtime config must import ${config.factory} and export one direct const call with the exact isolated values`);
  }

  for (const composition of side.compositionRoots ?? []) {
    const file = resolve(repoRoot, composition.path);
    if (!existsSync(file)) {
      addViolation(output, "runtime-binding", repoRoot, file, "composition root is missing");
      continue;
    }
    const rootSource = parse(file);
    const compositionFactoryFile = resolve(repoRoot, composition.factoryModule);
    const importsBinding = hasExactNamedImport(
      rootSource,
      file,
      configFile,
      config.exportName,
      config.exportName,
    );
    const importsFactoryBinding = hasExactNamedImport(
      rootSource,
      file,
      compositionFactoryFile,
      composition.factoryExport,
      composition.factory,
    );
    const isUnshadowed = !hasTopLevelValueDeclaration(rootSource, config.exportName)
      && !hasTopLevelValueDeclaration(rootSource, composition.factory);
    const consumesBinding = hasExactTopLevelCompositionCall(
      rootSource,
      composition.factory,
      composition.bindingPath,
      config.exportName,
    );
    if (!existsSync(compositionFactoryFile) || !importsBinding || !importsFactoryBinding
      || !isUnshadowed || !consumesBinding) {
      addViolation(output, "runtime-binding", repoRoot, file, "composition root executable call must use unshadowed exact imports in one direct top-level factory call at the declared binding path");
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
