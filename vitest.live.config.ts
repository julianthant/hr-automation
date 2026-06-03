import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * LIVE integration pool — opt-in, hits real UCSD systems. Run with
 * `npm run test:live`. NOT part of `npm test` (the main config excludes
 * `tests/live/**`).
 *
 * These tests launch a real Chromium, log into live sites, and approve Duo
 * hands-off via the enrolled WebAuthn credential (`.auth/duo-webauthn.json`).
 * They REQUIRE: `.env` creds, `.auth/duo-webauthn.json`, and a machine that can
 * run Chromium. They SKIP cleanly when those are absent (see each test's
 * precondition guard). Serial, long timeouts, no stderr-audit (live auth logs
 * freely to stdout/stderr).
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "src/dashboard"),
    },
  },
  test: {
    include: ["tests/live/**/*.test.ts"],
    // Real browsers + real Duo: never parallel (signCount is global server
    // state; concurrent Duo prompts collide).
    pool: "forks",
    isolate: true,
    fileParallelism: false,
    // Loads the real .env and enables hands-off Duo. Deliberately NOT the
    // node-pool setup (no log-audit — live auth emits stderr legitimately).
    setupFiles: ["./tests/live/_setup.ts"],
    globals: false,
    // A full SSO + Duo ceremony can take 30-120s per site; allow generous
    // headroom so a healthy run never times out (a timeout hard-kills the
    // worker, which desyncs the WebAuthn signCount).
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
