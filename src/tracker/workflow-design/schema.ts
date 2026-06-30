import { z } from "zod";

const designNodeType = z.enum([
  "row",
  "step",
  "delegationCoordinator",
  "prep",
  "member",
  "action",
  "custom",
  "note",
  "group",
]);

const position = z.strictObject({ x: z.number(), y: z.number() });

const intent = z.strictObject({
  label: z.string().optional(),
  description: z.string().optional(),
  look: z.string().optional(),
  behavior: z.string().optional(),
  references: z.array(z.string()).optional(),
  exampleData: z.record(z.string(), z.string()).optional(),
});

const designActionOp = z.strictObject({
  opId: z.string().min(1),
  kind: z.string().min(1),
  system: z.string().min(1),
  label: z.string().min(1),
  selectorFqn: z.string().optional(),
  role: z.string().optional(),
  accessibleName: z.string().optional(),
  inputVar: z.string().optional(),
  outputVar: z.string().optional(),
  url: z.string().optional(),
  note: z.string().optional(),
});

const designNode = z
  .strictObject({
    id: z.string().min(1),
    type: designNodeType,
    position,
    config: z.record(z.string(), z.unknown()).optional(),
    intent: intent.optional(),
    action: designActionOp.optional(),
    parentGroup: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.type === "action" && !val.action) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `action node "${val.id}" must have an action block`,
      });
    }
  });

// ── Data Bank schema (fail-soft read boundary — analogous to WorkflowDesignSchema) ──

const dataBankOperation = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  system: z.string().min(1),
  label: z.string().min(1),
});

const systemCatalog = z.object({
  system: z.string().min(1),
  label: z.string().min(1),
  operations: z.array(dataBankOperation),
});

const workflowDataBank = z.object({
  workflow: z.string().min(1),
  systems: z.array(z.string()),
  steps: z.array(z.unknown()),
});

export const DataBankSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  systems: z.array(systemCatalog),
  workflows: z.array(workflowDataBank),
});

const designEdge = z.strictObject({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  type: z.enum(["sequence", "delegation", "fold", "custom"]),
  label: z.string().optional(),
});

const styleIntent = z.strictObject({
  density: z.enum(["compact", "comfortable"]).optional(),
  accent: z.string().optional(),
  notes: z.string().optional(),
});

export const WorkflowDesignSchema = z.strictObject({
  schemaVersion: z.literal(1),
  workflow: z.string().min(1),
  generatedAt: z.string(),
  summary: z.string().optional(),
  canvas: z.strictObject({ zoom: z.number(), x: z.number(), y: z.number() }).optional(),
  nodes: z.array(designNode),
  edges: z.array(designEdge),
  style: styleIntent.optional(),
  notes: z.array(z.string()).optional(),
});
