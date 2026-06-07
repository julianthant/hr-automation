# crm — Selector Lessons

Structured record of selector mistakes and their fixes. Future Claude sessions should read this BEFORE re-mapping a selector. Before adding an entry, search for related guidance and update/merge stale or contradictory lessons; add a new bottom entry only for a genuinely new failure mode.

Each entry has the same shape so `npm run selector:search` can index it. Required fields: **Tried**, **Failed because**, **Fix**, **Tags**. Optional: **Selector** (if there's a registry entry), **References**.

---

## 2026-04-14 — Driving the iDocs PDF.js viewer is brittle and slow

**Tried:** Clicking through the PDF.js UI inside the Salesforce Canvas iframe (Next Doc, secondaryToolbarToggle, scroll, simulated download).
**Failed because:** The PDF.js viewer lives inside a nested iframe (`crickportal-ext.bfs.ucsd.edu/iDocsForSalesforce/Content/pdfjs/web/PDFjsViewer.aspx`) loaded via Salesforce Canvas. State tracking across nested frames is fragile, the Tools menu has no built-in download entry, and per-doc clicks add ~3s of wait each.
**Fix:** Skip the UI entirely. After the record page loads, find the PDF.js iframe via `page.frames().find(f => f.url().includes("crickportal-ext.bfs.ucsd.edu") && f.url().includes("/pdfjs/web/PDFjsViewer"))`, extract the `h=<hash>` query param, then fetch each PDF directly via `page.context().request.get("https://crickportal-ext.bfs.ucsd.edu/iDocsForSalesforce/iDocsForSalesforceDocumentServer?i=<idx>&h=<hash>")`. Browser-context cookies are reused. One HTTP round-trip per doc.
**Tags:** idocs, pdf, pdfjs, iframe, salesforce, canvas, download, fetch

## 2026-04-14 — Visualforce label selectors needed two strategies (extended 2026-06-07)

**Tried:** A single XPath like `//th[text()="Department"]/following-sibling::td[1]` for every Visualforce field extraction.
**Failed because:** Some Visualforce sections render the label inside a `<th class="labelCol">`, but other sections render it inside a plain `<td>` with no `<th>`. A single strategy missed the `<td>`-only labels.
**Fix:** Five strategies in `record`: `thLabelFollowingTd` (preferred — `<th>` anchor), `tdLabelFollowingTd` (plain `<td>` anchor), `cellLabelFollowingTd` (`.or()` of both for tag-variant rows — UNVERIFIED), `rowLabelLastCell` (row-scoped last-cell for non-adjacent value cells — UNVERIFIED), and `lightningFieldValue` (Salesforce Lightning `slds-form-element` layout — UNVERIFIED). `extractField(page, label)` in `extract.ts` tries each in order with a 500 ms timeout per attempt (reduced from 2 000 ms on 2026-06-07 — missing fields were costing up to 20 s; present elements resolve near-instantly). Strategies 3–5 are UNVERIFIED against the live CRM record page and need a live re-verify before bumping their `// verified` dates in `selectors.ts`.
**Selector:** `record.thLabelFollowingTd`, `record.tdLabelFollowingTd`, `record.cellLabelFollowingTd`, `record.rowLabelLastCell`, `record.lightningFieldValue` in `selectors.ts`
**Tags:** visualforce, label, extract, xpath, th, td, fallback, lightning, timeout, perf
