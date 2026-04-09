import ExcelJS from "exceljs";
import { readEntries, type TrackerEntry } from "./jsonl.js";
import { log } from "../utils/log.js";

export async function exportToExcel(
  workflow: string,
  outputPath?: string,
): Promise<string> {
  const entries = readEntries(workflow);
  if (entries.length === 0) {
    log.error(`No entries found for workflow "${workflow}"`);
    return "";
  }

  const outPath = outputPath ?? `${workflow}-export.xlsx`;
  const workbook = new ExcelJS.Workbook();

  // Group by date
  const byDate = new Map<string, TrackerEntry[]>();
  for (const entry of entries) {
    const date = entry.timestamp.slice(0, 10);
    const group = byDate.get(date) ?? [];
    group.push(entry);
    byDate.set(date, group);
  }

  for (const [date, group] of byDate) {
    // Dedupe: keep latest entry per ID
    const latest = new Map<string, TrackerEntry>();
    for (const entry of group) latest.set(entry.id, entry);

    const sheet = workbook.addWorksheet(date);
    sheet.columns = [
      { header: "ID", key: "id", width: 30 },
      { header: "Status", key: "status", width: 12 },
      { header: "Step", key: "step", width: 20 },
      { header: "Error", key: "error", width: 40 },
      { header: "Timestamp", key: "timestamp", width: 22 },
    ];
    sheet.getRow(1).font = { bold: true };

    for (const entry of latest.values()) {
      sheet.addRow({
        id: entry.id,
        status: entry.status,
        step: entry.step ?? "",
        error: entry.error ?? "",
        timestamp: entry.timestamp,
      });
    }
  }

  await workbook.xlsx.writeFile(outPath);
  log.success(`Exported ${entries.length} entries to ${outPath}`);
  return outPath;
}
