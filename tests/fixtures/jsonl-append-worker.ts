import { appendJsonlWithSource } from "../../src/tracker/state/jsonl-source.js";

const path = process.argv[2];
const worker = process.argv[3];
if (!path || !worker) throw new Error("usage: jsonl-append-worker <path> <worker>");

const offsets: number[] = [];
for (let index = 0; index < 50; index += 1) {
  const source = appendJsonlWithSource(
    path,
    { worker, index },
    { sourceKind: "tracker", workflow: "lock-test", trackerDate: "2026-07-16" },
  );
  offsets.push(source.offset);
}
process.stdout.write(JSON.stringify(offsets));
