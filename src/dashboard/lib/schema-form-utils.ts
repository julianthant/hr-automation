/**
 * Schema-form utilities — pure helpers shared between SchemaForm.tsx and
 * RunnerDrawer.tsx. Kept separate from the components so they can be
 * reasoned about (and one day tested) without React in the loop.
 */

/** A subset of JSON Schema (Draft 2020-12) that we know how to render. */
export interface JsonSchema {
  type?: string | string[];
  format?: string;
  pattern?: string;
  enum?: unknown[];
  /** Nested object schema. */
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  /** Array item schema. */
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  default?: unknown;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  /** anyOf used by zod's `union` and `nullable()` lowering. */
  anyOf?: JsonSchema[];
  /** const used by zod's `literal()`. */
  const?: unknown;
}

/**
 * Heuristic: does this property name suggest a filesystem path?
 * Used to upgrade plain text inputs to file-picker-aware inputs. The browser
 * can't actually return absolute paths (security) so the picker just hints
 * what kind of value the operator should paste — but it still helps when
 * navigating to the right folder.
 */
export function isFilePathKey(key: string): boolean {
  return /(file|path|yaml)$/i.test(key);
}

/** Return the first non-undefined `type` from a schema (handles `string[]`). */
export function primaryType(schema: JsonSchema): string | undefined {
  if (Array.isArray(schema.type)) return schema.type[0];
  return schema.type;
}

/**
 * Walk an `anyOf` looking for the first non-null variant. Zod lowers
 * `z.string().nullable()` to `anyOf: [{ type: 'string' }, { type: 'null' }]`,
 * which we collapse here into the underlying type. Returns the original
 * schema unchanged when no `anyOf` is present.
 */
export function unwrapAnyOf(schema: JsonSchema): JsonSchema {
  if (!schema.anyOf || schema.anyOf.length === 0) return schema;
  // Prefer the first non-null variant; fallback to the first.
  const nonNull = schema.anyOf.find((s) => primaryType(s) !== "null");
  return nonNull ?? schema.anyOf[0];
}

/**
 * Default value for a schema's type — used to seed form state so React
 * inputs are always controlled.
 *   string  → ""
 *   number  → ""  (we coerce on submit; empty input is "")
 *   boolean → false
 *   array   → []
 *   object  → recursive default
 *   null/unknown → ""
 */
export function defaultForSchema(schema: JsonSchema): unknown {
  const s = unwrapAnyOf(schema);
  if (s.default !== undefined) return s.default;
  const t = primaryType(s);
  switch (t) {
    case "string":
      return "";
    case "integer":
    case "number":
      return "";
    case "boolean":
      return false;
    case "array":
      return [];
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(s.properties ?? {})) {
        out[k] = defaultForSchema(child);
      }
      return out;
    }
    default:
      return "";
  }
}

/**
 * Coerce a form value into the shape the schema expects. The form stores
 * everything as strings (because <input> does), but the backend's JSON body
 * needs typed values for `integer`, `number`, `boolean`, `array`.
 *
 * Returns the original value when no coercion is needed or possible.
 */
export function coerceValue(value: unknown, schema: JsonSchema): unknown {
  const s = unwrapAnyOf(schema);
  const t = primaryType(s);
  if (t === "integer" || t === "number") {
    if (value === "" || value === null || value === undefined) return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (t === "boolean") return Boolean(value);
  if (t === "array" && Array.isArray(value)) {
    const itemSchema = s.items;
    if (!itemSchema) return value;
    return value.map((v) => coerceValue(v, itemSchema));
  }
  if (t === "object" && typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, child] of Object.entries(s.properties ?? {})) {
      out[k] = coerceValue((value as Record<string, unknown>)[k], child);
    }
    return out;
  }
  return value;
}

/**
 * Does the schema mark this property as required? Reads from the parent's
 * `required` array (JSON Schema doesn't put it on the property itself).
 */
export function isRequired(parentSchema: JsonSchema, key: string): boolean {
  return Array.isArray(parentSchema.required) && parentSchema.required.includes(key);
}

/**
 * Strip empty values that aren't required, so the backend doesn't get
 * `{ middleName: "" }` when the operator left it blank.
 */
export function pruneEmpty(value: unknown, schema: JsonSchema): unknown {
  const s = unwrapAnyOf(schema);
  const t = primaryType(s);
  if (t === "object" && typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, child] of Object.entries(s.properties ?? {})) {
      const childVal = pruneEmpty((value as Record<string, unknown>)[k], child);
      const required = isRequired(s, k);
      if (required || (childVal !== undefined && childVal !== "")) {
        out[k] = childVal;
      }
    }
    return out;
  }
  return value;
}

/**
 * Title-case a JSON Schema property key for display. `effectiveDate` →
 * `Effective Date`, `empl_id` → `Empl Id`, `dob` stays `Dob` (we don't
 * embed a domain-specific abbreviation table here — the dashboard's
 * detailFields are server-supplied with explicit labels for that).
 */
export function humanizeKey(key: string): string {
  return key
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}
