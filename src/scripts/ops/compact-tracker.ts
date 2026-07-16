import { resolve } from "node:path";

import { compactTracker } from "../../tracker/compaction.js";
import { closeStateDb, openStateDb } from "../../tracker/state/db.js";

const dirArg = process.argv[2] ?? ".tracker";
const dir = resolve(dirArg);
const db = openStateDb(dir);
try {
  const result = compactTracker(db, dir);
  process.stdout.write(`Compacted ${result.filesCompacted} tracker source file(s) in ${dir}\n`);
} finally {
  closeStateDb(dir);
}
