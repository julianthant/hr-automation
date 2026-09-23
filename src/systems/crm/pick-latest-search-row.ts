export interface CrmSearchRowPickInput {
  hasNameLink: boolean;
  offerSentOn: string;
  processStage: string;
}

const DEAD_ONBOARDING_STAGE = /rescinded|cancelled|canceled|withdrawn/i;

/**
 * Choose which CRM onboarding search row to open.
 *
 * The results table includes a header-ish "Search Results" row with no record
 * link. Offer Sent On dates can also land on a later *rescinded* offer that
 * has no iDocs viewer — skip those and take the latest live record.
 */
export function pickLatestOnboardingSearchRowIndex(rows: CrmSearchRowPickInput[]): number {
  const linked = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.hasNameLink);
  if (linked.length === 0) {
    throw new Error(
      "CRM search rows had no record links (page still loading or header-only).",
    );
  }

  const eligible = linked.filter(({ row }) => !isDeadOnboardingStage(row.processStage));
  if (eligible.length === 0) {
    throw new Error(
      `CRM search matched ${linked.length} record(s) but every one is a dead stage ` +
        `(${linked.map(({ row }) => row.processStage || "<blank>").join(", ")}).`,
    );
  }

  let latestIndex = -1;
  let latestDate = new Date(0);
  for (const { row, index } of eligible) {
    const parsed = parseOfferSentOn(row.offerSentOn);
    if (!parsed) continue;
    if (parsed > latestDate) {
      latestDate = parsed;
      latestIndex = index;
    }
  }
  if (latestIndex !== -1) return latestIndex;
  if (eligible.length === 1) return eligible[0].index;
  throw new Error(
    "CRM returned search rows but no parsable Offer Sent On date — check table format or locale.",
  );
}

export function isDeadOnboardingStage(stage: string): boolean {
  return DEAD_ONBOARDING_STAGE.test(stage);
}

function parseOfferSentOn(text: string): Date | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
