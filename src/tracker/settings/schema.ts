import { z } from "zod";

import type { OperatorSettingsOverride } from "../../domain/settings/types.js";

/**
 * Zod schema for the on-disk operator-settings OVERRIDE (`config/settings.json`).
 *
 * Every field is optional and every section is a `strictObject` so a typo'd key
 * fails loud on WRITE (the POST route rejects 400) — the same fail-soft-read /
 * fail-loud-write contract as the workflow-presentation override store. The
 * shape is validated against the shared {@link OperatorSettingsOverride} type via
 * `satisfies` so the schema and the contract can't drift.
 */

const dateString = z
  .string()
  .trim()
  .min(1)
  .regex(/^\d{1,2}\/\d{1,2}\/\d{4}$/, "expected M/D/YYYY or MM/DD/YYYY");

const nonNegInt = z.number().int().min(0);
const posInt = z.number().int().min(1);

export const OperatorSettingsOverrideSchema = z
  .strictObject({
    operator: z
      .strictObject({
        timekeeperName: z.string().trim().max(120),
      })
      .partial(),
    annualDates: z
      .strictObject({
        jobEndDate: dateString,
        kronosDefaultEndDate: dateString,
        kronosDefaultStartDate: dateString,
      })
      .partial(),
    display: z
      .strictObject({
        // Sane bounds: small enough to fit a laptop, capped well under an 8K wall.
        screenWidth: z.number().int().min(640).max(16_000),
        screenHeight: z.number().int().min(480).max(16_000),
      })
      .partial(),
    paths: z
      .strictObject({
        reportsDir: z.string().trim().max(1024),
        onboardingDocsDir: z.string().trim().max(1024),
      })
      .partial(),
    timeouts: z
      .strictObject({
        navigationMs: z.number().int().min(1_000).max(600_000),
        longNavigationMs: z.number().int().min(1_000).max(600_000),
      })
      .partial(),
    performance: z
      .strictObject({
        navigationRetries: z.number().int().min(1).max(50),
        separationTerminationWindowDays: nonNegInt.max(365),
      })
      .partial(),
    ocr: z
      .strictObject({
        secondOpinionMax: nonNegInt.max(100),
        pageMaxWaitMs: z.number().int().min(1_000).max(600_000),
        // 0 = Auto (let the pipeline use the vision-pool size).
        pageConcurrency: nonNegInt.max(64),
        disambigConcurrency: posInt.max(64),
        suggestConcurrency: posInt.max(64),
      })
      .partial(),
    features: z
      .strictObject({
        debugScreenshots: z.boolean(),
        duoWebAuthn: z.boolean(),
      })
      .partial(),
  })
  .partial() satisfies z.ZodType<OperatorSettingsOverride>;
