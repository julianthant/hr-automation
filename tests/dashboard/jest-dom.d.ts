// Ambient type augmentation for the jsdom dashboard component-test pool.
//
// `@testing-library/jest-dom/vitest` extends vitest's `Assertion` interface
// with the DOM matchers (`toBeInTheDocument`, `toHaveAccessibleName`, ...).
// The runtime `expect.extend(matchers)` lives in `tests/dashboard-setup.ts`;
// this file only supplies the matching TYPES so `npm run typecheck` (which
// includes `tests/**/*`) sees them. Scoped to `tests/dashboard/` so the
// augmentation doesn't leak into the node-pool test files.
import "@testing-library/jest-dom/vitest";
