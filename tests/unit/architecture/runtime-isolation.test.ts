import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import isolationJson from "../../../config/rebuild/runtime-isolation.json" with { type: "json" };
import preservationJson from "../../../config/rebuild/legacy-preservation.json" with { type: "json" };
import { REPO_ROOT } from "./helpers/guard-files.js";
import {
  auditRuntimeIsolation,
  SUPPORTED_FORBIDDEN_BRIDGE_CLASSES,
  SUPPORTED_MODULE_FAMILIES,
  type ForbiddenBridgeClass,
  type RuntimeIsolationContract,
  type RuntimeIsolationPreservationContract,
} from "./helpers/runtime-isolation-audit.js";

const isolation = isolationJson as RuntimeIsolationContract;
const preservation = preservationJson as RuntimeIsolationPreservationContract;
const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

function write(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function preserveFiles(
  root: string,
  paths: readonly string[],
): RuntimeIsolationPreservationContract {
  return {
    schemaVersion: 1,
    baselineCommit: preservation.baselineCommit,
    runtimeIsolation: {
      sourceRoot: "src",
      files: Object.fromEntries(paths.map((path) => [path, sha256(join(root, path))])),
    },
  };
}

function activeContract(): RuntimeIsolationContract {
  return { ...isolation, phase: "active" };
}

function activeScripts(contract: RuntimeIsolationContract): Record<string, string> {
  return { ...contract.legacy.commands, ...contract.rebuild.commands };
}

function seedValidActiveRuntime(root: string, contract: RuntimeIsolationContract): void {
  write(root, "src/cli.ts", "export const legacy = true;\n");
  write(
    root,
    contract.rebuild.runtimeConfig?.factoryModule ?? "missing-factory",
    "export function defineRuntimeIsolation<T>(value: T): T { return value; }\n",
  );
  write(
    root,
    contract.rebuild.runtimeConfig?.module ?? "missing",
    `import { defineRuntimeIsolation } from "./define-runtime-isolation.js";
export const rebuildRuntimeIsolation = defineRuntimeIsolation({
  stateRoot: ".tracker-rebuild",
  artifactRoot: ".tracker-rebuild/artifacts",
  backendPort: 3938,
  frontendPort: 5174,
  processLockRoot: ".tracker-rebuild/locks",
  browserProfileRoot: ".auth-rebuild",
  browserSessionNamespace: "hrauto-rebuild",
});
`,
  );
  write(
    root,
    "temp_src/core/runtime-composition.ts",
    `export function startRebuildRuntime(_value: unknown): void {}
export function composeRebuildRuntime(_value: unknown): void {}
`,
  );
  write(
    root,
    "temp_src/cli.ts",
    `import { rebuildRuntimeIsolation } from "./config/runtime-isolation.js";
import { startRebuildRuntime } from "./core/runtime-composition.js";
startRebuildRuntime({ isolation: rebuildRuntimeIsolation });
`,
  );
  write(
    root,
    "temp_src/core/workflow-registry.ts",
    `import { rebuildRuntimeIsolation } from "../config/runtime-isolation.js";
import { composeRebuildRuntime } from "./runtime-composition.js";
composeRebuildRuntime({ isolation: rebuildRuntimeIsolation });
`,
  );
}

function withActiveFixture(
  callback: (root: string, contract: RuntimeIsolationContract, scripts: Record<string, string>) => void,
): void {
  const root = join(tmpdir(), `hrauto-isolation-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const contract = activeContract();
  try {
    seedValidActiveRuntime(root, contract);
    callback(root, contract, activeScripts(contract));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function bridgeClasses(root: string, contract: RuntimeIsolationContract, scripts: Record<string, string>): ForbiddenBridgeClass[] {
  return auditRuntimeIsolation(root, contract, scripts)
    .map(({ bridgeClass }) => bridgeClass)
    .filter((bridgeClass): bridgeClass is ForbiddenBridgeClass => bridgeClass !== "runtime-binding");
}

describe("D88 runtime isolation", () => {
  it("pins distinct exact runtime resources and consumes every forbidden bridge class", () => {
    assert.equal(isolation.schemaVersion, 2);
    assert.deepEqual(isolation.legacy, {
      sourceRoot: "src",
      entrypoint: "src/cli.ts",
      commands: {
        dashboard: "tsx --env-file=.env src/cli.ts dashboard --capture-ngrok",
        "dashboard:prod": "tsx --env-file=.env src/cli.ts dashboard --prod",
        "dashboard:watch": "tsx watch --env-file=.env src/cli.ts dashboard --capture-ngrok",
      },
      stateRoot: ".tracker",
      artifactRoot: ".tracker",
      backendPort: 3838,
      frontendPort: 5173,
      processLockRoot: ".tracker/daemons",
      browserProfileRoot: ".auth",
      browserSessionNamespace: "hrauto-legacy",
    });
    assert.deepEqual(isolation.rebuild, {
      sourceRoot: "temp_src",
      entrypoint: "temp_src/cli.ts",
      commands: {
        "rebuild:dashboard": "tsx --env-file=.env temp_src/cli.ts dashboard",
        "rebuild:dashboard:prod": "tsx --env-file=.env temp_src/cli.ts dashboard --prod",
        "rebuild:cli": "tsx --env-file=.env temp_src/cli.ts",
      },
      stateRoot: ".tracker-rebuild",
      artifactRoot: ".tracker-rebuild/artifacts",
      backendPort: 3938,
      frontendPort: 5174,
      processLockRoot: ".tracker-rebuild/locks",
      browserProfileRoot: ".auth-rebuild",
      browserSessionNamespace: "hrauto-rebuild",
      runtimeConfig: {
        module: "temp_src/config/runtime-isolation.ts",
        factory: "defineRuntimeIsolation",
        factoryModule: "temp_src/config/define-runtime-isolation.ts",
        factoryExport: "defineRuntimeIsolation",
        exportName: "rebuildRuntimeIsolation",
      },
      compositionRoots: [
        {
          path: "temp_src/cli.ts",
          factory: "startRebuildRuntime",
          factoryModule: "temp_src/core/runtime-composition.ts",
          factoryExport: "startRebuildRuntime",
          bindingPath: "0.isolation",
        },
        {
          path: "temp_src/core/workflow-registry.ts",
          factory: "composeRebuildRuntime",
          factoryModule: "temp_src/core/runtime-composition.ts",
          factoryExport: "composeRebuildRuntime",
          bindingPath: "0.isolation",
        },
      ],
    });
    assert.deepEqual(
      [...isolation.forbiddenBridgeClasses].sort(),
      [...SUPPORTED_FORBIDDEN_BRIDGE_CLASSES].sort(),
    );
    assert.deepEqual(
      isolation.moduleFamilies,
      [
        {
          family: "filesystem",
          specifiers: ["fs", "fs/promises", "node:fs", "node:fs/promises"],
          bridgeClasses: ["cross-tree-filesystem-access"],
        },
        {
          family: "network-route",
          specifiers: ["dgram", "http", "http2", "https", "net", "node:dgram", "node:http", "node:http2", "node:https", "node:net", "node:tls", "tls", "undici", "ws"],
          bridgeClasses: ["cross-tree-runtime-bridge", "route-proxy-forward-remount"],
        },
        {
          family: "process-execution",
          specifiers: ["child_process", "cluster", "node:child_process", "node:cluster", "node:vm", "node:worker_threads", "vm", "worker_threads"],
          bridgeClasses: ["cross-tree-process-invocation"],
        },
        {
          family: "module-loader",
          specifiers: ["module", "node:module"],
          bridgeClasses: ["cross-tree-module-edge"],
        },
        {
          family: "browser-profile",
          specifiers: ["@playwright/test", "playwright", "playwright-core", "puppeteer", "puppeteer-core"],
          bridgeClasses: ["shared-browser-session"],
        },
      ],
    );
    assert.deepEqual(
      isolation.moduleFamilies.map(({ family }) => family).sort(),
      [...SUPPORTED_MODULE_FAMILIES].sort(),
    );

    for (const key of ["stateRoot", "artifactRoot", "processLockRoot", "browserProfileRoot", "browserSessionNamespace"] as const) {
      assert.notEqual(isolation.legacy[key], isolation.rebuild[key], `${key} must differ`);
    }
    assert.notEqual(isolation.legacy.backendPort, isolation.rebuild.backendPort);
    assert.notEqual(isolation.legacy.frontendPort, isolation.rebuild.frontendPort);
  });

  it("audits the real pre-tree checkout and exact legacy commands", () => {
    assert.deepEqual(auditRuntimeIsolation(REPO_ROOT, isolation, packageJson.scripts, preservation), []);
  });

  it("activates beside the actual preserved legacy tree without imposing rebuild normal form", () => {
    withActiveFixture((root, contract, scripts) => {
      rmSync(join(root, contract.legacy.sourceRoot), { recursive: true, force: true });
      cpSync(join(REPO_ROOT, contract.legacy.sourceRoot), join(root, contract.legacy.sourceRoot), {
        recursive: true,
      });

      assert.deepEqual(auditRuntimeIsolation(root, contract, scripts, preservation), []);

      write(
        root,
        "src/rebuild-crossing-activation.ts",
        `import "../temp_src/cli.js";
import { readFileSync } from "node:fs";
import { get } from "node:http";
import { launch } from "puppeteer";
readFileSync(".tracker-rebuild/state.json");
get("http://127.0.0.1:3938/api/entries");
launch({ userDataDir: ".auth-rebuild" });
`,
      );
      const preservedCrossing = {
        ...preservation,
        runtimeIsolation: {
          ...preservation.runtimeIsolation,
          files: {
            ...preservation.runtimeIsolation.files,
            "src/rebuild-crossing-activation.ts": sha256(join(root, "src/rebuild-crossing-activation.ts")),
          },
        },
      } satisfies RuntimeIsolationPreservationContract;
      const violations = auditRuntimeIsolation(root, contract, scripts, preservedCrossing);
      for (const expected of [
        "cross-tree-module-edge",
        "cross-tree-state-access",
        "cross-tree-runtime-bridge",
        "route-proxy-forward-remount",
        "shared-browser-session",
      ] satisfies readonly ForbiddenBridgeClass[]) {
        assert.ok(violations.some(({ bridgeClass, file }) =>
          bridgeClass === expected && file === "src/rebuild-crossing-activation.ts"), expected);
      }
    });
  });

  it("uses preservation mode only for exact path-and-hash matches", () => {
    withActiveFixture((root, contract, scripts) => {
      const exact = preserveFiles(root, ["src/cli.ts"]);
      assert.deepEqual(auditRuntimeIsolation(root, contract, scripts, exact), []);

      const original = readFileSync(join(root, "src/cli.ts"), "utf8");
      write(
        root,
        "src/cli.ts",
        `${original}import { truncateSync as activationTruncate } from "node:fs";
declare const activationTarget: string;
activationTruncate(activationTarget);
`,
      );
      const modified = auditRuntimeIsolation(root, contract, scripts, exact);
      assert.ok(modified.some(({ bridgeClass, detail }) =>
        bridgeClass === "runtime-binding" && detail.includes("hash is missing or stale")));
      assert.ok(modified.some(({ bridgeClass, file, detail }) =>
        bridgeClass === "cross-tree-filesystem-access"
        && file === "src/cli.ts"
        && detail.includes("truncateSync load-bearing target is unresolved")));

      seedValidActiveRuntime(root, contract);
      write(
        root,
        "src/dynamic-rebuild-escape.ts",
        `import { unlinkSync } from "node:fs";
declare const target: string;
declare const method: string;
unlinkSync(target);
require(process.env.REBUILD_MODULE);
globalThis[method](process.env.REBUILD_URL);
`,
      );
      const added = auditRuntimeIsolation(root, contract, scripts, exact);
      assert.ok(added.some(({ bridgeClass, file, detail }) =>
        bridgeClass === "cross-tree-filesystem-access"
        && file === "src/dynamic-rebuild-escape.ts"
        && detail.includes("unresolved")));
      assert.ok(added.some(({ bridgeClass, file, detail }) =>
        bridgeClass === "cross-tree-module-edge"
        && file === "src/dynamic-rebuild-escape.ts"
        && detail.includes("not one exact statically resolved value")));
      assert.ok(added.some(({ bridgeClass, file, detail }) =>
        bridgeClass === "cross-tree-runtime-bridge"
        && file === "src/dynamic-rebuild-escape.ts"
        && detail.includes("computed runtime-global")));
    });
  });

  it("rejects missing, duplicate, or open module-family catalog entries", () => {
    const missing = { ...isolation, moduleFamilies: isolation.moduleFamilies.slice(1) };
    assert.ok(auditRuntimeIsolation(REPO_ROOT, missing, packageJson.scripts)
      .some(({ bridgeClass, detail }) => bridgeClass === "runtime-binding" && detail.includes("moduleFamilies")));

    const duplicate = {
      ...isolation,
      moduleFamilies: isolation.moduleFamilies.map((family, index) => index === 1
        ? { ...family, specifiers: [...family.specifiers, "node:fs"] }
        : family),
    };
    assert.ok(auditRuntimeIsolation(REPO_ROOT, duplicate, packageJson.scripts)
      .some(({ bridgeClass, detail }) => bridgeClass === "runtime-binding" && detail.includes("moduleFamilies")));
  });

  it("accepts only executable exact runtime config consumed by every composition root", () => {
    withActiveFixture((root, contract, scripts) => {
      assert.deepEqual(auditRuntimeIsolation(root, contract, scripts), []);

      scripts["rebuild:cli"] += " --proxy-legacy";
      assert.ok(auditRuntimeIsolation(root, contract, scripts).some(({ bridgeClass }) => bridgeClass === "runtime-binding"));
      scripts["rebuild:cli"] = contract.rebuild.commands["rebuild:cli"] ?? "";
      scripts["rebuild:legacy-proxy"] = "tsx temp_src/proxy.ts";
      assert.ok(auditRuntimeIsolation(root, contract, scripts).some(({ detail }) => detail.includes("command set")));
      delete scripts["rebuild:legacy-proxy"];

      write(root, "temp_src/config/runtime-isolation.ts", "export const rebuildRuntimeIsolation = { backendPort: 3838 };\n");
      assert.ok(auditRuntimeIsolation(root, contract, scripts).some(({ detail }) => detail.includes("defineRuntimeIsolation")));

      seedValidActiveRuntime(root, contract);
      write(
        root,
        "temp_src/core/workflow-registry.ts",
        "import { rebuildRuntimeIsolation } from \"../config/runtime-isolation.js\";\nexport const declaredOnly = rebuildRuntimeIsolation;\n",
      );
      assert.ok(auditRuntimeIsolation(root, contract, scripts).some(({ detail }) => detail.includes("executable call")));

      seedValidActiveRuntime(root, contract);
      write(
        root,
        "temp_src/core/workflow-registry.ts",
        `import { rebuildRuntimeIsolation } from "../config/runtime-isolation.js";
import { composeRebuildRuntime } from "./runtime-composition.js";
export function startLater(): void { composeRebuildRuntime({ isolation: rebuildRuntimeIsolation }); }
`,
      );
      assert.ok(auditRuntimeIsolation(root, contract, scripts).some(({ detail }) => detail.includes("top-level")));

      seedValidActiveRuntime(root, contract);
      write(
        root,
        "temp_src/core/workflow-registry.ts",
        `import { rebuildRuntimeIsolation } from "../config/runtime-isolation.js";
import { composeRebuildRuntime } from "./runtime-composition.js";
declare const replacement: unknown;
((rebuildRuntimeIsolation: unknown) => composeRebuildRuntime({ isolation: rebuildRuntimeIsolation }))(replacement);
`,
      );
      assert.ok(auditRuntimeIsolation(root, contract, scripts).some(({ detail }) => detail.includes("top-level")));

      seedValidActiveRuntime(root, contract);
      write(
        root,
        "temp_src/core/workflow-registry.ts",
        `import { rebuildRuntimeIsolation } from "../config/runtime-isolation.js";
import { composeRebuildRuntime } from "./runtime-composition.js";
composeRebuildRuntime({ unrelated: rebuildRuntimeIsolation });
`,
      );
      assert.ok(auditRuntimeIsolation(root, contract, scripts).some(({ detail }) => detail.includes("binding path")));

      seedValidActiveRuntime(root, contract);
      write(
        root,
        "temp_src/core/workflow-registry.ts",
        `import { rebuildRuntimeIsolation } from "../config/runtime-isolation.js";
import { composeRebuildRuntime as compose } from "./runtime-composition.js";
compose({ isolation: rebuildRuntimeIsolation });
`,
      );
      assert.ok(auditRuntimeIsolation(root, contract, scripts).some(({ detail }) => detail.includes("exact imports")));

      seedValidActiveRuntime(root, contract);
      write(
        root,
        "temp_src/config/runtime-isolation.ts",
        `function defineRuntimeIsolation<T>(value: T): T { return value; }
export const rebuildRuntimeIsolation = defineRuntimeIsolation({
  stateRoot: ".tracker-rebuild",
  artifactRoot: ".tracker-rebuild/artifacts",
  backendPort: 3938,
  frontendPort: 5174,
  processLockRoot: ".tracker-rebuild/locks",
  browserProfileRoot: ".auth-rebuild",
  browserSessionNamespace: "hrauto-rebuild",
});
`,
      );
      assert.ok(auditRuntimeIsolation(root, contract, scripts).some(({ detail }) => detail.includes("must import defineRuntimeIsolation")));
    });
  });

  it("detects static imports, computed dynamic imports, and require calls in both runtime directions", () => {
    withActiveFixture((root, contract, scripts) => {
      for (const [path, content] of [
        ["temp_src/core/static.ts", "import \"../../src/cli.js\";\n"],
        ["temp_src/core/bare.ts", "import \"src/cli.js\";\n"],
        ["temp_src/core/dynamic.ts", "const target = \"../../src/cli.js\"; export const load = () => import(target);\n"],
        ["temp_src/core/nested-template.ts", "export function load() { const root = \"../../src\"; const target = `${root}/cli.js`; return import(target); }\n"],
        ["temp_src/core/required.ts", "const target = \"../../src/cli.js\"; export const load = () => require(target);\n"],
        ["src/rebuild-edge.ts", "export const load = () => import(\"../temp_src/cli.js\");\n"],
      ] as const) {
        write(root, path, content);
        assert.ok(bridgeClasses(root, contract, scripts).includes("cross-tree-module-edge"), path);
        rmSync(join(root, path));
      }
    });
  });

  it("rejects nested lexical dynamic imports and renamed filesystem bindings", () => {
    withActiveFixture((root, contract, scripts) => {
      write(
        root,
        "temp_src/core/nested-dynamic.ts",
        "function load() { const target = \"../../src/cli.js\"; return import(target); }\nexport { load };\n",
      );
      write(
        root,
        "temp_src/core/renamed-fs.ts",
        "import { readFileSync as load } from \"node:fs\";\nload(\".tracker/state.json\");\n",
      );
      const violations = auditRuntimeIsolation(root, contract, scripts);
      assert.ok(violations.some(({ bridgeClass, file }) =>
        bridgeClass === "cross-tree-module-edge" && file.endsWith("nested-dynamic.ts")));
      assert.ok(violations.some(({ bridgeClass, file }) =>
        bridgeClass === "cross-tree-state-access" && file.endsWith("renamed-fs.ts")));
    });
  });

  it("fails closed for unresolved or computed module-loader targets", () => {
    withActiveFixture((root, contract, scripts) => {
      const cases: readonly [string, string][] = [
        ["let-target.ts", "let target = \"../../src/cli.js\"; import(target);\n"],
        ["let-reassigned.ts", "let target; target = \"../../src/cli.js\"; require(target);\n"],
        ["array-join.ts", "import([\"..\", \"..\", \"src\", \"cli.js\"].join(\"/\"));\n"],
        ["path-join.ts", "declare const path: { join(...parts: string[]): string }; import(path.join(\"..\", \"..\", \"src\", \"cli.js\"));\n"],
        ["conditional.ts", "declare const chooseLegacy: boolean; const target = chooseLegacy ? \"../../src/cli.js\" : \"./local.js\"; import(target);\n"],
        ["multiple-targets.ts", "const target = [\"./local.js\", \"../../src/cli.js\"]; import(target as unknown as string);\n"],
        ["loader-alias.ts", "const load = require; load(\"../../src/cli.js\");\n"],
        ["loader-factory.ts", "import { createRequire } from \"node:module\"; const load = createRequire(import.meta.url); load(\"../../src/cli.js\");\n"],
      ];
      for (const [name, content] of cases) {
        const path = `temp_src/core/${name}`;
        write(root, path, content);
        const violations = auditRuntimeIsolation(root, contract, scripts);
        assert.ok(violations.some(({ bridgeClass, file }) =>
          bridgeClass === "cross-tree-module-edge" && file.endsWith(name)), name);
        rmSync(join(root, path));
      }

      write(
        root,
        "temp_src/core/safe-modules.ts",
        "const local = \"./local.js\"; import(local); require(\"node:fs\");\n",
      );
      assert.deepEqual(auditRuntimeIsolation(root, contract, scripts), []);
    });
  });

  it("rejects every non-call escape of imported or namespace bridge capabilities", () => {
    withActiveFixture((root, contract, scripts) => {
      const cases: readonly [string, string, ForbiddenBridgeClass][] = [
        ["let-alias.ts", "import { readFileSync } from \"node:fs\"; let load = readFileSync; load(\".tracker/state.json\");\n", "cross-tree-filesystem-access"],
        ["reassignment.ts", "import { readFileSync } from \"node:fs\"; let load: unknown; load = readFileSync;\n", "cross-tree-filesystem-access"],
        ["bind.ts", "import { readFileSync } from \"node:fs\"; const load = readFileSync.bind(null);\n", "cross-tree-filesystem-access"],
        ["call.ts", "import { readFileSync } from \"node:fs\"; readFileSync.call(null, \".tracker/state.json\");\n", "cross-tree-filesystem-access"],
        ["apply.ts", "import { readFileSync } from \"node:fs\"; readFileSync.apply(null, [\".tracker/state.json\"]);\n", "cross-tree-filesystem-access"],
        ["object-call.ts", "import { readFileSync } from \"node:fs\"; ({ load: readFileSync }).load(\".tracker/state.json\");\n", "cross-tree-filesystem-access"],
        ["array-wrapper.ts", "import { readFileSync } from \"node:fs\"; const readers = [readFileSync];\n", "cross-tree-filesystem-access"],
        ["class-wrapper.ts", "import { readFileSync } from \"node:fs\"; class Reader { readonly load = readFileSync; }\n", "cross-tree-filesystem-access"],
        ["argument.ts", "import { readFileSync } from \"node:fs\"; declare function register(value: unknown): void; register(readFileSync);\n", "cross-tree-filesystem-access"],
        ["return.ts", "import { readFileSync } from \"node:fs\"; export function reader() { return readFileSync; }\n", "cross-tree-filesystem-access"],
        ["local-reexport.ts", "import { readFileSync } from \"node:fs\"; export { readFileSync };\n", "cross-tree-filesystem-access"],
        ["direct-reexport.ts", "export { readFileSync } from \"node:fs\";\n", "cross-tree-filesystem-access"],
        ["namespace-reexport.ts", "export * as fs from \"node:fs\";\n", "cross-tree-filesystem-access"],
        ["namespace-member.ts", "import * as fs from \"node:fs\"; const load = fs.readFileSync;\n", "cross-tree-filesystem-access"],
        ["namespace-argument.ts", "import * as fs from \"node:fs\"; declare function register(value: unknown): void; register(fs);\n", "cross-tree-filesystem-access"],
        ["namespace-computed.ts", "import * as fs from \"node:fs\"; const method = \"readFileSync\"; fs[method](\".tracker-rebuild/state.json\");\n", "cross-tree-filesystem-access"],
        ["require-namespace.ts", "const fs = require(\"node:fs\"); fs.readFileSync(\".tracker-rebuild/state.json\");\n", "cross-tree-filesystem-access"],
        ["dynamic-namespace.ts", "const fs = await import(\"node:fs\"); fs.readFileSync(\".tracker-rebuild/state.json\");\n", "cross-tree-filesystem-access"],
        ["family-named-escape.ts", "import { unlinkSync } from \"node:fs\"; const erase = unlinkSync;\n", "cross-tree-filesystem-access"],
        ["family-default-escape.ts", "import browserRuntime from \"puppeteer\"; declare function register(value: unknown): void; register(browserRuntime);\n", "shared-browser-session"],
        ["process-return.ts", "import { spawn } from \"node:child_process\"; export const getSpawn = () => spawn;\n", "cross-tree-process-invocation"],
      ];
      for (const [name, content, expected] of cases) {
        const path = `temp_src/core/${name}`;
        write(root, path, content);
        const violations = auditRuntimeIsolation(root, contract, scripts);
        assert.ok(violations.some(({ bridgeClass, file, detail }) =>
          bridgeClass === expected && file.endsWith(name) && detail.includes("capability")), name);
        rmSync(join(root, path));
      }
    });
  });

  it("fails closed at unresolved sinks and accepts exact current-runtime resources", () => {
    withActiveFixture((root, contract, scripts) => {
      const unresolved: readonly [string, string, ForbiddenBridgeClass][] = [
        ["unknown-fs.ts", "import { readFileSync } from \"node:fs\"; declare const path: string; readFileSync(path);\n", "cross-tree-filesystem-access"],
        ["multiple-fs.ts", "import { readFileSync } from \"node:fs\"; const paths = [\".tracker-rebuild/state.json\", \"safe.txt\"]; readFileSync(paths as unknown as string);\n", "cross-tree-filesystem-access"],
        ["unknown-process.ts", "import { spawn } from \"node:child_process\"; declare const command: string; spawn(command);\n", "cross-tree-process-invocation"],
        ["unknown-runtime.ts", "declare const url: string; fetch(url);\n", "cross-tree-runtime-bridge"],
        ["unknown-route.ts", "declare const app: { use(...args: unknown[]): void }; declare const route: string; app.use(route);\n", "route-proxy-forward-remount"],
        ["unknown-profile.ts", "declare const browser: { launchPersistentContext(path: string): void }; declare const profile: string; browser.launchPersistentContext(profile);\n", "shared-browser-session"],
      ];
      for (const [name, content, expected] of unresolved) {
        const path = `temp_src/core/${name}`;
        write(root, path, content);
        const violations = auditRuntimeIsolation(root, contract, scripts);
        assert.ok(violations.some(({ bridgeClass, file, detail }) =>
          bridgeClass === expected && file.endsWith(name) && detail.includes("unresolved")), name);
        rmSync(join(root, path));
      }

      write(
        root,
        "temp_src/core/approved-resources.ts",
        `import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { rebuildRuntimeIsolation } from "../config/runtime-isolation.js";
declare const app: { use(...args: string[]): void };
declare const browser: { launchPersistentContext(path: string): void };
readFileSync(rebuildRuntimeIsolation.stateRoot);
spawn("tsx", ["temp_src/cli.ts"]);
fetch(\`http://127.0.0.1:\${rebuildRuntimeIsolation.backendPort}/api/entries\`);
app.use("/rebuild", "http://127.0.0.1:3938");
browser.launchPersistentContext(rebuildRuntimeIsolation.browserProfileRoot);
`,
      );
      assert.deepEqual(auditRuntimeIsolation(root, contract, scripts), []);
    });
  });

  it("classifies every runtime module-family binding and audits calls plus constructors", () => {
    withActiveFixture((root, contract, scripts) => {
      const cases: readonly [string, string, ForbiddenBridgeClass][] = [
        ["unlink.ts", "import { unlinkSync } from \"node:fs\"; unlinkSync(\".tracker/state.json\");\n", "cross-tree-state-access"],
        ["fs-default.ts", "import filesystem from \"node:fs\"; filesystem.truncateSync(\".tracker/state.json\");\n", "cross-tree-state-access"],
        ["http-get.ts", "import { get } from \"node:http\"; get(\"http://127.0.0.1:3838/api/entries\");\n", "route-proxy-forward-remount"],
        ["https-namespace.ts", "import * as transport from \"node:https\"; transport.get(\"http://127.0.0.1:3838/api/entries\");\n", "cross-tree-runtime-bridge"],
        ["puppeteer-launch.ts", "import { launch } from \"puppeteer\"; launch({ userDataDir: \".auth\" });\n", "shared-browser-session"],
        ["puppeteer-default.ts", "import browserRuntime from \"puppeteer-core\"; browserRuntime.launch({ userDataDir: \".auth\" });\n", "shared-browser-session"],
        ["worker.ts", "import { Worker } from \"node:worker_threads\"; new Worker(\"../../src/cli.js\");\n", "cross-tree-process-invocation"],
        ["module-loader-member.ts", "import { load as loadModule } from \"node:module\"; loadModule(\"../../src/cli.js\");\n", "cross-tree-module-edge"],
        ["websocket.ts", "import { WebSocket as Socket } from \"ws\"; new Socket(\"http://127.0.0.1:3838/events\");\n", "cross-tree-runtime-bridge"],
      ];
      for (const [name, content, expected] of cases) {
        const path = `temp_src/core/${name}`;
        write(root, path, content);
        const violations = auditRuntimeIsolation(root, contract, scripts);
        assert.ok(violations.some(({ bridgeClass, file }) =>
          bridgeClass === expected && file.endsWith(name)), name);
        rmSync(join(root, path));
      }

      write(
        root,
        "temp_src/core/approved-module-families.ts",
        `import { unlinkSync as remove } from "node:fs";
import transport from "node:http";
import browserRuntime from "puppeteer-core";
import { Worker as Thread } from "node:worker_threads";
import { rebuildRuntimeIsolation } from "../config/runtime-isolation.js";
remove(rebuildRuntimeIsolation.stateRoot + "/state.json");
transport.get(\`http://127.0.0.1:\${rebuildRuntimeIsolation.backendPort}/api/entries\`);
browserRuntime.launch({ userDataDir: rebuildRuntimeIsolation.browserProfileRoot });
new Thread("temp_src/cli.ts");
`,
      );
      assert.deepEqual(auditRuntimeIsolation(root, contract, scripts), []);
    });
  });

  it("rejects computed runtime-global capability selection while allowing literal members", () => {
    withActiveFixture((root, contract, scripts) => {
      for (const [name, content] of [
        ["global-this.ts", "const m = \"fetch\"; globalThis[m](\"http://127.0.0.1:3838/api/entries\");\n"],
        ["window.ts", "declare const window: Record<string, (value: string) => void>; declare const method: string; window[method](\"http://127.0.0.1:3838\");\n"],
      ] as const) {
        const path = `temp_src/core/${name}`;
        write(root, path, content);
        const violations = auditRuntimeIsolation(root, contract, scripts);
        assert.ok(violations.some(({ bridgeClass, file, detail }) =>
          bridgeClass === "cross-tree-runtime-bridge"
          && file.endsWith(name)
          && detail.includes("computed runtime-global")), name);
        rmSync(join(root, path));
      }

      write(
        root,
        "temp_src/core/literal-global.ts",
        "globalThis[\"fetch\"](\"http://127.0.0.1:3938/api/entries\");\n",
      );
      assert.deepEqual(auditRuntimeIsolation(root, contract, scripts), []);
    });
  });

  it("detects direct invocation, filesystem/state access, runtime calls, proxy/forward/remount, lift, and shared sessions", () => {
    withActiveFixture((root, contract, scripts) => {
      const cases: readonly [string, string, ForbiddenBridgeClass][] = [
        ["process.ts", "spawn(\"node\", [\"src/cli.ts\"]);\n", "cross-tree-process-invocation"],
        ["process-env.ts", "spawn(process.env.LEGACY_COMMAND);\n", "cross-tree-process-invocation"],
        ["files.ts", "readFileSync(\"src/tracker/state.ts\");\n", "cross-tree-filesystem-access"],
        ["files-namespace-destructure.ts", "import * as fs from \"node:fs\"; const { readFileSync: load } = fs; load(\".tracker/state.json\");\n", "cross-tree-state-access"],
        ["files-require-destructure.ts", "const { readFileSync: load } = require(\"node:fs\"); load(\".tracker/state.json\");\n", "cross-tree-state-access"],
        ["files-nested-alias.ts", "import { readFileSync } from \"node:fs\"; function read() { const load = readFileSync; load(\".tracker/state.json\"); }\n", "cross-tree-state-access"],
        ["process-import-alias.ts", "import { spawn as runLegacy } from \"node:child_process\"; runLegacy(\"node\", [\"src/cli.ts\"]);\n", "cross-tree-process-invocation"],
        ["state.ts", "readFileSync(resolve(process.cwd(), \".tracker\"));\n", "cross-tree-state-access"],
        ["state-env.ts", "readFileSync(process.env.LEGACY_TRACKER_ROOT);\n", "cross-tree-filesystem-access"],
        ["runtime.ts", "fetch(\"http://127.0.0.1:3838/api/entries\");\n", "cross-tree-runtime-bridge"],
        ["runtime-port.ts", "connect({ port: 3838 });\n", "cross-tree-runtime-bridge"],
        ["runtime-env.ts", "fetch(process.env.LEGACY_URL);\n", "cross-tree-runtime-bridge"],
        ["proxy.ts", "app.use(\"/legacy\", \"http://127.0.0.1:3838\");\n", "route-proxy-forward-remount"],
        ["proxy-env.ts", "proxy(process.env.LEGACY_URL);\n", "route-proxy-forward-remount"],
        ["forward.ts", "router.forward(\"http://127.0.0.1:3838\");\n", "route-proxy-forward-remount"],
        ["remount.ts", "app.mount(\"/legacy\", \"http://127.0.0.1:3838\");\n", "route-proxy-forward-remount"],
        ["lift.ts", "liftLegacyRows();\n", "continuous-runtime-lift"],
        ["profile.ts", "launchPersistentContext(\".auth\");\n", "shared-browser-session"],
        ["profile-env.ts", "launchPersistentContext(process.env.LEGACY_PROFILE);\n", "shared-browser-session"],
      ];
      for (const [name, content, expected] of cases) {
        const path = `temp_src/core/${name}`;
        write(root, path, content);
        assert.ok(bridgeClasses(root, contract, scripts).includes(expected), `${name} must trigger ${expected}`);
        rmSync(join(root, path));
      }

      write(root, "src/rebuild-state.ts", "readFileSync(\".tracker-rebuild\");\n");
      assert.ok(bridgeClasses(root, contract, scripts).includes("cross-tree-state-access"));
      rmSync(join(root, "src/rebuild-state.ts"));

      write(
        root,
        "temp_src/core/declarations-only.ts",
        "import { readFileSync as load } from 'node:fs';\nimport type { Stats as ReadFileSync } from 'node:fs';\nimport type browserRuntime from 'puppeteer';\nimport type { RequestOptions } from 'node:http';\nimport type { WorkerOptions } from 'node:worker_threads';\nexport type { BigIntStats as readFileSync } from 'node:fs';\n// load('.tracker/state.json'); fetch('http://127.0.0.1:3838'); liftLegacyRows();\ntype Reader = ReadFileSync & RequestOptions & WorkerOptions & typeof browserRuntime & typeof import('node:fs/promises');\nconst legacyState = '.tracker';\nfunction liftLegacyRows(): void {}\n",
      );
      assert.deepEqual(auditRuntimeIsolation(root, contract, scripts), []);
    });
  });
});
