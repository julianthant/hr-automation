/** The token vocabulary available to custom templates. Documented in the modifier UI. */
export const KNOWN_TOKENS = [
  "name",
  "emplId",
  "email",
  "searchName",
  "pdfOriginalName",
  "label",
  "code",
  "HHMMSS",
  "runId4",
  "traceId",
  "id",
] as const;

const TOKEN_RE = /\{([a-zA-Z0-9]+)\}/g;

/** Token names referenced by a template, in order of first appearance. */
export function extractTokens(tpl: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of tpl.matchAll(TOKEN_RE)) {
    const tok = m[1];
    if (!seen.has(tok)) {
      seen.add(tok);
      out.push(tok);
    }
  }
  return out;
}

/**
 * Render a `{token}` template against a flat string record. Missing/empty token
 * values render empty; we then collapse the whitespace and trim dangling
 * separators (`()`, ` - `, ` · `) so "{name} ({emplId})" with no EID reads
 * "Jane Doe", not "Jane Doe ()". Pure; never throws on unknown tokens.
 */
export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  const raw = tpl.replace(TOKEN_RE, (_full, tok: string) => (vars[tok] ?? "").trim());
  return tidy(raw);
}

function tidy(s: string): string {
  return s
    .replace(/\(\s*\)/g, "") // empty parens
    .replace(/\[\s*\]/g, "")
    .replace(/\s*[-·|]\s*(?=$|[-·|])/g, "") // dangling separators next to each other / at end
    .replace(/^[\s\-·|]+|[\s\-·|]+$/g, "") // leading/trailing separators+space
    .replace(/\s{2,}/g, " ")
    .trim();
}
