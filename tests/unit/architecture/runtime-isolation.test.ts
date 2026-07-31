import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import isolationJson from "../../../config/rebuild/runtime-isolation.json" with { type: "json" };
import { REPO_ROOT } from "./helpers/guard-files.js";
import {
  auditRuntimeIsolation,
  SUPPORTED_FORBIDDEN_BRIDGE_CLASSES,
  type ForbiddenBridgeClass,
  type RuntimeIsolationContract,
} from "./helpers/runtime-isolation-audit.js";

const isolation = isolationJson as RuntimeIsolationContract;
const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

function write(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
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
    contract.rebuild.runtimeConfig?.module ?? "missing",
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
  write(
    root,
    "temp_src/cli.ts",
    `import { rebuildRuntimeIsolation } from "./config/runtime-isolation.js";
declare function startRebuildRuntime(value: unknown): void;
startRebuildRuntime({ isolation: rebuildRuntimeIsolation });
`,
  );
  write(
    root,
    "temp_src/core/workflow-registry.ts",
    `import { rebuildRuntimeIsolation } from "../config/runtime-isolation.js";
declare function composeRebuildRuntime(value: unknown): void;
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
        exportName: "rebuildRuntimeIsolation",
      },
      compositionRoots: [
        { path: "temp_src/cli.ts", factory: "startRebuildRuntime" },
        { path: "temp_src/core/workflow-registry.ts", factory: "composeRebuildRuntime" },
      ],
    });
    assert.deepEqual(
      [...isolation.forbiddenBridgeClasses].sort(),
      [...SUPPORTED_FORBIDDEN_BRIDGE_CLASSES].sort(),
    );

    for (const key of ["stateRoot", "artifactRoot", "processLockRoot", "browserProfileRoot", "browserSessionNamespace"] as const) {
      assert.notEqual(isolation.legacy[key], isolation.rebuild[key], `${key} must differ`);
    }
    assert.notEqual(isolation.legacy.backendPort, isolation.rebuild.backendPort);
    assert.notEqual(isolation.legacy.frontendPort, isolation.rebuild.frontendPort);
  });

  it("audits the real pre-tree checkout and exact legacy commands", () => {
    assert.deepEqual(auditRuntimeIsolation(REPO_ROOT, isolation, packageJson.scripts), []);
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
    });
  });

  it("detects static imports, computed dynamic imports, and require calls in both runtime directions", () => {
    withActiveFixture((root, contract, scripts) => {
      for (const [path, content] of [
        ["temp_src/core/static.ts", "import \"../../src/cli.js\";\n"],
        ["temp_src/core/bare.ts", "import \"src/cli.js\";\n"],
        ["temp_src/core/dynamic.ts", "const target = \"../../src/cli.js\"; export const load = () => import(target);\n"],
        ["temp_src/core/required.ts", "const target = \"../../src/cli.js\"; export const load = () => require(target);\n"],
        ["src/rebuild-edge.ts", "export const load = () => import(\"../temp_src/cli.js\");\n"],
      ] as const) {
        write(root, path, content);
        assert.ok(bridgeClasses(root, contract, scripts).includes("cross-tree-module-edge"), path);
        rmSync(join(root, path));
      }
    });
  });

  it("detects direct invocation, filesystem/state access, runtime calls, proxy/forward/remount, lift, and shared sessions", () => {
    withActiveFixture((root, contract, scripts) => {
      const cases: readonly [string, string, ForbiddenBridgeClass][] = [
        ["process.ts", "spawn(\"node\", [\"src/cli.ts\"]);\n", "cross-tree-process-invocation"],
        ["process-env.ts", "spawn(process.env.LEGACY_COMMAND);\n", "cross-tree-process-invocation"],
        ["files.ts", "readFileSync(\"src/tracker/state.ts\");\n", "cross-tree-filesystem-access"],
        ["state.ts", "readFileSync(resolve(process.cwd(), \".tracker\"));\n", "cross-tree-state-access"],
        ["state-env.ts", "readFileSync(process.env.LEGACY_TRACKER_ROOT);\n", "cross-tree-state-access"],
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
        "// fetch('http://127.0.0.1:3838'); liftLegacyRows();\nconst legacyState = '.tracker';\nfunction liftLegacyRows(): void {}\n",
      );
      assert.deepEqual(auditRuntimeIsolation(root, contract, scripts), []);
    });
  });
});
