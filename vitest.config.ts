import { defineConfig, configDefaults } from "vitest/config";
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
    // Mirror the previous `tsx --test` discovery: only `*.test.ts` under tests/.
    include: ["tests/**/*.test.ts"],
    // `tests/live/**` is the opt-in live pool (real browsers + live UCSD SSO);
    // it runs only via `npm run test:live` (vitest.live.config.ts), never here.
    exclude: [...configDefaults.exclude, "tests/live/**"],
    // The previous `tsx --test` runner ran files sequentially in one process.
    // Several tests rely on that: they mutate process.env, write to real
    // paths under PATHS.*, and depend on module-level dashboard caches that
    // tests/setup.ts resets between tests. Keep the same shape until we
    // explicitly audit each test for parallel-safety.
    pool: "forks",
    isolate: true,
    fileParallelism: false,
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
