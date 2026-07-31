import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { recordConsoleLog } from "./tests/log-audit-core.js";

export const REBUILD_COVERAGE_INCLUDE = ["temp_src/**/*.ts", "temp_src/**/*.tsx"] as const;
export const REBUILD_COVERAGE_EXCLUSIONS = [
  { pattern: "temp_src/**/*.d.ts", activationRoot: "temp_src/**/*.d.ts", reason: "Type declarations are not executable authored code." },
  { pattern: "temp_src/**/generated/**", activationRoot: "temp_src/**/generated/**", reason: "Generated projections are verified by determinism guards." },
  { pattern: "temp_src/dashboard/**/*.tsx", activationRoot: "temp_src/dashboard/**/*.tsx", reason: "Presentation components use the headless Playwright lane; extracted .ts logic remains measured." },
  { pattern: "temp_src/stores/*/driver/raw-page/**", activationRoot: "temp_src/stores/*/driver/raw-page/**", reason: "The sole raw Page internals require the live semantic-driver lane." },
  { pattern: "temp_src/**/index.ts", activationRoot: "temp_src/**/index.ts", reason: "Pure barrels contain no decision logic." },
  { pattern: "temp_src/cli.ts", activationRoot: "temp_src/cli.ts", reason: "The process entrypoint is boot-smoke verified." },
] as const;

export const REBUILD_COVERAGE_FLOORS = {
  global: { lines: 60, statements: 60, functions: 60 },
  safetyCritical: { lines: 80, statements: 80, functions: 80 },
  branches: { phase1ReportOnly: true, phase2Global: 50, phase2SafetyCritical: 70 },
} as const;

export default defineConfig({
  // Vite's resolver runs on test files too. The `@/` alias is wired the same
  // way as in vite.dashboard.config.ts so dashboard source files (and the
  // tests that exercise them) can `import "@/components/..."` consistently.
  resolve: {
    alias: {
      "@": resolve(__dirname, "src/dashboard"),
    },
  },
  test: {
    // Each test file runs in its own isolated fork, so process.env mutations
    // and module-level caches are per-file no matter the scheduling. The
    // remaining serial constraint is real-time/load sensitivity, split by
    // project (2026-07-17): `unit` runs files in parallel; `serial`
    // (delegation daemons + mocked integration) keeps one-at-a-time ordering —
    // those drive real daemon processes whose timing flakes under CPU
    // contention. File selection lives ONLY on the projects: `extends: true`
    // CONCATENATES array options, so a root-level `include` would union into
    // every project and erase the split. `tests/live/**` stays excluded here —
    // it runs only via `npm run test:live` (vitest.live.config.ts).
    pool: "forks",
    isolate: true,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          fileParallelism: true,
        },
      },
      {
        extends: true,
        test: {
          name: "rebuild-unit",
          include: ["tests/rebuild/unit/**/*.test.ts"],
          fileParallelism: true,
        },
      },
      {
        extends: true,
        test: {
          name: "rebuild-scenario",
          include: ["tests/rebuild/scenario/**/*.test.ts"],
          fileParallelism: true,
        },
      },
      {
        extends: true,
        test: {
          name: "serial",
          include: ["tests/delegation/**/*.test.ts", "tests/integration/**/*.test.ts"],
          fileParallelism: false,
        },
      },
    ],
    // setupFiles run before each test file's imports.
    // - env-bootstrap stamps TIMEKEEPER_NAME so src/config.ts loads.
    // - setup.ts registers a beforeEach that resets dashboard caches.
    setupFiles: [
      "./tests/env-bootstrap.ts",
      "./tests/setup.ts",
      "./tests/log-audit.ts",
    ],
    onConsoleLog(log, type, entity) {
      recordConsoleLog(log, type, entity);
    },
    // node:assert/strict carries assertions; vitest's `expect` is not used.
    globals: false,
    // node:test had effectively no per-test timeout for short waits; vitest
    // defaults to 5s, which trips tests that exercise AbortSignal.timeout
    // production paths. 30s matches the node:test runner's old behavior
    // comfortably.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: [...REBUILD_COVERAGE_INCLUDE],
      exclude: REBUILD_COVERAGE_EXCLUSIONS.map(({ pattern }) => pattern),
      thresholds: {
        lines: REBUILD_COVERAGE_FLOORS.global.lines,
        statements: REBUILD_COVERAGE_FLOORS.global.statements,
        functions: REBUILD_COVERAGE_FLOORS.global.functions,
        "temp_src/core/**": REBUILD_COVERAGE_FLOORS.safetyCritical,
        "temp_src/stores/common/mutation*.ts": REBUILD_COVERAGE_FLOORS.safetyCritical,
        "temp_src/**/*write-sequencer*.ts": REBUILD_COVERAGE_FLOORS.safetyCritical,
        "temp_src/**/*subject-binding*.ts": REBUILD_COVERAGE_FLOORS.safetyCritical,
        "temp_src/**/*authority-store*.ts": REBUILD_COVERAGE_FLOORS.safetyCritical,
        "temp_src/**/*recovery*.ts": REBUILD_COVERAGE_FLOORS.safetyCritical,
        "temp_src/**/*projection*.ts": REBUILD_COVERAGE_FLOORS.safetyCritical,
      },
    },
  },
});
