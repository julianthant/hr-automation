import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { recordConsoleLog } from "./tests/log-audit-core.js";

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
  },
});
