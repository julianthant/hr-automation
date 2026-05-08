#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

function findTests(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findTests(full));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const root = process.argv[2] ?? "tests";
const files = findTests(root);
if (files.length === 0) {
  console.error(`No .test.ts files found under ${root}`);
  process.exit(1);
}

const result = spawnSync("tsx", ["--test", "--test-force-exit", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
