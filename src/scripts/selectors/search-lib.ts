// src/scripts/selectors/search-lib.ts
//
// Pure scoring + index logic for the selector-search CLI. No file I/O —
// callers load text content and pass it in as `IndexedItem[]`. Keeping the
// scorer pure makes it trivial to unit-test against fixtures.

export type ItemKind = "selector" | "lesson";

export interface IndexedItem {
  kind: ItemKind;
  system: string;          // e.g. "ucpath"
  title: string;           // selector FQN ("smartHR.tab.personalData") or lesson H2 text
  body: string;            // raw section markdown (used for body-token scoring)
  tags: string[];          // explicit tags from @tags / **Tags:** lines
  ref: string;             // file:line for click-through
}

export interface ScoredItem {
  item: IndexedItem;
  score: number;
}

/**
 * Tokenize text for indexing/scoring. Lowercase, split on non-word chars,
 * drop tokens shorter than 2 chars (mostly punctuation noise).
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

/**
 * Score a single indexed item against a tokenized query. Weights:
 *   - Title token match (substring or prefix): 3
 *   - Tag token match (substring or prefix): 2
 *   - Body token exact-match: 0.5
 *
 * Bidirectional substring (`title.includes(qt) || qt.includes(title)`) so
 * "comp rate" matches "compRateCodeInput" via prefix and "compensationRate"
 * via substring without needing stemming.
 */
export function scoreItem(item: IndexedItem, queryTokens: string[]): number {
  const titleTokens = tokenize(item.title);
  const tagTokens = item.tags.flatMap(tokenize);
  const bodyTokens = new Set(tokenize(item.body));

  let score = 0;
  for (const qt of queryTokens) {
    for (const tt of titleTokens) {
      if (tt === qt) score += 3;
      else if (tt.includes(qt) || qt.includes(tt)) score += 2;
    }
    for (const tg of tagTokens) {
      if (tg === qt) score += 2;
      else if (tg.includes(qt) || qt.includes(tg)) score += 1.5;
    }
    if (bodyTokens.has(qt)) score += 0.5;
  }
  return score;
}

/**
 * Rank items by score descending. Stable secondary sort by `kind` (selectors
 * before lessons) and then alphabetic by title so ties are deterministic.
 */
export function rank(items: IndexedItem[], query: string, limit = 10): ScoredItem[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const scored = items
    .map((item) => ({ item, score: scoreItem(item, queryTokens) }))
    .filter((x) => x.score > 0);

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.item.kind !== b.item.kind) return a.item.kind === "selector" ? -1 : 1;
    return a.item.title.localeCompare(b.item.title);
  });

  return scored.slice(0, limit);
}

/**
 * Parse a `SELECTORS.md` file into `IndexedItem[]`. Each H2 (`## ` line) starts
 * a new selector entry. Tags come from the optional `**Tags:** ...` line.
 * Source ref comes from the optional `**Source:** [`file:line`]` line.
 */
export function parseSelectorsMarkdown(system: string, md: string): IndexedItem[] {
  const sections = md.split(/^## /m).slice(1);
  const out: IndexedItem[] = [];
  for (const section of sections) {
    const lines = section.split("\n");
    const headerLine = lines[0];
    // Title pattern: `name()` — verified YYYY-MM-DD  OR  `group.member()` — verified ...
    const titleMatch = headerLine.match(/`([^`]+)`/);
    if (!titleMatch) continue;
    const title = titleMatch[1].replace(/\(\)$/, "");
    const body = section;
    const tagsMatch = body.match(/\*\*Tags:\*\*\s*(.+)/);
    const tags = tagsMatch
      ? tagsMatch[1].split(",").map((t) => t.trim()).filter(Boolean)
      : [];
    const refMatch = body.match(/\*\*Source:\*\*\s*\[`([^`]+)`\]/);
    const ref = refMatch ? refMatch[1] : `src/systems/${system}/selectors.ts`;
    out.push({ kind: "selector", system, title, body, tags, ref });
  }
  return out;
}

/**
 * Parse a `LESSONS.md` file into `IndexedItem[]`. Each H2 starts a lesson.
 * Title is the H2 line text (after the date prefix); tags come from the
 * required `**Tags:** ...` subsection.
 */
export function parseLessonsMarkdown(system: string, md: string): IndexedItem[] {
  const sections = md.split(/^## /m).slice(1);
  const out: IndexedItem[] = [];
  for (const section of sections) {
    const headerLine = section.split("\n")[0];
    const title = headerLine.replace(/^\d{4}-\d{2}-\d{2}\s*[—-]\s*/, "").trim();
    const body = section;
    const tagsMatch = body.match(/\*\*Tags:\*\*\s*(.+)/);
    const tags = tagsMatch
      ? tagsMatch[1].split(",").map((t) => t.trim()).filter(Boolean)
      : [];
    out.push({
      kind: "lesson",
      system,
      title,
      body,
      tags,
      ref: `src/systems/${system}/LESSONS.md`,
    });
  }
  return out;
}
