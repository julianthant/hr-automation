import { existsSync, readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { resolve } from "path";

/** Browser bundle of the private-value helper. Values stay out of source; dist/ is gitignored. */
function privateDataBrowserModule(): Plugin {
  return {
    name: "private-data-browser",
    enforce: "pre",
    load(id) {
      const normalized = id.split("?")[0].replace(/\\/g, "/");
      if (!normalized.endsWith("/src/private-data.ts")) return null;
      const folder = resolve(__dirname, "private");
      const file = resolve(folder, "values.json");
      const missing = !existsSync(folder) ? "private/" : !existsSync(file) ? "private/values.json" : null;
      const table = missing ? "null" : readFileSync(file, "utf8");
      return [
        "export class MissingPrivateDataError extends Error {",
        "  constructor(ref) {",
        "    super(`Missing private data: ${ref}`);",
        "    this.name = \"MissingPrivateDataError\";",
        "  }",
        "}",
        `const table = ${table};`,
        "function requireTable() {",
        `  if (table === null) throw new MissingPrivateDataError(${JSON.stringify(missing)});`,
        "  return table;",
        "}",
        "export function privateValue(key) {",
        "  const values = requireTable();",
        "  if (!Object.prototype.hasOwnProperty.call(values, key)) throw new MissingPrivateDataError(key);",
        "  return values[key];",
        "}",
        "export function privateFile(relativePath) {",
        "  throw new MissingPrivateDataError(`private/${relativePath}`);",
        "}",
        "export function privateJson(relativePath) {",
        "  throw new MissingPrivateDataError(`private/${relativePath}`);",
        "}",
        "export function readPrivateIfListed(absoluteFile) {",
        "  return absoluteFile;",
        "}",
      ].join("\n");
    },
  };
}

export default defineConfig({
  root: "src/dashboard",
  plugins: [privateDataBrowserModule(), react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src/dashboard"),
    },
  },
  build: {
    outDir: "../../dist/dashboard",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:3838",
      "/events": "http://localhost:3838",
      "/screenshots": "http://localhost:3838",
    },
  },
});
