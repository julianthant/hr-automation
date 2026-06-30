/**
 * Seed a synthetic SCREENSHOTS fixture into an isolated tracker dir for headless
 * dashboard verification of the Screenshots tab folder-chunk grouping.
 *
 * Produces ONE selectable `single` queue row plus four screenshot capture
 * EVENTS attributed to its run:
 *   - a TALL-page capture split into 8 `-cNN` page-slice chunks (ONE event, 8
 *     files) → collapses into a single "folder" tile (cover = chunk 1, badge
 *     `Layers · 8`, "View all 8 pages"); opening it pages through all 8.
 *   - three single-file captures (form / error / step) → ordinary tiles, so the
 *     filter chips (All · Errors · Steps · per-system) all light up.
 *
 * Real PNGs are written (distinct colors per chunk) so the grid + lightbox
 * actually render images.
 *
 * Usage:
 *   tsx scripts/seed-screenshots-fixture.ts [trackerDir]
 *   (default: generated/.dashboard-preview/tracker — gitignored)
 *
 * Then:
 *   npm run build:dashboard
 *   HRAUTO_TRACKER_DIR=generated/.dashboard-preview/tracker npm run dashboard:prod -- --port 3939
 *   (select the queued separations row → Screenshots tab)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PNG } from "pngjs";
import { buildTraceId } from "../src/domain/queue-trace-id.js";
import { buildOperatorSubject, operatorSubjectData } from "../src/domain/operator-subject.js";
import { emitTrackerRow, type StampedData } from "../src/tracker/jsonl-io.js";
import { emitScreenshotEvent } from "../src/tracker/jsonl.js";
import { formatCaptureFilename } from "../src/core/kernel/session.js";
import { rowsDir, logsDir, sessionsDir, screenshotsDir } from "../src/tracker/paths.js";

const dir = process.argv[2] ?? "generated/.dashboard-preview/tracker";
const shotsDir = screenshotsDir(dir);
mkdirSync(rowsDir(dir), { recursive: true });
mkdirSync(logsDir(dir), { recursive: true });
mkdirSync(sessionsDir(dir), { recursive: true });
mkdirSync(shotsDir, { recursive: true });

const WORKFLOW = "separations";
const ITEM_ID = "3907";
const RUN_ID = randomUUID();
const baseAt = new Date();
const traceId = buildTraceId({ code: "se", runId: RUN_ID, at: baseAt });

/** Write a solid-color PNG so the tile/lightbox render a real image. */
function writePng(path: string, rgb: [number, number, number]): void {
  const png = new PNG({ width: 320, height: 200 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgb[0];
    png.data[i + 1] = rgb[1];
    png.data[i + 2] = rgb[2];
    png.data[i + 3] = 255;
  }
  writeFileSync(path, PNG.sync.write(png));
}

// ── Selectable single row ──────────────────────────────────────────────────
const subject = buildOperatorSubject({ kind: "document", value: ITEM_ID, prefix: "Separation" });
const rowData: StampedData = {
  archetype: "single",
  queueRowKind: "person",
  __id: ITEM_ID,
  __traceId: traceId,
  instance: "Separation 1",
  ...operatorSubjectData(subject),
};
emitTrackerRow(
  {
    workflow: WORKFLOW,
    timestamp: baseAt.toISOString(),
    id: ITEM_ID,
    runId: RUN_ID,
    status: "done",
    data: rowData,
  },
  dir,
);

// ── Capture event 1: a tall page split into 8 chunks → ONE folder tile ──────
const folderTs = baseAt.getTime();
const folderFiles = Array.from({ length: 8 }, (_unused, chunk) => {
  const filename = formatCaptureFilename({
    workflow: WORKFLOW,
    itemId: ITEM_ID,
    kind: "form",
    label: "kuali-finalization",
    system: "kuali",
    ts: folderTs,
    chunk,
  });
  const path = join(shotsDir, filename);
  // Walk a green→blue ramp down the page so each slice is visibly distinct.
  writePng(path, [30, 120 + chunk * 15, 200 - chunk * 18]);
  return { system: "kuali", path };
});
emitScreenshotEvent(
  {
    type: "screenshot",
    runId: RUN_ID,
    ts: folderTs,
    timestamp: new Date(folderTs).toISOString(),
    kind: "form",
    label: "kuali-finalization",
    step: "kuali-finalization",
    files: folderFiles,
  },
  { dir },
);

// ── Single-file captures (one file each → ordinary tiles) ───────────────────
function singleCapture(
  offsetMs: number,
  kind: "form" | "error" | "step",
  label: string,
  system: string,
  rgb: [number, number, number],
): void {
  const ts = baseAt.getTime() + offsetMs;
  const filename = formatCaptureFilename({ workflow: WORKFLOW, itemId: ITEM_ID, kind, label, system, ts });
  const path = join(shotsDir, filename);
  writePng(path, rgb);
  emitScreenshotEvent(
    {
      type: "screenshot",
      runId: RUN_ID,
      ts,
      timestamp: new Date(ts).toISOString(),
      kind,
      label,
      step: label,
      files: [{ system, path }],
    },
    { dir },
  );
}

singleCapture(1000, "form", "ucpath-job-summary", "ucpath", [40, 90, 180]);
singleCapture(2000, "error", "kuali-timeout", "kuali", [180, 50, 50]);
singleCapture(3000, "step", "person-search", "ucpath", [120, 90, 160]);

// eslint-disable-next-line no-console
console.log(
  `[seed-screenshots-fixture] seeded → ${dir}\n` +
    `  row: ${WORKFLOW}/${ITEM_ID} runId=${RUN_ID.slice(0, 8)}… trace=${traceId}\n` +
    `  captures: 1 folder (8 chunks) + 3 singles (form/error/step) in ${shotsDir}\n` +
    `  (workflow_start.pid=${process.pid}). Kill this process when done.`,
);

setInterval(() => {}, 1 << 30);
