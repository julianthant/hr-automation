import { z } from "zod";

const titlePart = z
  .strictObject({
    scheme: z.enum(["person-name", "pdf-filename", "catalog-label", "batch-anchor", "custom-template"]),
    template: z.string().optional(),
  })
  .refine((p) => p.scheme !== "custom-template" || !!p.template, { message: "custom-template requires a template" });

const subtitlePart = z
  .strictObject({
    scheme: z.enum(["eid-else-trace", "trace-only", "eid-only", "email", "custom-template"]),
    template: z.string().optional(),
  })
  .refine((p) => p.scheme !== "custom-template" || !!p.template, { message: "custom-template requires a template" });

const tracePart = z
  .strictObject({
    scheme: z.enum(["code-time-runid", "custom-template"]),
    template: z.string().optional(),
  })
  .refine((p) => p.scheme !== "custom-template" || !!p.template, { message: "custom-template requires a template" });

const namingConfig = z.strictObject({ title: titlePart.optional(), subtitle: subtitlePart.optional(), trace: tracePart.optional() });

const stepRule = z.strictObject({
  step: z.string().min(1),
  hidden: z.boolean().optional(),
  label: z.string().optional(),
  foldInto: z.string().optional(),
});
const stepDisplay = z.strictObject({ order: z.array(z.string()).optional(), rules: z.array(stepRule).optional() });

const delegationDisplay = z.strictObject({
  memberTitle: titlePart.optional(),
  memberSubtitle: subtitlePart.optional(),
  prepTitle: titlePart.optional(),
  coordinatorLabelSuffix: z.string().optional(),
});

const presentationConfig = z.strictObject({
  naming: namingConfig.optional(),
  steps: stepDisplay.optional(),
  delegation: delegationDisplay.optional(),
});

const detailField = z.strictObject({
  key: z.string(),
  label: z.string(),
  editable: z.boolean().optional(),
  displayInGrid: z.boolean().optional(),
  multiline: z.boolean().optional(),
  conditional: z.boolean().optional(),
  inputKind: z.enum(["text", "id", "date"]).optional(),
  group: z.string().optional(),
});
const preset = z.strictObject({ id: z.string(), label: z.string(), skipSteps: z.array(z.string()), description: z.string().optional() });

export const WorkflowOverrideSchema = z.strictObject({
  label: z.string().optional(),
  category: z.string().optional(),
  iconName: z.string().optional(),
  detailFields: z.array(detailField).optional(),
  presets: z.array(preset).optional(),
  presentation: presentationConfig.optional(),
});
