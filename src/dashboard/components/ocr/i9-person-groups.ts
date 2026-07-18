/**
 * Per-PERSON grouping for the i9 OCR review — pure, unit-tested.
 *
 * A scanned I-9 packet holds two pages per person (the employer's Section 2
 * certification and the employee's Section 1), usually NON-adjacent (live
 * packet: Sanchez's Section 2 is page 1, his Section 1 page 9). The backend
 * pairs them by name (`corroborateI9Records` stamps `section2Page`); this
 * module turns that pairing into the review's render list so each person is
 * ONE section showing BOTH pages beside one record card — instead of the
 * generic one-section-per-page layout that scattered a person across the
 * packet.
 *
 * Rules:
 * - an `i9` record → one person section; pages [Section 2 (when paired),
 *   Section 1], sorted into the list by its earliest page.
 * - an orphan Section 2 record (employer sheet, no Section 1 anywhere) → a
 *   one-page person section of its own.
 * - a CLAIMED Section 2 record renders NO card of its own — its page image
 *   lives inside the claiming person's section.
 * - every other page keeps the generic per-page rendering (failed pages,
 *   empty pages, unclaimed `unknown` records like Lists of Acceptable
 *   Documents) so no page of the packet is hidden.
 */

export interface I9GroupableRecord {
  formKind?: string;
  sourcePage: number;
  section2Page?: number;
  /** Page of the person's SSN-bearing supplemental sheet, when paired. */
  ssnPage?: number;
  orphanSection2?: boolean;
}

export interface I9SectionPage {
  page: number;
  label: "Section 1" | "Section 2" | "SSN sheet";
}

/** Section 1 test — `"i9"` covers legacy pre-2026-07-17 rows. */
function isSection1Kind(formKind: string | undefined): boolean {
  return formKind === "i9 section 1" || formKind === "i9";
}

export type I9RenderEntry<TRecord, TFailedPage> =
  | {
      kind: "i9-person";
      pages: I9SectionPage[];
      record: TRecord;
      originalIndex: number;
      /** Earliest page of the section — the list sort key. */
      sortPage: number;
    }
  | { kind: "records"; page: number; group: Array<{ record: TRecord; originalIndex: number }> }
  | { kind: "failed"; page: number; failedPage: TFailedPage }
  | { kind: "empty"; page: number };

export function buildI9RenderList<TRecord extends I9GroupableRecord, TFailedPage>(args: {
  recordRows: Array<{ record: TRecord; originalIndex: number }>;
  failedPages: Array<TFailedPage & { page: number }>;
  emptyPages: number[];
  markedBlankPages: ReadonlySet<number>;
}): Array<I9RenderEntry<TRecord, TFailedPage>> {
  const { recordRows, failedPages, emptyPages, markedBlankPages } = args;
  const list: Array<I9RenderEntry<TRecord, TFailedPage>> = [];

  // Pages consumed by a person section (their own Section 1 page + the
  // Section 2 page they claimed) — those pages never render separately.
  const consumedPages = new Set<number>();
  for (const { record } of recordRows) {
    if (isSection1Kind(record.formKind)) {
      consumedPages.add(record.sourcePage);
      if (record.section2Page !== undefined) consumedPages.add(record.section2Page);
      if (record.ssnPage !== undefined) consumedPages.add(record.ssnPage);
    }
    if (record.orphanSection2) consumedPages.add(record.sourcePage);
  }

  const leftoverByPage = new Map<number, Array<{ record: TRecord; originalIndex: number }>>();
  for (const row of recordRows) {
    const { record } = row;
    if (isSection1Kind(record.formKind)) {
      const pages: I9SectionPage[] = [
        ...(record.section2Page !== undefined
          ? [{ page: record.section2Page, label: "Section 2" as const }]
          : []),
        ...(record.ssnPage !== undefined
          ? [{ page: record.ssnPage, label: "SSN sheet" as const }]
          : []),
        { page: record.sourcePage, label: "Section 1" as const },
      ];
      list.push({
        kind: "i9-person",
        pages,
        record,
        originalIndex: row.originalIndex,
        sortPage: Math.min(...pages.map((p) => p.page)),
      });
      continue;
    }
    if (record.orphanSection2) {
      list.push({
        kind: "i9-person",
        pages: [{ page: record.sourcePage, label: "Section 2" }],
        record,
        originalIndex: row.originalIndex,
        sortPage: record.sourcePage,
      });
      continue;
    }
    // A non-person record on a page some person section already shows: the
    // page image is visible there, and a claimed Section 2 record has no
    // standalone meaning — drop the duplicate card.
    if (consumedPages.has(record.sourcePage)) continue;
    // Unclaimed unknown page (list page, supplement) — keep per-page rendering.
    const existing = leftoverByPage.get(record.sourcePage);
    if (existing) existing.push(row);
    else leftoverByPage.set(record.sourcePage, [row]);
  }

  for (const [page, group] of leftoverByPage) list.push({ kind: "records", page, group });
  for (const fp of failedPages) list.push({ kind: "failed", page: fp.page, failedPage: fp });
  for (const p of emptyPages) {
    if (consumedPages.has(p) || leftoverByPage.has(p)) continue;
    if (markedBlankPages.has(p)) continue;
    list.push({ kind: "empty", page: p });
  }

  list.sort((a, b) => sortKey(a) - sortKey(b));
  return list;
}

function sortKey<TRecord, TFailedPage>(entry: I9RenderEntry<TRecord, TFailedPage>): number {
  return entry.kind === "i9-person" ? entry.sortPage : entry.page;
}

/** Every source page a person section renders — feeds the approval render gate. */
export function i9SectionPages<TRecord, TFailedPage>(
  entries: Array<I9RenderEntry<TRecord, TFailedPage>>,
): number[] {
  const pages: number[] = [];
  for (const entry of entries) {
    if (entry.kind === "i9-person") pages.push(...entry.pages.map((p) => p.page));
    else if (entry.kind === "records") pages.push(entry.page);
  }
  return pages;
}
