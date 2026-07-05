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
// this object adjusts the rules that currently HAVE findings so `npm run lint`
// gives real signal instead of a wall of red. Two tiers:
//
//   (1) ENFORCED (error), just configured smarter — real bug classes we keep.
//   (2) TYPING DEBT (warn) — visible, greppable, burn down over time. These
//       either need author-aware type work at untyped JSON/library boundaries
//       (`no-unsafe-*`, `no-base-to-string`) or touch the kernel's deliberate
//       error/promise handling (`only-throw-error`, `prefer-promise-reject-errors`),
//       so a rushed mass edit would risk real behavior — not a blanket silence.
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

  // (2) TYPING DEBT — warn, burn down later.
  "@typescript-eslint/no-base-to-string": "warn",
  "@typescript-eslint/no-unsafe-assignment": "warn",
  "@typescript-eslint/no-unsafe-member-access": "warn",
  "@typescript-eslint/no-unsafe-call": "warn",
  "@typescript-eslint/no-unsafe-argument": "warn",
  "@typescript-eslint/no-unsafe-return": "warn",
  "@typescript-eslint/no-redundant-type-constituents": "warn",
  "@typescript-eslint/only-throw-error": "warn",
  "@typescript-eslint/prefer-promise-reject-errors": "warn",
  "@typescript-eslint/await-thenable": "warn",
  // `async` kept for signature/interface consistency (uniform handler shape).
  "@typescript-eslint/require-await": "warn",
  // Fires on every `${value}` where `value` is a union/number/boolean — mostly
  // benign interpolation in log/trace strings.
  "@typescript-eslint/restrict-template-expressions": [
    "warn",
    { allowNumber: true, allowBoolean: true, allowNullish: true },
  ],
  // Core rule (not typescript-eslint): losing the original error in a re-throw.
  // One finding, in active parallel work — surface as a warning.
  "preserve-caught-error": "warn",
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
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
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
