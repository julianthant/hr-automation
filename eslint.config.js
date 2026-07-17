import js from "@eslint/js";
import ts from "typescript-eslint";
import globals from "globals";
import unusedImports from "eslint-plugin-unused-imports";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

// The `_`-prefix convention (a var/arg prefixed with `_` is intentionally
// unused — e.g. `const { privateKey: _omit, ...rest } = obj`). Shared by the
// back-end and dashboard blocks; the tests block mirrors it with the core rule.
const unusedImportsRules = {
  "@typescript-eslint/no-unused-vars": "off",
  "unused-imports/no-unused-imports": "error",
  "unused-imports/no-unused-vars": [
    "warn",
    { vars: "all", varsIgnorePattern: "^_", args: "all", argsIgnorePattern: "^_" },
  ],
};

// Type-aware rule tiering for this codebase. The `recommendedTypeChecked`
// preset stays ON (dozens of clean rules enforce as errors and guard new code);
// this object adjusts the rest. Two tiers:
//
//   (1) ENFORCED (error) — real bug classes, configured smarter where the
//       default fights a deliberate idiom. The former "typing debt" warns
//       (`no-unsafe-*`, `no-base-to-string`, throw/reject hygiene) were burned
//       to zero 2026-07-17 and promoted to errors — new findings fail the lint
//       gate immediately.
//   (2) OFF with cause — rules that contradict a documented house idiom, not
//       debt: `require-await` (handlers keep a uniform async signature even
//       when a given implementation happens to be sync) and the dashboard's
//       `react-refresh/only-export-components` (hooks/registries are
//       deliberately co-located with their components; a full HMR reload for
//       those files is acceptable, and there is no component test harness the
//       boundary would protect).
const typeAwareTuning = {
  // (1) ENFORCED. `no-floating-promises` stays a hard error (default) — real
  // fire-and-forget bugs, marked explicitly with `void`. `no-misused-promises`
  // stays an error but with `checksVoidReturn` off: passing an async function
  // where a `void`-returning one is expected (React event handlers, Node
  // request listeners, callback props — the fire-and-forget UI/server norm) is
  // allowed, while the genuinely dangerous cases still error — an async value
  // in a conditional (`if (asyncFn())` is always truthy) or a spread promise.
  "@typescript-eslint/no-misused-promises": [
    "error",
    { checksVoidReturn: false },
  ],

  // Unsafe-boundary + stringification rules: zero findings as of 2026-07-17,
  // enforced so they stay zero. `String(unknownValue)` at a persistence or
  // API boundary is exactly how "[object Object]" reaches a tracker row.
  "@typescript-eslint/no-base-to-string": "error",
  "@typescript-eslint/no-unsafe-assignment": "error",
  "@typescript-eslint/no-unsafe-member-access": "error",
  "@typescript-eslint/no-unsafe-call": "error",
  "@typescript-eslint/no-unsafe-argument": "error",
  "@typescript-eslint/no-unsafe-return": "error",
  "@typescript-eslint/no-redundant-type-constituents": "error",
  "@typescript-eslint/only-throw-error": "error",
  "@typescript-eslint/prefer-promise-reject-errors": "error",
  "@typescript-eslint/await-thenable": "error",
  // OFF: handlers keep a uniform async signature even when one implementation
  // happens to be sync today (daemon queue ops, route handlers) — the rule
  // would force signature churn on every such edit.
  "@typescript-eslint/require-await": "off",
  // `${value}` where value is number/boolean/nullish is benign log
  // interpolation; anything else (objects, unions with objects) errors.
  "@typescript-eslint/restrict-template-expressions": [
    "error",
    { allowNumber: true, allowBoolean: true, allowNullish: true },
  ],
  // Core rule (not typescript-eslint): losing the original error in a re-throw.
  "preserve-caught-error": "error",
};

export default ts.config(
  { ignores: ["dist", "node_modules"] },
  js.configs.recommended,
  ...ts.configs.recommended,
  ...ts.configs.recommendedTypeChecked,

  // Type-aware parsing: `projectService` routes each file to its nearest
  // tsconfig (root `tsconfig.json` for the back-end, `src/dashboard/tsconfig.json`
  // for the browser dashboard).
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Back-end / Node sources: everything under src EXCEPT the browser dashboard.
  {
    files: ["src/**/*.ts"],
    ignores: ["src/dashboard/**"],
    plugins: { "unused-imports": unusedImports },
    languageOptions: { globals: { ...globals.node } },
    rules: { ...unusedImportsRules, ...typeAwareTuning },
  },

  // Browser dashboard: React 19 + Vite (its own tsconfig). Browser globals plus
  // the React Hooks rules (rules-of-hooks is an error, exhaustive-deps a warn)
  // and the Vite fast-refresh boundary check.
  {
    files: ["src/dashboard/**/*.ts", "src/dashboard/**/*.tsx"],
    plugins: {
      "unused-imports": unusedImports,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      ...unusedImportsRules,
      ...typeAwareTuning,
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      // OFF: hooks, contexts and node/edge registries are deliberately
      // co-located with their components (see workflows-context.tsx,
      // edge-registry.tsx); Vite falls back to a full reload for those
      // modules, which this dashboard accepts.
      "react-refresh/only-export-components": "off",
    },
  },

  // Tests: mirror the src `_`-prefix convention using the core TS rule, and
  // relax the type-aware rules that fight test ergonomics (mocks, throwaway
  // promises, `any`-typed fixtures). NOT part of `npm run lint` (which is
  // src-only and must stay green) — run via `npm run lint:tests`; the current
  // error count there is typing debt to burn down.
  {
    files: ["tests/**/*.ts", "tests/**/*.tsx"],
    plugins: { "unused-imports": unusedImports },
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "unused-imports/no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { varsIgnorePattern: "^_", argsIgnorePattern: "^_" },
      ],
      ...typeAwareTuning,
    },
  },

  // Config / plain-JS files aren't part of any tsconfig program — turn off the
  // type-aware rules for them so the parser doesn't demand a project.
  {
    files: ["**/*.js", "**/*.cjs", "**/*.mjs"],
    ...ts.configs.disableTypeChecked,
  },
);
