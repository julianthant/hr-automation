#!/usr/bin/env node
// Pre-commit guard: this repo is public, so staged changes must not carry operator data.
// Run with --self-test after editing.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const PRIVATE_PATHS = /^(data\/|\.tracker\/|\.auth\/|\.env($|\.(?!example$))|config\/settings\.json$|duo-autopilot\/)/;
const ALLOWED_DATA_FILES = new Set(["data/documents/make-e2e-roster.mjs", "data/rosters/.gitkeep"]);
const DOCUMENT_FILE = /\.(pdf|xlsx|xls|docx|heic)$/i;
const IMAGE_FILE = /\.(png|jpe?g)$/i;
const ALWAYS_BLOCKED = [
  [/[A-Za-z0-9._%+-]+@ucsd\.edu/i, "UCSD email address"],
  [/\b\d{3}-\d{2}-\d{4}\b/, "SSN-shaped number"],
];
const TOKEN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\b\d{8}\b/g;

export function findViolations({ addedFiles, addedLines, privateTokens }) {
  const violations = [];
  for (const file of addedFiles) {
    if (PRIVATE_PATHS.test(file) && !ALLOWED_DATA_FILES.has(file)) violations.push(`${file}: private path`);
    else if (DOCUMENT_FILE.test(file)) violations.push(`${file}: document file`);
    else if (IMAGE_FILE.test(file) && !file.startsWith("docs/showcase/")) violations.push(`${file}: image outside docs/showcase/`);
  }
  for (const { file, line } of addedLines) {
    for (const [pattern, label] of ALWAYS_BLOCKED) {
      if (pattern.test(line)) violations.push(`${file}: ${label}`);
    }
    for (const token of line.match(TOKEN) ?? []) {
      if (privateTokens.has(token.toLowerCase())) violations.push(`${file}: value found in local operator data`);
    }
  }
  return [...new Set(violations)];
}

// Emails and 8-digit IDs that appear in the ignored operator data on this machine.
// shortcut: rereads ~150 MB of tracker text per commit (~4 s); cache the token set if commits feel slow.
function readPrivateTokens() {
  const tokens = new Set();
  for (const root of ["data", ".tracker"]) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(jsonl?|csv|txt)$/i.test(entry.name)) continue;
      const text = readFileSync(join(entry.parentPath, entry.name), "utf8");
      for (const token of text.match(TOKEN) ?? []) tokens.add(token.toLowerCase());
    }
  }
  return tokens;
}

function stagedChanges() {
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const addedFiles = git("diff", "--cached", "--name-only", "--diff-filter=ACMR").split("\n").filter(Boolean);
  const addedLines = [];
  let file = "";
  for (const line of git("diff", "--cached", "-U0", "--no-color", "--diff-filter=ACMR").split("\n")) {
    if (line.startsWith("+++ ")) file = line.slice(6);
    else if (line.startsWith("+")) addedLines.push({ file, line: line.slice(1) });
  }
  return { addedFiles, addedLines };
}

function selfTest() {
  const privateTokens = new Set(["10987123", "jane.private@gmail.com"]);
  const check = (addedFiles, lines) =>
    findViolations({ addedFiles, addedLines: lines.map((line) => ({ file: "x.ts", line })), privateTokens });
  assert.deepEqual(check(["src/a.ts", "data/rosters/.gitkeep", ".env.example", "docs/showcase/a.png"], ['employeeId: "10123456"']), []);
  assert.deepEqual(check(["data/rosters/real.xlsx"], []), ["data/rosters/real.xlsx: private path"]);
  assert.deepEqual(check([".env"], []), [".env: private path"]);
  assert.deepEqual(check(["tests/fixtures/form.pdf"], []), ["tests/fixtures/form.pdf: document file"]);
  assert.deepEqual(check(["src/shot.png"], []), ["src/shot.png: image outside docs/showcase/"]);
  assert.deepEqual(check([], ["mail jdoe@" + "ucsd.edu"]), ["x.ts: UCSD email address"]);
  assert.deepEqual(check([], ["ssn 123-45-" + "6789"]), ["x.ts: SSN-shaped number"]);
  assert.deepEqual(check([], ['id: "10987123"', "Jane.Private@gmail.com"]), ["x.ts: value found in local operator data"]);
  console.log("check-staged-private-data: self-test passed");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const violations = findViolations({ ...stagedChanges(), privateTokens: readPrivateTokens() });
  if (violations.length > 0) {
    console.error("Commit blocked: staged changes look like private HR data. This repo is public.");
    for (const v of violations) console.error(`  ${v}`);
    console.error("Remove the data, or use git commit --no-verify only if you are certain it is synthetic.");
    process.exit(1);
  }
}
