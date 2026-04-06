# Tracker Module

Excel spreadsheet tracking with daily worksheet tabs using ExcelJS.

## Files

- `spreadsheet.ts` — `appendRow(filePath, columns, data)` and `parseDepartmentNumber(deptText)`
- `index.ts` — Barrel re-exports

## `appendRow(filePath, columns, data)`

Appends a single row to an `.xlsx` file. Creates the file and/or worksheet if missing. Worksheet name is today's date as `YYYY-MM-DD`.

- `columns: ColumnDef[]` — `{ header, key, width }`
- `data: Record<string, string>` — values keyed by `column.key`

## `parseDepartmentNumber(deptText)`

Extracts 4-6 digit department number from parenthesized text. Returns last match if multiple parens exist.

`"Computer Science (000412)"` → `"000412"`

## Gotchas

- **Critical ExcelJS quirk**: After `readFile()`, ExcelJS loses column key mappings. Code re-applies keys in a loop — without this, `addRow(data)` won't map object keys correctly.
- Date uses `new Date().toISOString().slice(0, 10)` — system clock, no timezone awareness
- Department regex requires parentheses: won't match bare `"000412"`
- Tracker `.xlsx` files belong inside their workflow folder (e.g., `src/workflows/eid-lookup/eid-lookup-tracker.xlsx`), never in project root
