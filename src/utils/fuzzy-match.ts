/**
 * Standard Levenshtein edit distance between two strings.
 *
 * Used to tolerate small spelling differences between names we extract
 * from upstream records (Kuali) vs names UCPath has stored (which may
 * be the "legal" spelling while the upstream has a typo — e.g.
 * "Aki Uchiha" vs "Aki Uchida" differs by 2 substitutions).
 *
 * O(m·n) time + space. Acceptable here because we compare short strings
 * (person names, typically <50 chars) against a small number of
 * candidates (≤15 Smart HR transactions at a time).
 */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i][j - 1], dp[i - 1][j]);
    }
  }
  return dp[m][n];
}

/**
 * Returns true if `a` and `b` are "close enough" — same first + last
 * token with a small edit distance allowance for typos. Case-insensitive.
 * Both arguments are expected to be person names; the function tolerates
 * either `"First Last"` or `"Last, First"` ordering by re-tokenising.
 *
 * Examples:
 *   fuzzyNameMatch("Aki Uchiha", "Aki Uchida") === true   (1 subst)
 *   fuzzyNameMatch("Uchiha, Aki", "Aki Uchida") === true  (flipped + fuzzy)
 *   fuzzyNameMatch("Aki", "Aki Uchida") === false         (token count differs)
 *   fuzzyNameMatch("Aki Chen", "Aki Uchida") === false    (too different)
 *
 * Threshold rationale: edit distance ≤ 2 on the last name catches the
 * common Kuali-vs-UCPath typo cases without matching unrelated people.
 */
export function fuzzyNameMatch(a: string, b: string, maxEditDistance: number = 2): boolean {
  const tokensA = nameTokens(a);
  const tokensB = nameTokens(b);
  if (tokensA.length === 0 || tokensB.length === 0) return false;
  // Same first token (exact) + fuzzy match on last token — cheap and high-precision.
  const firstA = tokensA[0].toLowerCase();
  const firstB = tokensB[0].toLowerCase();
  const lastA = tokensA[tokensA.length - 1].toLowerCase();
  const lastB = tokensB[tokensB.length - 1].toLowerCase();
  if (firstA === firstB && editDistance(lastA, lastB) <= maxEditDistance) return true;
  // Also accept the flipped pairing (first/last swapped in one of them).
  if (lastA === firstB && editDistance(firstA, lastB) <= maxEditDistance) return true;
  return false;
}

function nameTokens(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  // "Last, First [Middle...]"  →  ["First", "Middle...", "Last"]
  if (trimmed.includes(",")) {
    const [last, rest] = trimmed.split(",", 2);
    const firstPlus = (rest ?? "").trim().split(/\s+/).filter(Boolean);
    const lastName = last.trim();
    return [...firstPlus, lastName];
  }
  return trimmed.split(/\s+/).filter(Boolean);
}
