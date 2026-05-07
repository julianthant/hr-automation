import js from "@eslint/js";
import ts from "typescript-eslint";
import unusedImports from "eslint-plugin-unused-imports";

export default [
  {
    ignores: ["dist", "node_modules", "src/dashboard"],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    plugins: {
      "unused-imports": unusedImports,
    },
    languageOptions: {
      parser: ts.parser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        project: "./tsconfig.json",
      },
    },
    rules: {
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "warn",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "all",
          argsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      "unused-imports/no-unused-vars": "off",
    },
  },
];
