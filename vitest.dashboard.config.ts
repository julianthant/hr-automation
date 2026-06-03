import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

/**
 * SECOND, ISOLATED test pool — quarantines the jsdom + `expect` + jest-dom
 * convention break from the main node pool (`vitest.config.ts`, which uses
 * `globals:false` + `node:assert` and only matches `tests/**\/*.test.ts`).
 *
 * This config:
 *   - only matches `tests/dashboard/**\/*.test.tsx` (the component layer),
 *   - runs in jsdom with `globals:true` so `@testing-library/jest-dom`
 *     matchers can extend vitest's `expect`,
 *   - mirrors the `@`→`src/dashboard` alias the dashboard source uses,
 *   - keeps the house single-fork sequential shape (`pool:"forks"`,
 *     `fileParallelism:false`) so module-level dashboard singletons (the
 *     1Hz clock, poll caches) don't bleed across files.
 *
 * Run via `npm run test:dashboard`.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src/dashboard"),
    },
  },
  test: {
    include: ["tests/dashboard/**/*.test.tsx"],
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/dashboard-setup.ts"],
    // Match house style: single fork, no cross-file parallelism. Component
    // tests rely on a shared jsdom document + the module-level 1Hz clock /
    // poll caches in the dashboard hooks, which are not parallel-safe.
    pool: "forks",
    isolate: true,
    fileParallelism: false,
    // CSS from HeroUI/Radix/Tailwind isn't needed for behavior assertions;
    // skip processing it so vite doesn't choke on a stylesheet import.
    css: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
