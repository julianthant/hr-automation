import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";

import { sanitizeDownloadedXlsx } from "../../../../src/workflows/sharepoint-download/sanitize-xlsx.js";

/** Build a minimal .xlsx-shaped zip with the given table parts. */
async function writeFixture(
  dir: string,
  tables: Record<string, string>,
  extra: Record<string, string> = {},
): Promise<string> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("xl/workbook.xml", "<workbook/>");
  for (const [name, xml] of Object.entries(tables)) zip.file(`xl/tables/${name}`, xml);
  for (const [name, content] of Object.entries(extra)) zip.file(name, content);
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const path = join(dir, "fixture.xlsx");
  await writeFile(path, buf);
  return path;
}

async function readPart(path: string, part: string): Promise<string> {
  const zip = await JSZip.loadAsync(await readFile(path));
  return zip.file(part)!.async("string");
}

test("removes a self-closing colorFilter and reports the count", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "xlsx-sanitize-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

  const path = await writeFixture(dir, {
    "table1.xml": '<table><autoFilter ref="A1:B2"><filterColumn colId="0">'
      + '<colorFilter dxfId="109"/></filterColumn></autoFilter></table>',
  });

  const result = await sanitizeDownloadedXlsx(path);
  assert.equal(result.changed, true);
  assert.equal(result.removed.colorFilter, 1);

  const xml = await readPart(path, "xl/tables/table1.xml");
  assert.ok(!xml.includes("colorFilter"), "colorFilter must be gone");
  assert.ok(xml.includes('<autoFilter ref="A1:B2">'), "the surrounding autoFilter must survive");
  assert.ok(xml.includes('<filterColumn colId="0">'), "the surrounding filterColumn must survive");
});

test("removes paired open/close elements across multiple table parts", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "xlsx-sanitize-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

  const path = await writeFixture(dir, {
    "table1.xml": "<table><iconFilter iconSet=\"3Arrows\"><inner/></iconFilter></table>",
    "table2.xml": '<table><colorFilter dxfId="1"/><colorFilter dxfId="2"/></table>',
  });

  const result = await sanitizeDownloadedXlsx(path);
  assert.equal(result.changed, true);
  assert.equal(result.removed.iconFilter, 1);
  assert.equal(result.removed.colorFilter, 2);

  assert.ok(!(await readPart(path, "xl/tables/table1.xml")).includes("iconFilter"));
  assert.ok(!(await readPart(path, "xl/tables/table2.xml")).includes("colorFilter"));
});

test("leaves a clean workbook byte-identical and reports changed:false", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "xlsx-sanitize-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

  const path = await writeFixture(dir, {
    "table1.xml": '<table><autoFilter ref="A1:B2"/></table>',
  });
  const before = await readFile(path);

  const result = await sanitizeDownloadedXlsx(path);
  assert.equal(result.changed, false);
  assert.deepEqual(result.removed, {});
  assert.deepEqual(await readFile(path), before, "an untouched file must not be rewritten");
});

test("a workbook with no table parts is left alone", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "xlsx-sanitize-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

  const path = await writeFixture(dir, {}, { "xl/worksheets/sheet1.xml": "<worksheet/>" });
  const before = await readFile(path);

  const result = await sanitizeDownloadedXlsx(path);
  assert.equal(result.changed, false);
  assert.deepEqual(await readFile(path), before);
});

test("does not touch cell data in worksheet parts", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "xlsx-sanitize-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

  // A worksheet that merely MENTIONS colorFilter must survive untouched — only
  // xl/tables/*.xml is rewritten.
  const sheet = "<worksheet><c><v>colorFilter</v></c></worksheet>";
  const path = await writeFixture(
    dir,
    { "table1.xml": '<table><colorFilter dxfId="9"/></table>' },
    { "xl/worksheets/sheet1.xml": sheet },
  );

  await sanitizeDownloadedXlsx(path);
  assert.equal(await readPart(path, "xl/worksheets/sheet1.xml"), sheet);
});
