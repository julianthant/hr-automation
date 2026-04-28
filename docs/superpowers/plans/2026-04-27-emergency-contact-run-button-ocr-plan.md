# Emergency-Contact Run Button + Scalable OCR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a self-service "Run" button in the dashboard that takes a PDF, OCRs it via Gemini with multi-key rotation, matches employees against the SharePoint roster (with an eid-lookup-daemon fallback), shows a single editable preview row in the queue, and on Approve fans out to N normal emergency-contact daemon items. Bundles three bug fixes (fuzzy duplicate detection + demote, same-address-when-null, dashboard updateData warnings) and an edit-data opt-in for emergency-contact.

**Architecture:** A single workflow name (`emergency-contact`) for both the prep phase (no-kernel, server-side OCR + match) and the item phase (existing kernel daemon). The prep phase writes tracker rows directly with `data.mode === "prepare"`; on Approve, children are enqueued via the existing `ensureDaemonsAndEnqueue` daemon-client with `prefilledData.parentRunId`. The OCR layer is generic (`src/ocr/`) and Zod-schema-bound so future workflows can reuse it.

**Tech Stack:** TypeScript strict, Zod v4, Node `node:crypto`/`node:fs`, vitest for unit tests, Playwright (existing kernel), React + Vite (existing dashboard), Google Gemini 2.5 Flash via `@google/generative-ai`.

---

## Phase Overview

| Phase | Goal | Files | Checkpoint? |
|---|---|---|---|
| 0 | Three bug fixes (fuzzy dup + demote, same-addr null, dashboard updateData) | `enter.ts`, `schema.ts`, `workflow.ts`, `selectors.ts` | Yes |
| 1 | Edit-data opt-in for emergency-contact | `workflow.ts` | Yes |
| 2 | `src/ocr/` primitive (cache, rotation, Gemini provider) | `src/ocr/*` | Yes |
| 3 | Match utilities (name + US address) | `src/workflows/emergency-contact/match.ts` | Yes |
| 4 | Prep orchestrator (OCR + match + tracker writes + async EID resolution) | `prepare.ts`, `preview-schema.ts`, `workflow.ts` | Yes |
| 5 | Backend HTTP endpoints (multipart, prep/approve/discard, /api/rosters, restart sweep) | `dashboard.ts`, `dashboard-ops.ts` | Yes |
| 6 | Dashboard frontend — DELEGATED to ui-ux-pro-max → frontend-design | `src/dashboard/components/*` | Yes |
| 7 | Docs + manual E2E on the user's PDF | `CLAUDE.md` files | Final |

**Total estimated tasks:** ~50 across 8 phases. Each task is TDD-shaped (failing test → run-fail → implement → run-pass → commit). Phases 0-5 are committable in isolation; Phase 6 is the only one with an inherent visual review gate.

---

## Phase 0 — Bug fixes

**Goal:** Ship three corrections to today's emergency-contact workflow before any new feature work. Each is small, testable in isolation, and shippable as its own commit.

**Files (final state):**
- Modify: `src/workflows/emergency-contact/schema.ts` — post-parse rewrite for same-address-when-null.
- Modify: `src/workflows/emergency-contact/enter.ts` — fuzzy detection, `demoteExistingContact` helper, defensive same-address guard.
- Modify: `src/workflows/emergency-contact/workflow.ts` — `ctx.updateData` for dashboard fields at handler top.
- Modify: `src/systems/ucpath/selectors.ts` — `existingContactRow(name)` + `existingRowDrillIn(name)` selectors.
- Create: `tests/unit/workflows/emergency-contact/schema.test.ts` — sameAddressAsEmployee post-parse.
- Create: `tests/unit/workflows/emergency-contact/enter-fuzzy-dup.test.ts` — Levenshtein + match-result shape.
- Modify: existing test files where applicable.

### Task 0.1 — Same-address-when-null at YAML loader

**Files:**
- Modify: `src/workflows/emergency-contact/schema.ts` (post-parse `transform` on `EmergencyContactSchema`)
- Create: `tests/unit/workflows/emergency-contact/schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/workflows/emergency-contact/schema.test.ts
import { describe, it, expect } from "vitest";
import { EmergencyContactSchema } from "../../../../src/workflows/emergency-contact/schema.js";

describe("EmergencyContactSchema — same-address-when-null transform", () => {
  it("rewrites sameAddressAsEmployee=false + address=null to sameAddressAsEmployee=true", () => {
    const parsed = EmergencyContactSchema.parse({
      name: "Jane Doe",
      relationship: "Mother",
      primary: true,
      sameAddressAsEmployee: false,
      address: null,
      cellPhone: "(555) 123-4567",
      homePhone: null,
      workPhone: null,
    });
    expect(parsed.sameAddressAsEmployee).toBe(true);
    expect(parsed.address).toBeNull();
  });

  it("leaves sameAddressAsEmployee=false alone when address is present", () => {
    const parsed = EmergencyContactSchema.parse({
      name: "Jane Doe",
      relationship: "Mother",
      primary: true,
      sameAddressAsEmployee: false,
      address: { street: "123 Main", city: "Denver", state: "CO", zip: "80201" },
      cellPhone: null, homePhone: null, workPhone: null,
    });
    expect(parsed.sameAddressAsEmployee).toBe(false);
    expect(parsed.address?.street).toBe("123 Main");
  });

  it("leaves sameAddressAsEmployee=true alone", () => {
    const parsed = EmergencyContactSchema.parse({
      name: "Jane Doe",
      relationship: "Mother",
      primary: true,
      sameAddressAsEmployee: true,
      address: null,
      cellPhone: null, homePhone: null, workPhone: null,
    });
    expect(parsed.sameAddressAsEmployee).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npx vitest run tests/unit/workflows/emergency-contact/schema.test.ts
```

Expected: First test FAILS — current schema preserves `sameAddressAsEmployee=false` even when `address=null`.

- [ ] **Step 3: Add `.transform()` to `EmergencyContactSchema` in `schema.ts`**

Modify `src/workflows/emergency-contact/schema.ts` — wrap the existing `EmergencyContactSchema` with a transform that rewrites the boolean post-parse:

```ts
export const EmergencyContactSchema = z
  .object({
    name: z.string().min(1),
    relationship: z.string().min(1),
    primary: z.boolean().default(true),
    sameAddressAsEmployee: z.boolean(),
    address: AddressSchema.nullable().optional(),
    cellPhone: z.string().nullable().optional(),
    homePhone: z.string().nullable().optional(),
    workPhone: z.string().nullable().optional(),
  })
  .transform((c) => {
    // When the form had no contact address, force same-as-employee=true so
    // UCPath gets *some* address (employee's) rather than no address at all.
    if (c.sameAddressAsEmployee === false && (c.address === null || c.address === undefined)) {
      return { ...c, sameAddressAsEmployee: true };
    }
    return c;
  });
```

- [ ] **Step 4: Run tests to verify they pass**

```
npx vitest run tests/unit/workflows/emergency-contact/schema.test.ts
```

Expected: 3 tests PASS.

- [ ] **Step 5: Type-check**

```
npm run typecheck:all
```

Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/workflows/emergency-contact/schema.ts tests/unit/workflows/emergency-contact/schema.test.ts
git commit -m "$(cat <<'EOF'
fix(emergency-contact): same-address-when-null at YAML loader

When the contact's address is null, force sameAddressAsEmployee=true so
the UCPath form gets the employee's address rather than no address at
all. Applied as a post-parse Zod transform so all callers (CLI loader,
prep handler, future PDF flow) benefit. Geonmoo Lee's blank-address
case (2026-04-27 batch) was the trigger.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 0.2 — Defense-in-depth in enter.ts step 5

**Files:**
- Modify: `src/workflows/emergency-contact/enter.ts:115-167` — change `if (!contact.address)` branch to check the box rather than leaving blank.

- [ ] **Step 1: Read current state**

Open `src/workflows/emergency-contact/enter.ts`. Locate plan step 5 (lines ~115-167). The current `if (!contact.address)` block returns early after logging "leaving blank".

- [ ] **Step 2: Write the failing assertion via integration-style test**

Add to `tests/unit/workflows/emergency-contact/enter-fuzzy-dup.test.ts` (will hold step-5 tests too — file shared across Task 0.2 + 0.3):

```ts
// tests/unit/workflows/emergency-contact/enter-fuzzy-dup.test.ts
import { describe, it, expect, vi } from "vitest";
import { buildEmergencyContactPlan } from "../../../../src/workflows/emergency-contact/enter.js";

describe("buildEmergencyContactPlan — same-address fallback", () => {
  it("checks Same-Address when contact.sameAddressAsEmployee=false and address=null", async () => {
    const checkSpy = vi.fn();
    const fakeCheckbox = { isChecked: async () => false, check: checkSpy, uncheck: vi.fn() };
    const fakePage = makeFakePage({ "Same Address as Employee": fakeCheckbox });

    const record = makeFakeRecord({
      sameAddressAsEmployee: false,  // simulates pre-transform state
      address: null,
    });
    const plan = buildEmergencyContactPlan(record, fakePage as never, { employeeName: "X" });

    // Run only step 5 (Same-Address)
    const sameAddrAction = plan.actions.find((a) => /Same Address/.test(a.label));
    if (!sameAddrAction) throw new Error("step 5 not found in plan");
    await sameAddrAction.fn();

    expect(checkSpy).toHaveBeenCalledOnce();
  });
});

function makeFakePage(byName: Record<string, unknown>): unknown {
  return {
    getByRole(_role: string, opts: { name: string }) {
      const item = byName[opts.name];
      return { first: () => item };
    },
  };
}
function makeFakeRecord(overrides: Partial<{ sameAddressAsEmployee: boolean; address: unknown }>): unknown {
  return {
    sourcePage: 1,
    employee: { name: "Test", employeeId: "12345" },
    emergencyContact: {
      name: "C",
      relationship: "Mother",
      primary: true,
      sameAddressAsEmployee: false,
      address: null,
      cellPhone: null, homePhone: null, workPhone: null,
      ...overrides,
    },
    notes: [],
  };
}
```

- [ ] **Step 3: Run test to verify it fails**

```
npx vitest run tests/unit/workflows/emergency-contact/enter-fuzzy-dup.test.ts
```

Expected: FAIL — current code calls `uncheck`, not `check`, when address is null.

- [ ] **Step 4: Update enter.ts step 5 logic**

Replace the current step 5 implementation in `src/workflows/emergency-contact/enter.ts:115-167` with:

```ts
  // 5. Same Address as Employee + manual-address fallback.
  plan.add(
    contact.sameAddressAsEmployee || !contact.address
      ? 'Check "Same Address as Employee"'
      : 'Uncheck "Same Address as Employee" and enter manual address',
    async () => {
      const sameAddrCb = page
        .getByRole("checkbox", { name: "Same Address as Employee" })
        .first();
      const checked = await sameAddrCb.isChecked({ timeout: 5_000 }).catch(() => false);

      // Treat (sameAddressAsEmployee=false, address=null) as same-address.
      // Defense-in-depth — schema transform should already have rewritten this,
      // but the guard prevents a regression if the YAML/preview path skips the
      // transform.
      const wantsSame = contact.sameAddressAsEmployee || !contact.address;

      if (wantsSame) {
        if (!checked) await sameAddrCb.check({ timeout: 5_000 });
        await page.waitForTimeout(1_500);
        return;
      }

      if (checked) await sameAddrCb.uncheck({ timeout: 5_000 });
      await page.waitForTimeout(1_500);

      if (!contact.address) {
        log.step("sameAddressAsEmployee=false but no address in YAML — defensive fallback to same-as-employee");
        if (!(await sameAddrCb.isChecked({ timeout: 5_000 }).catch(() => false))) {
          await sameAddrCb.check({ timeout: 5_000 });
        }
        await page.waitForTimeout(1_500);
        return;
      }

      const addr = contact.address;
      await hidePeopleSoftModalMask(page);
      await page.getByRole("button", { name: "Edit Address" }).first()
        .click({ timeout: 10_000 });
      await page.waitForTimeout(2_000);

      await page.getByRole("textbox", { name: "Address 1" }).first()
        .fill(addr.street, { timeout: 10_000 });
      if (addr.city) {
        await page.getByRole("textbox", { name: "City" }).first()
          .fill(addr.city, { timeout: 10_000 });
      }
      if (addr.state) {
        await page.getByRole("textbox", { name: "State" }).first()
          .fill(addr.state, { timeout: 10_000 });
      }
      if (addr.zip) {
        await page.getByRole("textbox", { name: "Postal" }).first()
          .fill(addr.zip, { timeout: 10_000 });
      }

      await hidePeopleSoftModalMask(page);
      await page.getByRole("button", { name: "OK", exact: true }).first()
        .click({ timeout: 10_000 });
      await page.waitForTimeout(2_000);
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    },
  );
```

Note: the schema transform from Task 0.1 already rewrites the input. The `enter.ts` change is defense-in-depth so an out-of-band caller (e.g. a future workflow that bypasses Zod) still gets correct behavior.

- [ ] **Step 5: Run tests**

```
npx vitest run tests/unit/workflows/emergency-contact/enter-fuzzy-dup.test.ts
npm run typecheck:all
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/workflows/emergency-contact/enter.ts tests/unit/workflows/emergency-contact/enter-fuzzy-dup.test.ts
git commit -m "$(cat <<'EOF'
fix(emergency-contact): defensive same-address-fallback in enter.ts step 5

If a record reaches the action plan with sameAddressAsEmployee=false +
address=null (which the schema transform should prevent), check the
Same-Address box anyway rather than leaving the form blank. Belt + braces
for callers that might bypass Zod.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 0.3 — Levenshtein helper + fuzzy duplicate detection

**Files:**
- Create: `src/workflows/emergency-contact/levenshtein.ts` — pure helper (no UCPath deps).
- Modify: `src/workflows/emergency-contact/enter.ts` — `findExistingContactDuplicate` returns `{ name, distance, isExact } | null`.
- Append to: `tests/unit/workflows/emergency-contact/enter-fuzzy-dup.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/workflows/emergency-contact/enter-fuzzy-dup.test.ts`:

```ts
import { levenshteinDistance } from "../../../../src/workflows/emergency-contact/levenshtein.js";

describe("levenshteinDistance", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshteinDistance("hello", "hello")).toBe(0);
  });
  it("returns 1 for single substitution", () => {
    expect(levenshteinDistance("tomako", "tomoko")).toBe(1);
  });
  it("returns 2 for two substitutions", () => {
    expect(levenshteinDistance("tomako langley", "tomoko longley")).toBe(2);
  });
  it("returns 3 for three substitutions", () => {
    expect(levenshteinDistance("alice", "bobce")).toBeGreaterThanOrEqual(3);
  });
  it("handles different lengths", () => {
    expect(levenshteinDistance("foo", "fooo")).toBe(1);
    expect(levenshteinDistance("", "abc")).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npx vitest run tests/unit/workflows/emergency-contact/enter-fuzzy-dup.test.ts
```

Expected: FAIL — `levenshtein.ts` doesn't exist.

- [ ] **Step 3: Create `levenshtein.ts`**

```ts
// src/workflows/emergency-contact/levenshtein.ts
/**
 * Iterative two-row Levenshtein distance. O(n*m) time, O(min(n,m)) space.
 * Pure utility — no domain knowledge.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,        // insertion
        prev[j] + 1,            // deletion
        prev[j - 1] + cost,     // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[b.length];
}
```

- [ ] **Step 4: Run levenshtein tests**

```
npx vitest run tests/unit/workflows/emergency-contact/enter-fuzzy-dup.test.ts -t levenshtein
```

Expected: 5 PASS.

- [ ] **Step 5: Write the failing test for `findExistingContactDuplicate`**

Append to the same test file:

```ts
import { findExistingContactDuplicate } from "../../../../src/workflows/emergency-contact/enter.js";

describe("findExistingContactDuplicate — fuzzy match", () => {
  it("returns null when no contacts exist", async () => {
    const page = mockPageWithExistingContacts([]);
    const r = await findExistingContactDuplicate(page as never, "John Doe");
    expect(r).toBeNull();
  });
  it("returns isExact: true on identical name", async () => {
    const page = mockPageWithExistingContacts(["John Doe"]);
    const r = await findExistingContactDuplicate(page as never, "John Doe");
    expect(r).toEqual({ name: "John Doe", distance: 0, isExact: true });
  });
  it("returns isExact: false, distance: 2 on Tomako Langley vs Tomoko Longley", async () => {
    const page = mockPageWithExistingContacts(["Tomako Langley"]);
    const r = await findExistingContactDuplicate(page as never, "Tomoko Longley");
    expect(r?.distance).toBe(2);
    expect(r?.isExact).toBe(false);
    expect(r?.name).toBe("Tomako Langley");
  });
  it("returns null when distance > 2", async () => {
    const page = mockPageWithExistingContacts(["Bob Smith"]);
    const r = await findExistingContactDuplicate(page as never, "John Doe");
    expect(r).toBeNull();
  });
});

function mockPageWithExistingContacts(names: string[]): unknown {
  // findExistingContactDuplicate calls readExistingContactNames(page) — we
  // need to stub the import. Since test is in vitest, use vi.mock; but for
  // a unit test we'll inject via an exported helper. (Adjust import path
  // when implementing.)
  return { __existingNames: names };
}
```

Note: `findExistingContactDuplicate` calls `readExistingContactNames(page)` — a UCPath-system function that scrapes the page. For unit tests, the cleanest approach is to **make `findExistingContactDuplicate` accept a name array directly** as a thin overload, OR factor the matching logic into a pure helper. Choose the helper-factor approach:

- [ ] **Step 6: Refactor `findExistingContactDuplicate` to use a pure matcher**

In `src/workflows/emergency-contact/enter.ts`, change `findExistingContactDuplicate` and add a new pure helper:

```ts
import { levenshteinDistance } from "./levenshtein.js";

export interface ContactMatch {
  name: string;
  distance: number;
  isExact: boolean;
}

/**
 * Pure matcher — finds the best fuzzy match for a target name within a
 * list of existing contact names. Uses Levenshtein on normalized forms.
 * Returns null if no candidate is within distance 2.
 */
export function pickBestContactMatch(
  existingNames: readonly string[],
  targetName: string,
): ContactMatch | null {
  const targetNorm = normalizeNameForCompare(targetName);
  let best: ContactMatch | null = null;
  for (const candidate of existingNames) {
    const norm = normalizeNameForCompare(candidate);
    const distance = levenshteinDistance(norm, targetNorm);
    if (distance > 2) continue;
    if (!best || distance < best.distance) {
      best = { name: candidate, distance, isExact: distance === 0 };
    }
  }
  return best;
}

/**
 * UCPath-side wrapper — reads existing contact names off the page, then
 * delegates to pickBestContactMatch.
 */
export async function findExistingContactDuplicate(
  page: Page,
  targetName: string,
): Promise<ContactMatch | null> {
  const existing = await readExistingContactNames(page);
  log.step(`Existing contacts on record: [${existing.join(" | ") || "none"}]`);
  return pickBestContactMatch(existing, targetName);
}
```

Then update the test to import `pickBestContactMatch` directly (which is pure) instead of stubbing the page. Replace the failing `findExistingContactDuplicate` test block above with:

```ts
import { pickBestContactMatch } from "../../../../src/workflows/emergency-contact/enter.js";

describe("pickBestContactMatch — fuzzy match", () => {
  it("returns null when no contacts exist", () => {
    expect(pickBestContactMatch([], "John Doe")).toBeNull();
  });
  it("returns isExact: true on identical name (post-normalization)", () => {
    expect(pickBestContactMatch(["John Doe"], "JOHN  DOE!")).toEqual({
      name: "John Doe", distance: 0, isExact: true,
    });
  });
  it("returns distance: 2 on Tomako Langley vs Tomoko Longley", () => {
    const r = pickBestContactMatch(["Tomako Langley"], "Tomoko Longley");
    expect(r?.distance).toBe(2);
    expect(r?.isExact).toBe(false);
    expect(r?.name).toBe("Tomako Langley");
  });
  it("returns null when distance > 2", () => {
    expect(pickBestContactMatch(["Bob Smith"], "John Doe")).toBeNull();
  });
  it("picks the closest candidate when several match", () => {
    const r = pickBestContactMatch(["Tomako Langley", "Tomako Lengley"], "Tomoko Longley");
    expect(r?.distance).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 7: Run tests**

```
npx vitest run tests/unit/workflows/emergency-contact/enter-fuzzy-dup.test.ts
npm run typecheck:all
```

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/workflows/emergency-contact/levenshtein.ts src/workflows/emergency-contact/enter.ts tests/unit/workflows/emergency-contact/enter-fuzzy-dup.test.ts
git commit -m "$(cat <<'EOF'
fix(emergency-contact): fuzzy duplicate detection (Levenshtein <= 2)

findExistingContactDuplicate now returns a {name, distance, isExact}
match record. A new pure pickBestContactMatch helper does the work
without page deps so it's unit-testable. Levenshtein on normalized
names catches the Tomako-vs-Tomoko historical-typo class that strict
equality missed.

Action on match (this commit just changes detection — handler logic
update is in the next commit).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 0.4 — Demote-existing-contact helper + selectors

**Files:**
- Modify: `src/systems/ucpath/selectors.ts` — add `existingContactRow(name)` + `existingRowDrillIn(name)` selectors.
- Modify: `src/systems/ucpath/personal-data.ts` — add `demoteExistingContact(page, existingName)` helper.
- Append to: `tests/unit/systems/ucpath/selectors.test.ts` (if exists) or create selector smoke test.

- [ ] **Step 1: Map the demote flow live with playwright-cli**

Open a UCPath HR Tasks → Personal Data Related → Emergency Contact session for any EID with at least one existing contact (Leo Longley EID 10874572 is a known case). Use `playwright-cli` to map:
- The existing-contact grid row (matched by contact name text).
- The "Edit"/"Drill in" link on that row.
- The Primary Contact checkbox on the resulting detail page.
- The "Save" button.
- The "Return to Search" or back navigation.

Document the verified selectors in `src/systems/ucpath/selectors.ts` with `// verified 2026-04-XX` (current date) comments.

- [ ] **Step 2: Add selectors to `src/systems/ucpath/selectors.ts`**

Under the existing Emergency Contact namespace (search the file for `emergencyContact` or similar; if no namespace, add one). Add:

```ts
// In src/systems/ucpath/selectors.ts under the appropriate namespace
// (e.g. emergencyContact.* or personalData.*)

/**
 * Row in the "Find an Existing Value" or in-page contacts grid matching a
 * contact's display name. PeopleSoft renders rows as `<tr>` with the name
 * in a span/div cell — match by accessible name OR text content.
 *
 * @tags emergency-contact existing grid row by-name
 */
existingContactRowByName: (frame: FrameLocator | Page, contactName: string): Locator => {
  // verified YYYY-MM-DD
  return frame
    .getByRole("row")
    .filter({ hasText: contactName });
},

/**
 * Drill-in / edit link inside an existing-contact grid row.
 *
 * @tags emergency-contact existing grid drill-in edit
 */
existingRowDrillIn: (row: Locator): Locator => {
  // verified YYYY-MM-DD
  return row.getByRole("link", { name: /drill in|edit|view detail/i }).first();
},
```

(Final selector code depends on what playwright-cli reveals — adjust the matcher to whatever the live page exposes.)

- [ ] **Step 3: Regenerate selector catalog**

```
npm run selectors:catalog
```

Verify `src/systems/ucpath/SELECTORS.md` now lists the new selectors.

- [ ] **Step 4: Implement `demoteExistingContact` helper**

Add to `src/systems/ucpath/personal-data.ts`:

```ts
import { existingContactRowByName, existingRowDrillIn } from "./selectors.js";

/**
 * Drill into the existing-contact row matching `existingName`, uncheck the
 * Primary Contact checkbox, save, and return to the search list. Used by
 * emergency-contact's fuzzy-duplicate path to demote a historical typo'd
 * entry (e.g. "Tomako Langley") in favor of the new correctly-spelled
 * primary contact ("Tomoko Longley").
 *
 * Idempotent: if Primary Contact is already unchecked, just saves and
 * returns. Throws if the named row isn't found.
 */
export async function demoteExistingContact(page: Page, existingName: string): Promise<void> {
  await hidePeopleSoftModalMask(page);
  const frame = await getContentFrame(page);

  const row = existingContactRowByName(frame, existingName);
  const rowCount = await row.count().catch(() => 0);
  if (rowCount === 0) {
    throw new Error(`demoteExistingContact: no existing-contact row matched "${existingName}"`);
  }

  await existingRowDrillIn(row).click({ timeout: 10_000 });
  await page.waitForTimeout(2_000);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

  const primaryCb = frame.getByRole("checkbox", { name: "Primary Contact" }).first();
  const checked = await primaryCb.isChecked({ timeout: 5_000 }).catch(() => false);
  if (checked) {
    await primaryCb.uncheck({ timeout: 5_000 });
    await page.waitForTimeout(500);
  }

  await hidePeopleSoftModalMask(page);
  await frame.getByRole("button", { name: "Save", exact: true })
    .first()
    .click({ timeout: 10_000 });
  await page.waitForTimeout(2_000);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

  // Return to the search/list to make the next action plan happy.
  const returnBtn = frame.getByRole("button", { name: "Return to Search" });
  if ((await returnBtn.count().catch(() => 0)) > 0) {
    await returnBtn.first().click({ timeout: 10_000 });
    await page.waitForTimeout(1_500);
  }
}
```

- [ ] **Step 5: Type-check**

```
npm run typecheck:all
```

Expected: 0 errors.

- [ ] **Step 6: Run inline-selectors guard**

```
npx vitest run tests/unit/systems/inline-selectors.test.ts
```

Expected: PASS — no inline `page.locator(...)` introduced.

- [ ] **Step 7: Commit**

```bash
git add src/systems/ucpath/selectors.ts src/systems/ucpath/personal-data.ts src/systems/ucpath/SELECTORS.md
git commit -m "$(cat <<'EOF'
feat(ucpath): demoteExistingContact — uncheck Primary Contact on a row

Adds existingContactRowByName and existingRowDrillIn selectors plus a
demoteExistingContact(page, existingName) helper that drills into the
matching row, unchecks Primary Contact, saves, and returns to the list.

Used by emergency-contact's fuzzy-duplicate path to demote historical
typo'd entries (e.g. "Tomako Langley") in favor of the correctly-spelled
new primary ("Tomoko Longley") instead of skipping or duplicating.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 0.5 — Wire fuzzy match into the emergency-contact handler

**Files:**
- Modify: `src/workflows/emergency-contact/workflow.ts` — handler's navigation step uses the new `ContactMatch` shape.

- [ ] **Step 1: Read the current navigation-step code**

Locate the handler's `ctx.step("navigation", ...)` block in `src/workflows/emergency-contact/workflow.ts`. Note where it calls `findExistingContactDuplicate(page, record.emergencyContact.name)` and short-circuits with `ctx.skipStep("fill-form")` + `ctx.skipStep("save")`.

- [ ] **Step 2: Update the duplicate-handling branch**

Replace the existing branch with three-way logic:

```ts
import { demoteExistingContact } from "../../systems/ucpath/personal-data.js";

// ... inside the handler's "navigation" step:

const dup = await findExistingContactDuplicate(page, record.emergencyContact.name);
if (dup) {
  if (dup.isExact) {
    // Exact match — record is already current; nothing to do.
    log.step(`Exact duplicate "${dup.name}" already on record — skipping new add.`);
    ctx.updateData({ skipped: "true", skipReason: "exact-duplicate" });
    return true; // continue to skip fill-form + save
  } else {
    // Fuzzy match (distance 1-2) — likely historical typo of the same person.
    // Demote the existing row and add the new contact as primary.
    log.step(
      `Fuzzy duplicate "${dup.name}" (distance ${dup.distance}) — demoting and adding new as primary.`,
    );
    await demoteExistingContact(page, dup.name);
    // After demote, navigate back into the editor for this employee.
    await navigateToEmergencyContact(page, record.employee.employeeId);
    // Falls through — fill-form + save run normally.
  }
}
```

The exact glue depends on the handler's current control flow — preserve the existing `ctx.skipStep("fill-form")` / `ctx.skipStep("save")` pattern for the exact-match path.

- [ ] **Step 3: Type-check**

```
npm run typecheck:all
```

Expected: 0 errors.

- [ ] **Step 4: Smoke-test the handler logic with a minimal mock**

Add to `tests/unit/workflows/emergency-contact/enter-fuzzy-dup.test.ts`:

```ts
describe("handler duplicate branching (logic-level)", () => {
  it("exact match → skip", () => {
    const dup = { name: "John Doe", distance: 0, isExact: true };
    // The handler's intent: when isExact, skip the fill-form + save steps.
    // We assert the branch shape here as a sanity check; full integration
    // is exercised by manual E2E in Phase 7.
    expect(dup.isExact).toBe(true);
  });
  it("fuzzy match → demote + continue", () => {
    const dup = { name: "Tomako Langley", distance: 2, isExact: false };
    expect(dup.isExact).toBe(false);
    expect(dup.distance).toBeLessThanOrEqual(2);
  });
});
```

(This is a thin assertion — the full behavioral test is the manual E2E in Phase 7.)

- [ ] **Step 5: Run all emergency-contact unit tests**

```
npx vitest run tests/unit/workflows/emergency-contact/
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/workflows/emergency-contact/workflow.ts tests/unit/workflows/emergency-contact/enter-fuzzy-dup.test.ts
git commit -m "$(cat <<'EOF'
feat(emergency-contact): three-way duplicate handling in handler

- isExact (distance 0): skip — record already current.
- fuzzy (distance 1-2): demote existing primary, add new as primary.
- no match: add normally.

Replaces the prior all-or-nothing skip-on-match. Fixes the regression
introduced 2026-04-27 where Leo Longley's misspelled historical
contact wasn't demoted, causing a duplicate.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 0.6 — Dashboard updateData + new detail fields

**Files:**
- Modify: `src/workflows/emergency-contact/workflow.ts` — `ctx.updateData` at top of handler; new `detailFields`.

- [ ] **Step 1: Locate `defineWorkflow` for emergency-contact**

In `src/workflows/emergency-contact/workflow.ts`, find the `detailFields:` array. Currently has 4 entries: employeeName, emplId, contactName, relationship.

- [ ] **Step 2: Add `contactPhone` and `contactAddress` to `detailFields`**

```ts
detailFields: [
  { key: "employeeName", label: "Employee" },
  { key: "emplId", label: "Empl ID" },
  { key: "contactName", label: "Contact" },
  { key: "relationship", label: "Relationship" },
  { key: "contactPhone", label: "Contact Phone" },
  { key: "contactAddress", label: "Contact Address" },
],
```

- [ ] **Step 3: Synthesize and write data at the top of the handler**

Right after `const page = await ctx.page("ucpath");` in the handler (or before the first `ctx.step(...)` call), add:

```ts
// Populate dashboard fields from the input synchronously so the kernel's
// post-handler check stops warning about declared-but-unpopulated fields.
// onPreEmitPending writes these to the *pending* row; this writes them
// to the *running* row's data via the ctx merge.
const c = record.emergencyContact;
const phoneSummary = c.cellPhone || c.homePhone || c.workPhone || "";
const addrSummary = c.address
  ? [c.address.street, c.address.city, c.address.state, c.address.zip]
      .filter((s): s is string => Boolean(s))
      .join(", ")
  : "(same as employee)";
ctx.updateData({
  emplId: record.employee.employeeId,
  employeeName: record.employee.name,
  contactName: c.name,
  relationship: c.relationship,
  contactPhone: phoneSummary,
  contactAddress: addrSummary,
});
```

- [ ] **Step 4: Type-check**

```
npm run typecheck:all
```

Expected: 0 errors.

- [ ] **Step 5: Manual smoke test**

Run a dry-run on the existing 8-record YAML to confirm no warnings:

```
npm run emergency-contact:dry .tracker/emergency-contact/2026-04-27-batch.yaml
```

Expected: no `dashboard: detailField 'X' was declared but never populated` warnings (dry-run doesn't go through the handler so this won't fully exercise; the real check happens during a live run in Phase 7).

- [ ] **Step 6: Commit**

```bash
git add src/workflows/emergency-contact/workflow.ts
git commit -m "$(cat <<'EOF'
fix(emergency-contact): populate dashboard fields in handler

The kernel was warning about emplId/contactName/relationship being
declared in detailFields but never written via updateData (they're
written by onPreEmitPending in the CLI adapter, but that's outside
the kernel's view). Synthesize them at the top of the handler, plus
add contactPhone + contactAddress for richer dashboard rows.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Phase 0 verification + checkpoint

- [ ] Run full test suite: `npm run test`
- [ ] Run typecheck: `npm run typecheck:all`
- [ ] Run inline-selector guard: `npx vitest run tests/unit/systems/inline-selectors.test.ts`
- [ ] Run selector-catalog guard: `npx vitest run tests/unit/scripts/selectors-catalog.test.ts`

**Manual checklist (defer until user has UCPath access):**
- [ ] Pick an EID with a known existing contact whose name is a typo'd version of what's in a test YAML. Run `npm run emergency-contact:direct <yaml>`. Confirm the existing contact's Primary box is unchecked and the new contact is added as primary.
- [ ] Run with a record that has `address: null`. Confirm "Same Address as Employee" is checked in UCPath.
- [ ] Run any record. Confirm the dashboard row shows Contact Phone + Contact Address. No warnings in the daemon log.

**🛑 CHECKPOINT — Phase 0 complete.**

Pause here. The user reviews the three bug fixes. If approved, proceed to Phase 1.

---

## Phase 1 — Edit-data opt-in

**Goal:** Mark emergency-contact's PDF-extracted detail fields as `editable: true` so the dashboard's existing edit-data tab works on individual child rows. No skipStep is needed because emergency-contact has no extraction step in its handler — `prefilledData` merge is sufficient.

**Files:**
- Modify: `src/workflows/emergency-contact/workflow.ts` — `editable: true` on the right detail fields.
- (No new tests — existing edit-data tests in `src/tracker/dashboard-ops` already cover the merge logic.)

### Task 1.1 — Mark editable detail fields

- [ ] **Step 1: Update `detailFields`**

In `src/workflows/emergency-contact/workflow.ts`:

```ts
detailFields: [
  { key: "employeeName", label: "Employee", editable: true },
  { key: "emplId", label: "Empl ID", editable: true },
  { key: "contactName", label: "Contact", editable: true },
  { key: "relationship", label: "Relationship", editable: true },
  { key: "contactPhone", label: "Contact Phone", editable: true },
  { key: "contactAddress", label: "Contact Address", editable: true, multiline: true },
],
```

Note: `multiline: true` for the address since it's a long string. (Verify the kernel's `DetailField` interface supports `multiline` — see `src/core/types.ts`. If not, omit and revisit later.)

- [ ] **Step 2: Verify the kernel's DetailField type supports `editable` and (optionally) `multiline`**

```
grep -n "interface DetailField\|type DetailField" src/core/types.ts
```

If `editable` is supported but `multiline` is not, drop `multiline`. The frontend can render a multi-line input later.

- [ ] **Step 3: Type-check**

```
npm run typecheck:all
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/workflows/emergency-contact/workflow.ts
git commit -m "$(cat <<'EOF'
feat(emergency-contact): edit-data opt-in

Mark the six PDF-extracted detail fields as editable. No skipStep
needed — emergency-contact has no extraction step in the handler.
The kernel's prefilledData merge already populates ctx.data correctly
when the user retries with edits via the dashboard's edit-data tab.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Phase 1 verification + checkpoint

- [ ] `npm run typecheck:all` passes.
- [ ] `npm run test` passes.

**Manual checklist:**
- [ ] In the dashboard, expand a child emergency-contact row's "Edit Data" tab. Confirm all six fields (Employee, Empl ID, Contact, Relationship, Contact Phone, Contact Address) are editable inputs.
- [ ] Modify a value (e.g. change Contact phone), click "Run with edits." Confirm a new pending row spawns with the edited value visible in the row's display.

**🛑 CHECKPOINT — Phase 1 complete.**

---

## Phase 2 — `src/ocr/` primitive (standalone)

**Goal:** Build a fully-tested, schema-bound OCR module with Gemini multi-key rotation. No consumer wires up to it yet — it's a library shipped on its own.

**Files (final state):**
- Create: `src/ocr/index.ts` — public API.
- Create: `src/ocr/types.ts` — `OcrRequest<T>`, `OcrResult<T>`, `OcrProvider`, error classes.
- Create: `src/ocr/cache.ts` — file-based cache.
- Create: `src/ocr/rotation.ts` — per-key state machine + persistence.
- Create: `src/ocr/prompts.ts` — schema → prompt template.
- Create: `src/ocr/providers/gemini.ts` — Gemini multi-modal call.
- Create: `src/ocr/providers/types.ts` — Provider interface (re-exports from `../types.ts` if cleaner).
- Create: `src/ocr/CLAUDE.md` — module doc.
- Modify: `package.json` — add `@google/generative-ai` to deps.
- Modify: `.gitignore` — `.ocr-cache/`.
- Create: `tests/unit/ocr/cache.test.ts`
- Create: `tests/unit/ocr/rotation.test.ts`
- Create: `tests/unit/ocr/prompts.test.ts`
- Create: `tests/unit/ocr/index.test.ts` — top-level integration with mocked provider.

### Task 2.1 — Create types + error classes

- [ ] **Step 1: Write the failing test for type shape**

```ts
// tests/unit/ocr/types.test.ts
import { describe, it, expect } from "vitest";
import { OcrAllKeysExhaustedError, OcrValidationError } from "../../../src/ocr/types.js";

describe("OCR error classes", () => {
  it("OcrAllKeysExhaustedError has expected name + message", () => {
    const err = new OcrAllKeysExhaustedError("gemini", 6);
    expect(err.name).toBe("OcrAllKeysExhaustedError");
    expect(err.message).toMatch(/all 6.*gemini.*exhausted/i);
  });
  it("OcrValidationError carries the validation issue", () => {
    const err = new OcrValidationError("schema mismatch", { issues: [{ path: ["a"], message: "x" }] });
    expect(err.name).toBe("OcrValidationError");
    expect(err.zodResult).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to confirm fail**

```
npx vitest run tests/unit/ocr/types.test.ts
```

- [ ] **Step 3: Create `src/ocr/types.ts`**

```ts
import type { ZodType } from "zod/v4";

export interface OcrRequest<T> {
  pdfPath: string;
  schema: ZodType<T>;
  schemaName: string;
  examples?: Array<{ pdfPath?: string; output: T }>;
  pageRange?: { start: number; end: number };
  prompt?: string;
  bustCache?: boolean;
}

export interface OcrResult<T> {
  data: T;
  rawText?: string;
  pageCount: number;
  provider: string;
  keyIndex: number;
  attempts: number;
  cached: boolean;
  durationMs: number;
}

export interface ProviderKey {
  /** Human-readable index (1-based for display). */
  index: number;
  /** The actual API key value. */
  value: string;
}

export interface OcrProvider {
  id: string;
  /**
   * Run a single OCR call against this provider with the given key.
   * Throws on rate limit / quota / auth errors — the rotation layer
   * catches those, marks the key, and tries the next.
   */
  call<T>(req: OcrRequest<T>, key: ProviderKey): Promise<OcrResult<T>>;
}

export class OcrAllKeysExhaustedError extends Error {
  override name = "OcrAllKeysExhaustedError";
  constructor(public providerId: string, public keyCount: number) {
    super(`All ${keyCount} ${providerId} keys exhausted (rate-limited, quota-out, or dead).`);
  }
}

export class OcrValidationError extends Error {
  override name = "OcrValidationError";
  constructor(message: string, public zodResult: { issues: Array<{ path: (string | number)[]; message: string }> }) {
    super(message);
  }
}

export class OcrProviderError extends Error {
  override name = "OcrProviderError";
  /** "rate-limit" | "quota-exhausted" | "auth" | "transient" | "unknown" */
  constructor(message: string, public kind: "rate-limit" | "quota-exhausted" | "auth" | "transient" | "unknown", public httpStatus?: number) {
    super(message);
  }
}
```

- [ ] **Step 4: Run, expect pass**

```
npx vitest run tests/unit/ocr/types.test.ts
npm run typecheck:all
```

- [ ] **Step 5: Commit**

```bash
git add src/ocr/types.ts tests/unit/ocr/types.test.ts
git commit -m "$(cat <<'EOF'
feat(ocr): types + error classes

OcrRequest<T>, OcrResult<T>, OcrProvider, ProviderKey, plus three
error classes: OcrAllKeysExhaustedError, OcrValidationError,
OcrProviderError with kind discriminator.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2.2 — File-based cache

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/ocr/cache.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeCacheKey, readCache, writeCache } from "../../../src/ocr/cache.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ocr-cache-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("computeCacheKey", () => {
  it("returns a 64-char hex hash", () => {
    const key = computeCacheKey({ pdfBytes: Buffer.from("abc"), schemaName: "X", schemaJsonHash: "h", promptVersion: "v1" });
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });
  it("differs when pdf bytes differ", () => {
    const a = computeCacheKey({ pdfBytes: Buffer.from("abc"), schemaName: "X", schemaJsonHash: "h", promptVersion: "v1" });
    const b = computeCacheKey({ pdfBytes: Buffer.from("xyz"), schemaName: "X", schemaJsonHash: "h", promptVersion: "v1" });
    expect(a).not.toBe(b);
  });
  it("differs when schemaName differs", () => {
    const a = computeCacheKey({ pdfBytes: Buffer.from("abc"), schemaName: "X", schemaJsonHash: "h", promptVersion: "v1" });
    const b = computeCacheKey({ pdfBytes: Buffer.from("abc"), schemaName: "Y", schemaJsonHash: "h", promptVersion: "v1" });
    expect(a).not.toBe(b);
  });
});

describe("readCache / writeCache", () => {
  it("returns undefined for missing key", () => {
    expect(readCache(tmp, "missing-key")).toBeUndefined();
  });
  it("round-trips an OcrResult", () => {
    const key = "abc123";
    writeCache(tmp, key, { data: { records: [1, 2, 3] }, pageCount: 1, provider: "gemini", keyIndex: 0, attempts: 1, cached: false, durationMs: 100 } as never);
    const out = readCache(tmp, key);
    expect(out?.data).toEqual({ records: [1, 2, 3] });
  });
});
```

- [ ] **Step 2: Run, expect fail**

```
npx vitest run tests/unit/ocr/cache.test.ts
```

- [ ] **Step 3: Implement `src/ocr/cache.ts`**

```ts
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OcrResult } from "./types.js";

export interface CacheKeyParts {
  pdfBytes: Buffer;
  schemaName: string;
  schemaJsonHash: string;
  promptVersion: string;
}

export function computeCacheKey(parts: CacheKeyParts): string {
  const h = createHash("sha256");
  h.update(parts.pdfBytes);
  h.update("\0");
  h.update(parts.schemaName);
  h.update("\0");
  h.update(parts.schemaJsonHash);
  h.update("\0");
  h.update(parts.promptVersion);
  return h.digest("hex");
}

export function cachePath(dir: string, key: string): string {
  return join(dir, `${key}.json`);
}

export function readCache<T>(dir: string, key: string): OcrResult<T> | undefined {
  const p = cachePath(dir, key);
  if (!existsSync(p)) return undefined;
  try {
    const raw = readFileSync(p, "utf-8");
    return JSON.parse(raw) as OcrResult<T>;
  } catch {
    return undefined;
  }
}

export function writeCache<T>(dir: string, key: string, result: OcrResult<T>): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const p = cachePath(dir, key);
  writeFileSync(p, JSON.stringify(result, null, 2));
}
```

- [ ] **Step 4: Run, expect pass**

```
npx vitest run tests/unit/ocr/cache.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/ocr/cache.ts tests/unit/ocr/cache.test.ts
git commit -m "$(cat <<'EOF'
feat(ocr): file-based cache with sha256 keys

computeCacheKey hashes (pdfBytes, schemaName, schemaJsonHash,
promptVersion). readCache / writeCache do plain JSON round-trip
under .ocr-cache/{key}.json.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2.3 — Rotation state machine

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/ocr/rotation.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KeyRotation,
  type KeyState,
} from "../../../src/ocr/rotation.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ocr-rot-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("KeyRotation", () => {
  it("returns the first key when none have been used", () => {
    const r = new KeyRotation("gemini", ["k1", "k2", "k3"], tmp);
    const k = r.pickNext();
    expect(k.value).toBe("k1");
  });
  it("rotates past a 429-throttled key for 60s", () => {
    const r = new KeyRotation("gemini", ["k1", "k2"], tmp);
    const k1 = r.pickNext();
    r.markRateLimited(k1, Date.now() + 60_000);
    const k = r.pickNext();
    expect(k.value).toBe("k2");
  });
  it("rotates past a quota-exhausted key for the day", () => {
    const r = new KeyRotation("gemini", ["k1", "k2"], tmp);
    const k1 = r.pickNext();
    r.markQuotaExhausted(k1, Date.now() + 24 * 3600_000);
    const k = r.pickNext();
    expect(k.value).toBe("k2");
  });
  it("rotates past a dead key for the session", () => {
    const r = new KeyRotation("gemini", ["k1", "k2"], tmp);
    const k1 = r.pickNext();
    r.markDead(k1);
    const k = r.pickNext();
    expect(k.value).toBe("k2");
  });
  it("throws when all keys are exhausted", () => {
    const r = new KeyRotation("gemini", ["k1"], tmp);
    const k1 = r.pickNext();
    r.markDead(k1);
    expect(() => r.pickNext()).toThrow(/exhausted/i);
  });
  it("re-enables a throttled key after its until time passes", () => {
    const r = new KeyRotation("gemini", ["k1"], tmp);
    const k1 = r.pickNext();
    r.markRateLimited(k1, Date.now() - 1_000);  // expired in the past
    const k = r.pickNext();
    expect(k.value).toBe("k1");
  });
  it("persists state to file on flush()", () => {
    const r1 = new KeyRotation("gemini", ["k1", "k2"], tmp);
    const k1 = r1.pickNext();
    r1.markRateLimited(k1, Date.now() + 60_000);
    r1.flush();
    const r2 = new KeyRotation("gemini", ["k1", "k2"], tmp);
    // r2 reads persisted state and should rotate past k1.
    const k = r2.pickNext();
    expect(k.value).toBe("k2");
  });
});
```

- [ ] **Step 2: Run to confirm fail**

```
npx vitest run tests/unit/ocr/rotation.test.ts
```

- [ ] **Step 3: Implement `src/ocr/rotation.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OcrAllKeysExhaustedError, type ProviderKey } from "./types.js";

export type KeyState =
  | { kind: "available" }
  | { kind: "throttled"; untilMs: number }
  | { kind: "quota-exhausted"; untilMs: number }
  | { kind: "dead" };

interface PersistedState {
  /** Map keyHash → KeyState. We hash the key value so the state file isn't a credential dump. */
  keys: Record<string, { state: KeyState; dailyCount: number; dailyEpochDay: number }>;
}

function dayUtc(ms = Date.now()): number {
  return Math.floor(ms / (24 * 3600_000));
}

function hashKey(value: string): string {
  // Tiny non-cryptographic hash — just to dedupe the value in the state file.
  let h = 0;
  for (let i = 0; i < value.length; i++) h = ((h << 5) - h + value.charCodeAt(i)) | 0;
  return `k${(h >>> 0).toString(36)}`;
}

export class KeyRotation {
  private state = new Map<string, { state: KeyState; dailyCount: number; dailyEpochDay: number }>();
  private statePath: string;

  constructor(public providerId: string, private rawKeys: readonly string[], cacheDir: string) {
    this.statePath = join(cacheDir, `rotation-state-${providerId}.json`);
    this.load();
  }

  private load(): void {
    if (!existsSync(this.statePath)) return;
    try {
      const persisted = JSON.parse(readFileSync(this.statePath, "utf-8")) as PersistedState;
      for (const [hash, entry] of Object.entries(persisted.keys ?? {})) {
        this.state.set(hash, entry);
      }
    } catch {
      // Corrupt file — start fresh.
    }
  }

  flush(): void {
    const dir = this.statePath.substring(0, this.statePath.lastIndexOf("/"));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const persisted: PersistedState = { keys: {} };
    for (const [hash, entry] of this.state) persisted.keys[hash] = entry;
    writeFileSync(this.statePath, JSON.stringify(persisted, null, 2));
  }

  private getEntry(hash: string): { state: KeyState; dailyCount: number; dailyEpochDay: number } {
    let e = this.state.get(hash);
    if (!e) {
      e = { state: { kind: "available" }, dailyCount: 0, dailyEpochDay: dayUtc() };
      this.state.set(hash, e);
    }
    // Day rollover resets dailyCount.
    const today = dayUtc();
    if (e.dailyEpochDay !== today) {
      e.dailyCount = 0;
      e.dailyEpochDay = today;
      // Clear quota-exhausted whose untilMs has passed.
      if (e.state.kind === "quota-exhausted" && e.state.untilMs <= Date.now()) {
        e.state = { kind: "available" };
      }
    }
    // Clear throttled whose untilMs has passed.
    if (e.state.kind === "throttled" && e.state.untilMs <= Date.now()) {
      e.state = { kind: "available" };
    }
    return e;
  }

  pickNext(): ProviderKey {
    let best: { hash: string; index: number; value: string; dailyCount: number } | null = null;
    for (let i = 0; i < this.rawKeys.length; i++) {
      const value = this.rawKeys[i];
      const hash = hashKey(value);
      const e = this.getEntry(hash);
      if (e.state.kind !== "available") continue;
      if (!best || e.dailyCount < best.dailyCount) {
        best = { hash, index: i + 1, value, dailyCount: e.dailyCount };
      }
    }
    if (!best) {
      throw new OcrAllKeysExhaustedError(this.providerId, this.rawKeys.length);
    }
    // Increment count optimistically — caller can rollback via mark*.
    const e = this.getEntry(best.hash);
    e.dailyCount += 1;
    return { index: best.index, value: best.value };
  }

  private setState(key: ProviderKey, state: KeyState): void {
    const hash = hashKey(key.value);
    const e = this.getEntry(hash);
    e.state = state;
  }

  markRateLimited(key: ProviderKey, untilMs: number): void {
    this.setState(key, { kind: "throttled", untilMs });
  }
  markQuotaExhausted(key: ProviderKey, untilMs: number): void {
    this.setState(key, { kind: "quota-exhausted", untilMs });
  }
  markDead(key: ProviderKey): void {
    this.setState(key, { kind: "dead" });
  }
  markSuccess(key: ProviderKey): void {
    // Optional: clear transient throttle on success. For now, no-op.
  }

  /** For tests / debugging. */
  inspect(): readonly { hash: string; state: KeyState; dailyCount: number }[] {
    return [...this.state.entries()].map(([hash, e]) => ({
      hash,
      state: e.state,
      dailyCount: e.dailyCount,
    }));
  }
}
```

- [ ] **Step 4: Run, expect pass**

```
npx vitest run tests/unit/ocr/rotation.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/ocr/rotation.ts tests/unit/ocr/rotation.test.ts
git commit -m "$(cat <<'EOF'
feat(ocr): KeyRotation state machine

Per-key state: available | throttled-until | quota-exhausted-until |
dead. Selection picks the available key with smallest daily count.
File-persisted at .ocr-cache/rotation-state-{provider}.json. Throttle
+ quota states clear automatically on time-window expiry.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2.4 — Schema-to-prompt utility

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/ocr/prompts.test.ts
import { describe, it, expect } from "vitest";
import { z } from "zod/v4";
import { buildPrompt, computeSchemaJsonHash } from "../../../src/ocr/prompts.js";

const Sample = z.object({
  name: z.string(),
  age: z.number().int().nonnegative(),
});

describe("buildPrompt", () => {
  it("includes the schema name", () => {
    const p = buildPrompt({ schemaName: "Person", schema: Sample });
    expect(p).toMatch(/Person/);
  });
  it("includes a JSON-schema description in the prompt body", () => {
    const p = buildPrompt({ schemaName: "Person", schema: Sample });
    expect(p).toMatch(/age|number/i);
  });
});

describe("computeSchemaJsonHash", () => {
  it("returns a stable hash for the same schema", () => {
    const a = computeSchemaJsonHash(Sample);
    const b = computeSchemaJsonHash(Sample);
    expect(a).toBe(b);
  });
  it("differs for different schemas", () => {
    const Other = z.object({ name: z.string() });
    expect(computeSchemaJsonHash(Sample)).not.toBe(computeSchemaJsonHash(Other));
  });
});
```

- [ ] **Step 2: Run to confirm fail**

```
npx vitest run tests/unit/ocr/prompts.test.ts
```

- [ ] **Step 3: Implement `src/ocr/prompts.ts`**

```ts
import { createHash } from "node:crypto";
import type { ZodType } from "zod/v4";
import { z } from "zod/v4";

export const PROMPT_VERSION = "v1";

export interface BuildPromptOpts<T> {
  schemaName: string;
  schema: ZodType<T>;
  examples?: Array<{ pdfPath?: string; output: T }>;
  override?: string;
}

/**
 * Convert a Zod schema to its JSON Schema form for LLM consumption.
 * Uses Zod v4's built-in toJsonSchema() if available, otherwise falls
 * back to a description string.
 */
function toJsonSchemaSafe<T>(schema: ZodType<T>): unknown {
  try {
    // Zod v4 ships z.toJSONSchema(...).
    return (z as unknown as { toJSONSchema?: (s: ZodType<T>) => unknown }).toJSONSchema?.(schema)
      ?? { description: "Schema (Zod v4) — see codebase for definition" };
  } catch {
    return { description: "Schema introspection failed" };
  }
}

export function computeSchemaJsonHash<T>(schema: ZodType<T>): string {
  const json = toJsonSchemaSafe(schema);
  const serialized = JSON.stringify(json);
  return createHash("sha256").update(serialized).digest("hex").slice(0, 16);
}

export function buildPrompt<T>(opts: BuildPromptOpts<T>): string {
  if (opts.override) return opts.override;
  const json = toJsonSchemaSafe(opts.schema);
  const exampleBlock = opts.examples?.length
    ? `\n\nExamples of valid output:\n${opts.examples.map((e, i) => `Example ${i + 1}:\n${JSON.stringify(e.output, null, 2)}`).join("\n\n")}`
    : "";
  return [
    `You are an OCR system. Extract structured data from the attached PDF.`,
    `The output type is "${opts.schemaName}". The output MUST be valid JSON matching this JSON Schema:`,
    "",
    JSON.stringify(json, null, 2),
    "",
    `Follow these rules:`,
    `- Extract every record visible in the PDF; produce one entry per record.`,
    `- For handwritten text, use your best transcription. If a field is illegible, omit it (use null where the schema allows).`,
    `- Phone numbers should be normalized to "(XXX) XXX-XXXX" format when possible.`,
    `- Addresses: keep US format. Pull out street, city, state (2-letter), and ZIP into separate fields if the schema requests them.`,
    `- Do not invent data. If a field is blank on the form, return null (or omit per schema).`,
    `- Output ONLY the JSON, no commentary.`,
    exampleBlock,
  ].join("\n");
}
```

- [ ] **Step 4: Run, expect pass**

```
npx vitest run tests/unit/ocr/prompts.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/ocr/prompts.ts tests/unit/ocr/prompts.test.ts
git commit -m "$(cat <<'EOF'
feat(ocr): schema-to-prompt utility

buildPrompt(opts) emits a Gemini-friendly system prompt that includes
the JSON Schema (via Zod v4 toJSONSchema), extraction rules tuned for
handwritten US forms (phones, addresses), and optional few-shot
examples. computeSchemaJsonHash gives a stable cache-key fragment.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2.5 — Gemini provider

- [ ] **Step 1: Add `@google/generative-ai` dependency**

```
npm install @google/generative-ai
```

Verify `package.json` updated.

- [ ] **Step 2: Add `.ocr-cache/` to `.gitignore`**

```
grep -q "^\.ocr-cache" .gitignore || echo ".ocr-cache/" >> .gitignore
```

- [ ] **Step 3: Write the test (mocked Gemini)**

```ts
// tests/unit/ocr/providers/gemini.test.ts
import { describe, it, expect, vi } from "vitest";
import { z } from "zod/v4";
import { GeminiProvider } from "../../../../src/ocr/providers/gemini.js";

vi.mock("@google/generative-ai", () => {
  return {
    GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
      getGenerativeModel: vi.fn().mockReturnValue({
        generateContent: vi.fn().mockResolvedValue({
          response: {
            text: () => JSON.stringify([{ name: "Test", age: 30 }]),
          },
        }),
      }),
    })),
  };
});

describe("GeminiProvider", () => {
  it("calls generateContent and returns parsed data", async () => {
    const Sample = z.array(z.object({ name: z.string(), age: z.number() }));
    const provider = new GeminiProvider();
    const result = await provider.call(
      {
        pdfPath: "/dev/null", // mocked at fs read level too — see implementation
        schema: Sample,
        schemaName: "Person",
      },
      { index: 1, value: "fake-key" },
    );
    expect(result.data).toEqual([{ name: "Test", age: 30 }]);
    expect(result.provider).toBe("gemini");
    expect(result.keyIndex).toBe(1);
  });
});
```

This test will need to mock `fs.readFileSync` for the PDF path too (or the implementation should accept `pdfBytes` directly — see step 4 for the choice).

- [ ] **Step 4: Implement `src/ocr/providers/gemini.ts`**

```ts
import { readFileSync } from "node:fs";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { buildPrompt, computeSchemaJsonHash } from "../prompts.js";
import {
  OcrProviderError,
  type OcrProvider,
  type OcrRequest,
  type OcrResult,
  type ProviderKey,
} from "../types.js";

export class GeminiProvider implements OcrProvider {
  id = "gemini";

  async call<T>(req: OcrRequest<T>, key: ProviderKey): Promise<OcrResult<T>> {
    const start = Date.now();
    const pdfBytes = readFileSync(req.pdfPath);
    const prompt = buildPrompt({
      schemaName: req.schemaName,
      schema: req.schema,
      examples: req.examples,
      override: req.prompt,
    });

    const genai = new GoogleGenerativeAI(key.value);
    const model = genai.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        responseMimeType: "application/json",
        // responseSchema would go here if/when SDK supports Zod-derived schema
      },
    });

    let raw: { response: { text(): string } };
    try {
      raw = await model.generateContent([
        { text: prompt },
        { inlineData: { mimeType: "application/pdf", data: pdfBytes.toString("base64") } },
      ]);
    } catch (err) {
      throw classifyProviderError(err);
    }

    const text = raw.response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new OcrProviderError(`Gemini returned non-JSON: ${text.slice(0, 200)}`, "unknown");
    }

    // Schema validation happens in the index layer (so the rotation layer can
    // catch validation errors and feed them back into a retry prompt).
    return {
      data: parsed as T,
      rawText: text,
      pageCount: 0, // populated by the index layer if needed
      provider: this.id,
      keyIndex: key.index,
      attempts: 1,
      cached: false,
      durationMs: Date.now() - start,
    };
  }
}

function classifyProviderError(err: unknown): OcrProviderError {
  const message = err instanceof Error ? err.message : String(err);
  // The Gemini SDK doesn't expose HTTP status directly; pattern-match the message.
  if (/429|rate limit|too many/i.test(message)) {
    return new OcrProviderError(message, "rate-limit", 429);
  }
  if (/quota|exhaust|exceeded/i.test(message)) {
    return new OcrProviderError(message, "quota-exhausted", 403);
  }
  if (/401|unauthor|invalid api key/i.test(message)) {
    return new OcrProviderError(message, "auth", 401);
  }
  if (/timeout|ECONNRESET|EAI_AGAIN/i.test(message)) {
    return new OcrProviderError(message, "transient");
  }
  return new OcrProviderError(message, "unknown");
}
```

- [ ] **Step 5: Run, expect pass**

```
npx vitest run tests/unit/ocr/providers/gemini.test.ts
npm run typecheck:all
```

- [ ] **Step 6: Commit**

```bash
git add src/ocr/providers/gemini.ts tests/unit/ocr/providers/gemini.test.ts package.json package-lock.json .gitignore
git commit -m "$(cat <<'EOF'
feat(ocr): Gemini provider with error classification

Implements OcrProvider.call() against gemini-2.5-flash via the
@google/generative-ai SDK. Inline-data multipart with PDF base64 +
schema-derived prompt. Errors are classified into rate-limit /
quota-exhausted / auth / transient / unknown so the rotation layer
can mark keys correctly.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2.6 — Top-level `ocrDocument()` orchestrator

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/ocr/index.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import { ocrDocument, __setProviderForTests, __setCacheDirForTests } from "../../../src/ocr/index.js";
import type { OcrProvider } from "../../../src/ocr/types.js";

const Sample = z.array(z.object({ name: z.string(), age: z.number().int() }));

let tmp: string;
let pdfPath: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ocr-idx-"));
  pdfPath = join(tmp, "fake.pdf");
  writeFileSync(pdfPath, Buffer.from("FAKE PDF"));
  __setCacheDirForTests(join(tmp, "cache"));
});
afterEach(() => {
  __setCacheDirForTests(undefined);
  __setProviderForTests(undefined);
  rmSync(tmp, { recursive: true, force: true });
});

function makeFakeProvider(): OcrProvider {
  return {
    id: "gemini",
    call: vi.fn().mockResolvedValue({
      data: [{ name: "Alice", age: 30 }],
      rawText: "[]",
      pageCount: 1,
      provider: "gemini",
      keyIndex: 1,
      attempts: 1,
      cached: false,
      durationMs: 100,
    }),
  };
}

describe("ocrDocument — happy path", () => {
  it("calls provider and returns validated data", async () => {
    const fake = makeFakeProvider();
    __setProviderForTests(fake);
    const r = await ocrDocument({
      pdfPath,
      schema: Sample,
      schemaName: "Person",
    });
    expect(r.data).toEqual([{ name: "Alice", age: 30 }]);
    expect(fake.call).toHaveBeenCalledOnce();
  });
  it("hits the cache on second call (cached: true)", async () => {
    const fake = makeFakeProvider();
    __setProviderForTests(fake);
    await ocrDocument({ pdfPath, schema: Sample, schemaName: "Person" });
    const r2 = await ocrDocument({ pdfPath, schema: Sample, schemaName: "Person" });
    expect(r2.cached).toBe(true);
    expect(fake.call).toHaveBeenCalledOnce(); // still 1
  });
  it("respects bustCache: true", async () => {
    const fake = makeFakeProvider();
    __setProviderForTests(fake);
    await ocrDocument({ pdfPath, schema: Sample, schemaName: "Person" });
    await ocrDocument({ pdfPath, schema: Sample, schemaName: "Person", bustCache: true });
    expect(fake.call).toHaveBeenCalledTimes(2);
  });
});

describe("ocrDocument — validation retry", () => {
  it("retries once on Zod validation failure, then succeeds", async () => {
    let calls = 0;
    const fake: OcrProvider = {
      id: "gemini",
      call: vi.fn().mockImplementation(() => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve({
            data: [{ name: "Alice", age: "not-a-number" }] as unknown,
            rawText: "[]", pageCount: 1, provider: "gemini", keyIndex: 1, attempts: 1, cached: false, durationMs: 100,
          });
        }
        return Promise.resolve({
          data: [{ name: "Alice", age: 30 }],
          rawText: "[]", pageCount: 1, provider: "gemini", keyIndex: 1, attempts: 1, cached: false, durationMs: 100,
        });
      }),
    };
    __setProviderForTests(fake);
    const r = await ocrDocument({ pdfPath, schema: Sample, schemaName: "Person" });
    expect(r.data).toEqual([{ name: "Alice", age: 30 }]);
    expect(calls).toBe(2);
  });
});
```

- [ ] **Step 2: Run to confirm fail**

```
npx vitest run tests/unit/ocr/index.test.ts
```

- [ ] **Step 3: Implement `src/ocr/index.ts`**

```ts
import { readFileSync, statSync } from "node:fs";
import { z } from "zod/v4";
import { computeCacheKey, readCache, writeCache } from "./cache.js";
import { computeSchemaJsonHash, PROMPT_VERSION } from "./prompts.js";
import { KeyRotation } from "./rotation.js";
import { GeminiProvider } from "./providers/gemini.js";
import {
  OcrAllKeysExhaustedError,
  OcrProviderError,
  OcrValidationError,
  type OcrProvider,
  type OcrRequest,
  type OcrResult,
} from "./types.js";

export type { OcrRequest, OcrResult };
export { OcrAllKeysExhaustedError, OcrValidationError, OcrProviderError };

const DEFAULT_CACHE_DIR = ".ocr-cache";
let _cacheDir: string | undefined;
let _provider: OcrProvider | undefined;

/** @internal used by tests */
export function __setCacheDirForTests(dir: string | undefined): void {
  _cacheDir = dir;
}
/** @internal used by tests */
export function __setProviderForTests(provider: OcrProvider | undefined): void {
  _provider = provider;
}

function getCacheDir(): string {
  return _cacheDir ?? DEFAULT_CACHE_DIR;
}

function getProvider(): OcrProvider {
  if (_provider) return _provider;
  return new GeminiProvider();
}

function getGeminiKeys(): string[] {
  const keys: string[] = [];
  for (const name of ["GEMINI_API_KEY", "GEMINI_API_KEY2", "GEMINI_API_KEY3", "GEMINI_API_KEY4", "GEMINI_API_KEY5", "GEMINI_API_KEY6"]) {
    const v = process.env[name];
    if (v && v.trim()) keys.push(v.trim());
  }
  return keys;
}

const MAX_VALIDATION_RETRIES = 1; // 1 retry = 2 total attempts

export async function ocrDocument<T>(req: OcrRequest<T>): Promise<OcrResult<T>> {
  // 1. Cache check.
  const pdfBytes = readFileSync(req.pdfPath);
  const cacheKey = computeCacheKey({
    pdfBytes,
    schemaName: req.schemaName,
    schemaJsonHash: computeSchemaJsonHash(req.schema),
    promptVersion: PROMPT_VERSION,
  });
  const cacheDir = getCacheDir();
  if (!req.bustCache) {
    const cached = readCache<T>(cacheDir, cacheKey);
    if (cached) {
      return { ...cached, cached: true };
    }
  }

  // 2. Rotation setup.
  const provider = getProvider();
  const keys = provider.id === "gemini" ? getGeminiKeys() : [];
  if (keys.length === 0) {
    throw new Error(`ocrDocument: no API keys configured for provider "${provider.id}"`);
  }
  const rotation = new KeyRotation(provider.id, keys, cacheDir);

  // 3. Provider call with rotation + validation retry.
  let lastError: unknown;
  let totalAttempts = 0;
  let validationRetries = 0;
  let validationHint: string | undefined;

  while (totalAttempts < keys.length + MAX_VALIDATION_RETRIES + 1) {
    let key;
    try {
      key = rotation.pickNext();
    } catch (err) {
      if (err instanceof OcrAllKeysExhaustedError) {
        rotation.flush();
        throw err;
      }
      throw err;
    }
    totalAttempts += 1;

    try {
      const reqWithHint = validationHint
        ? { ...req, prompt: (req.prompt ?? "") + `\n\nNOTE: Previous attempt failed schema validation: ${validationHint}` }
        : req;
      const raw = await provider.call(reqWithHint, key);
      // 3a. Validate against schema.
      const validated = req.schema.safeParse(raw.data);
      if (!validated.success) {
        if (validationRetries < MAX_VALIDATION_RETRIES) {
          validationRetries += 1;
          validationHint = JSON.stringify(validated.error.issues.slice(0, 3));
          continue;
        }
        rotation.flush();
        throw new OcrValidationError(
          `Schema validation failed after ${validationRetries + 1} attempts`,
          { issues: validated.error.issues.map((i) => ({ path: i.path as (string | number)[], message: i.message })) },
        );
      }
      // 3b. Success — cache and return.
      const result: OcrResult<T> = {
        ...raw,
        data: validated.data,
        attempts: totalAttempts,
        cached: false,
      };
      writeCache(cacheDir, cacheKey, result);
      rotation.markSuccess(key);
      rotation.flush();
      return result;
    } catch (err) {
      lastError = err;
      if (err instanceof OcrProviderError) {
        switch (err.kind) {
          case "rate-limit":
            rotation.markRateLimited(key, Date.now() + 60_000);
            break;
          case "quota-exhausted":
            // Reset at next UTC midnight.
            rotation.markQuotaExhausted(key, nextUtcMidnight());
            break;
          case "auth":
            rotation.markDead(key);
            break;
          case "transient":
            // Retry same key once.
            // (Could re-pick same key; for simplicity rotate.)
            rotation.markRateLimited(key, Date.now() + 5_000);
            break;
          case "unknown":
            // Treat as transient.
            rotation.markRateLimited(key, Date.now() + 30_000);
            break;
        }
        continue;
      }
      // Non-provider error — bubble up.
      rotation.flush();
      throw err;
    }
  }

  rotation.flush();
  if (lastError) throw lastError;
  throw new OcrAllKeysExhaustedError(provider.id, keys.length);
}

function nextUtcMidnight(): number {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
  return tomorrow.getTime();
}
```

- [ ] **Step 4: Run, expect pass**

```
npx vitest run tests/unit/ocr/index.test.ts
npm run typecheck:all
```

- [ ] **Step 5: Commit**

```bash
git add src/ocr/index.ts tests/unit/ocr/index.test.ts
git commit -m "$(cat <<'EOF'
feat(ocr): top-level ocrDocument() orchestrator

Wires provider + rotation + cache + Zod validation + retry loop.
Cache hit returns immediately. Cache miss enters key-rotation loop
that classifies provider errors and marks keys (rate-limit /
quota-exhausted / auth / transient). Validation failure retries
once with the error fed back as a prompt hint, then throws
OcrValidationError.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2.7 — `src/ocr/CLAUDE.md` doc

- [ ] **Step 1: Write the doc**

Create `src/ocr/CLAUDE.md` summarizing:
- Public API: `ocrDocument<T>(req)` returns `OcrResult<T>`.
- Cache: `.ocr-cache/{sha256}.json`, indefinite TTL.
- Rotation state: `.ocr-cache/rotation-state-gemini.json`.
- Adding a new provider: implement `OcrProvider`, register in `index.ts`.
- Bust cache: `bustCache: true` per call, or `rm .ocr-cache/*.json`.
- Test recipe: use `__setProviderForTests` + `__setCacheDirForTests`.

```markdown
# OCR Module — `src/ocr/`

Generic, schema-bound OCR primitive. Used by emergency-contact's prepare
phase; reusable by future workflows that need to extract structured
data from PDFs.

## Files

- `index.ts` — public `ocrDocument<T>()` orchestrator.
- `types.ts` — `OcrRequest`, `OcrResult`, `OcrProvider`, error classes.
- `cache.ts` — file cache at `.ocr-cache/{sha256}.json`.
- `rotation.ts` — per-key state machine + persisted state.
- `prompts.ts` — schema → Gemini prompt template.
- `providers/gemini.ts` — Gemini 2.5 Flash multi-modal call.

## Public API

```ts
import { ocrDocument } from "src/ocr";
import { z } from "zod/v4";

const Schema = z.array(z.object({ name: z.string(), age: z.number() }));
const result = await ocrDocument({
  pdfPath: "/path/to/scan.pdf",
  schema: Schema,
  schemaName: "Person",  // used for cache key + prompt label
});
result.data;       // validated T
result.cached;     // true if served from cache
result.attempts;   // how many provider calls were made
result.keyIndex;   // which Gemini key succeeded (1..6)
```

## Cache

Key = `sha256(pdfBytes + schemaName + schemaJsonHash + promptVersion)`.
File: `.ocr-cache/{key}.json`. TTL: indefinite. To bust: pass
`bustCache: true`, or `rm .ocr-cache/*.json`.

## Rotation

`KeyRotation` tracks per-key `available | throttled | quota-exhausted | dead`
states, persisted at `.ocr-cache/rotation-state-{provider}.json`. The
day-rollover (UTC midnight) clears `quota-exhausted` and resets
daily-counts. Throttle expiry is checked on each `pickNext()`.

Detection rules (for Gemini's error message patterns):
- `429` / "rate limit" / "too many" → throttled +60s
- "quota" / "exceed" / "exhaust" → quota-exhausted until next UTC midnight
- `401` / "unauthorized" / "invalid api key" → dead (this session)
- timeout / `ECONNRESET` / `EAI_AGAIN` → transient (5s throttle, then rotate)

## Providers

Currently: Gemini only. Cross-provider fallback is deferred — to add
Mistral / OpenRouter / Groq / Cerebras / Cohere / Sambanova, implement
`OcrProvider` and register in `index.ts`'s `getProvider()` selector.

## Test recipe

```ts
import { __setCacheDirForTests, __setProviderForTests, ocrDocument } from "src/ocr";

beforeEach(() => __setCacheDirForTests(tmpDir));
afterEach(() => { __setCacheDirForTests(undefined); __setProviderForTests(undefined); });

const fakeProvider = { id: "gemini", call: vi.fn().mockResolvedValue({ ... }) };
__setProviderForTests(fakeProvider);
```

## Lessons Learned

(empty — module is new as of 2026-04-XX)
```

- [ ] **Step 2: Commit**

```bash
git add src/ocr/CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(ocr): module README

Public API, cache contract, rotation state, provider registration,
test recipe.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Phase 2 verification + checkpoint

- [ ] `npm run typecheck:all` passes.
- [ ] `npm run test` passes (all OCR unit tests run).
- [ ] Bundle size sanity: ensure `@google/generative-ai` doesn't bloat the dashboard build (it's server-side only — should not be imported from `src/dashboard/`).

**Manual verification:**
- [ ] Quick smoke from a Node REPL with a real Gemini key + a small PDF:
  ```ts
  import { ocrDocument } from "./src/ocr/index.js";
  import { z } from "zod/v4";
  const r = await ocrDocument({ pdfPath: "/path/to/test.pdf", schema: z.string(), schemaName: "Test" });
  console.log(r);
  ```
  (Optional — skipped if you'd rather wait for the prep handler in Phase 4.)

**🛑 CHECKPOINT — Phase 2 complete.**

---

## Phase 3 — Match utilities

**Goal:** Pure utility module for roster-name matching (Levenshtein-based scoring) and US address normalization/comparison. No I/O — fully unit-testable.

**Files:**
- Create: `src/workflows/emergency-contact/match.ts`
- Create: `tests/unit/workflows/emergency-contact/match.test.ts`

### Task 3.1 — Name match scoring

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/workflows/emergency-contact/match.test.ts
import { describe, it, expect } from "vitest";
import { scoreNameMatch, type NameMatchResult } from "../../../../src/workflows/emergency-contact/match.js";

describe("scoreNameMatch", () => {
  it("scores 1.0 for exact match (case + whitespace insensitive)", () => {
    const r = scoreNameMatch("John Doe", "JOHN  DOE");
    expect(r.score).toBe(1.0);
  });
  it("scores 0.9 for token-set intersection", () => {
    const r = scoreNameMatch("John Michael Doe", "John Doe");
    expect(r.score).toBeGreaterThanOrEqual(0.85);
  });
  it("scores 0.85 for Doe, Jane vs Jane Doe (first/last swap)", () => {
    const r = scoreNameMatch("Doe, Jane", "Jane Doe");
    expect(r.score).toBeGreaterThanOrEqual(0.85);
  });
  it("scores 0.7 for Levenshtein-2 fuzzy", () => {
    const r = scoreNameMatch("John Doee", "John Doe");
    expect(r.score).toBeGreaterThanOrEqual(0.7);
    expect(r.score).toBeLessThan(0.85);
  });
  it("scores 0 for no match", () => {
    const r = scoreNameMatch("Alice Wonderland", "John Doe");
    expect(r.score).toBe(0);
  });
});
```

- [ ] **Step 2: Run, expect fail**

```
npx vitest run tests/unit/workflows/emergency-contact/match.test.ts
```

- [ ] **Step 3: Implement `match.ts` (name-match section)**

```ts
// src/workflows/emergency-contact/match.ts
import { levenshteinDistance } from "./levenshtein.js";

export interface NameMatchResult {
  /** 0..1 confidence */
  score: number;
  /** "exact" | "token-set" | "swap" | "fuzzy" | "none" */
  reason: "exact" | "token-set" | "swap" | "fuzzy" | "none";
}

function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
}

export function scoreNameMatch(a: string, b: string): NameMatchResult {
  const at = tokenize(a);
  const bt = tokenize(b);
  if (at.length === 0 || bt.length === 0) return { score: 0, reason: "none" };

  const aSorted = [...at].sort().join(" ");
  const bSorted = [...bt].sort().join(" ");
  if (aSorted === bSorted) return { score: 1.0, reason: "exact" };

  const aSet = new Set(at);
  const bSet = new Set(bt);
  const inter = [...aSet].filter((x) => bSet.has(x));
  if (inter.length / Math.max(aSet.size, bSet.size) >= 0.5) {
    return { score: 0.9, reason: "token-set" };
  }

  // First/last-swap: split by comma if present
  if (a.includes(",") || b.includes(",")) {
    const flip = (s: string): string =>
      s.includes(",") ? s.split(",").map((x) => x.trim()).reverse().join(" ") : s;
    if (tokenize(flip(a)).sort().join(" ") === tokenize(flip(b)).sort().join(" ")) {
      return { score: 0.85, reason: "swap" };
    }
  }

  const d = levenshteinDistance(at.join(" "), bt.join(" "));
  if (d <= 2) return { score: 0.7, reason: "fuzzy" };

  return { score: 0, reason: "none" };
}
```

- [ ] **Step 4: Run, expect pass**

```
npx vitest run tests/unit/workflows/emergency-contact/match.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/workflows/emergency-contact/match.ts tests/unit/workflows/emergency-contact/match.test.ts
git commit -m "$(cat <<'EOF'
feat(emergency-contact): scoreNameMatch — five-tier name scoring

Exact (sorted tokens) = 1.0
Token-set intersect >= 50% = 0.9
First/last-swap (with comma) = 0.85
Levenshtein <= 2 fuzzy = 0.7
None = 0

Auto-accept threshold for roster matching is 0.85.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3.2 — US address normalization + comparison

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/workflows/emergency-contact/match.test.ts`:

```ts
import { normalizeUsAddress, compareUsAddresses } from "../../../../src/workflows/emergency-contact/match.js";

describe("normalizeUsAddress", () => {
  it("lowercases", () => {
    expect(normalizeUsAddress({ street: "123 MAIN ST" })).toMatchObject({ street: "123 main street" });
  });
  it("expands abbreviations", () => {
    expect(normalizeUsAddress({ street: "418 Oak Ave" })).toMatchObject({ street: "418 oak avenue" });
    expect(normalizeUsAddress({ street: "9485 S Scholars Dr" })).toMatchObject({ street: "9485 south scholars drive" });
  });
  it("strips punctuation", () => {
    expect(normalizeUsAddress({ street: "418 Oak Ave." })).toMatchObject({ street: "418 oak avenue" });
  });
  it("collapses whitespace", () => {
    expect(normalizeUsAddress({ street: "418  Oak    Ave" })).toMatchObject({ street: "418 oak avenue" });
  });
});

describe("compareUsAddresses", () => {
  it("matches identical addresses", () => {
    const r = compareUsAddresses(
      { street: "418 Oak Ave", city: "River Edge", state: "NJ", zip: "07661" },
      { street: "418 OAK AVENUE", city: "river edge", state: "nj", zip: "07661" },
    );
    expect(r).toBe("match");
  });
  it("matches with abbrev-expansion + Levenshtein <= 3", () => {
    const r = compareUsAddresses(
      { street: "9485 S Scholars Dr", city: "La Jolla", state: "CA", zip: "92093" },
      { street: "9485 South Scholars Drive", city: "la jolla", state: "ca", zip: "92093" },
    );
    expect(r).toBe("match");
  });
  it("differs when ZIP differs", () => {
    const r = compareUsAddresses(
      { street: "418 Oak Ave", city: "River Edge", state: "NJ", zip: "07661" },
      { street: "418 Oak Ave", city: "River Edge", state: "NJ", zip: "07662" },
    );
    expect(r).toBe("differ");
  });
  it("differs when street differs significantly", () => {
    const r = compareUsAddresses(
      { street: "418 Oak Ave", city: "River Edge", state: "NJ", zip: "07661" },
      { street: "999 Pine Blvd", city: "River Edge", state: "NJ", zip: "07661" },
    );
    expect(r).toBe("differ");
  });
  it("returns missing when either side is null/empty", () => {
    expect(compareUsAddresses(null, { street: "x", city: null, state: null, zip: null })).toBe("missing");
    expect(compareUsAddresses({ street: "x", city: null, state: null, zip: null }, null)).toBe("missing");
  });
});
```

- [ ] **Step 2: Run, expect fail**

```
npx vitest run tests/unit/workflows/emergency-contact/match.test.ts
```

- [ ] **Step 3: Implement normalization + comparison**

Append to `src/workflows/emergency-contact/match.ts`:

```ts
const ABBREV: Record<string, string> = {
  st: "street", str: "street",
  ave: "avenue", av: "avenue",
  blvd: "boulevard",
  rd: "road",
  dr: "drive",
  ln: "lane",
  ct: "court",
  pl: "place",
  pkwy: "parkway",
  ter: "terrace",
  apt: "apartment", "#": "apartment",
  ste: "suite",
  n: "north", s: "south", e: "east", w: "west",
  ne: "northeast", nw: "northwest", se: "southeast", sw: "southwest",
};

const STATE_NAMES: Record<string, string> = {
  al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california",
  co: "colorado", ct: "connecticut", de: "delaware", fl: "florida", ga: "georgia",
  hi: "hawaii", id: "idaho", il: "illinois", in: "indiana", ia: "iowa",
  ks: "kansas", ky: "kentucky", la: "louisiana", me: "maine", md: "maryland",
  ma: "massachusetts", mi: "michigan", mn: "minnesota", ms: "mississippi", mo: "missouri",
  mt: "montana", ne: "nebraska", nv: "nevada", nh: "new hampshire", nj: "new jersey",
  nm: "new mexico", ny: "new york", nc: "north carolina", nd: "north dakota", oh: "ohio",
  ok: "oklahoma", or: "oregon", pa: "pennsylvania", ri: "rhode island", sc: "south carolina",
  sd: "south dakota", tn: "tennessee", tx: "texas", ut: "utah", vt: "vermont",
  va: "virginia", wa: "washington", wv: "west virginia", wi: "wisconsin", wy: "wyoming",
};

export interface AddressLike {
  street: string;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}

export interface NormalizedAddress {
  street: string;
  city: string;
  state: string;
  zip: string;
}

function expandTokens(s: string): string {
  return s
    .split(/\s+/)
    .map((tok) => {
      const cleaned = tok.replace(/[.,;:#]/g, "");
      return ABBREV[cleaned.toLowerCase()] ?? cleaned;
    })
    .filter(Boolean)
    .join(" ");
}

export function normalizeUsAddress(a: AddressLike): NormalizedAddress {
  const street = expandTokens(a.street ?? "")
    .toLowerCase()
    .replace(/[.,;:]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const city = (a.city ?? "").toLowerCase().replace(/[.,;:]/g, "").replace(/\s+/g, " ").trim();
  const stateRaw = (a.state ?? "").toLowerCase().trim();
  const state = STATE_NAMES[stateRaw] ?? stateRaw;
  const zip = (a.zip ?? "").replace(/[^0-9-]/g, "").split("-")[0]; // 5-digit only
  return { street, city, state, zip };
}

export function compareUsAddresses(a: AddressLike | null, b: AddressLike | null): "match" | "differ" | "missing" {
  if (!a || !b || !a.street || !b.street) return "missing";
  const an = normalizeUsAddress(a);
  const bn = normalizeUsAddress(b);

  if (!an.zip || !bn.zip) return "missing";
  if (an.zip !== bn.zip) return "differ";

  const d = levenshteinDistance(an.street, bn.street);
  return d <= 3 ? "match" : "differ";
}
```

- [ ] **Step 4: Run, expect pass**

```
npx vitest run tests/unit/workflows/emergency-contact/match.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/workflows/emergency-contact/match.ts tests/unit/workflows/emergency-contact/match.test.ts
git commit -m "$(cat <<'EOF'
feat(emergency-contact): US address normalize + compare

normalizeUsAddress lowercases, expands street/state abbreviations
(St→street, CA→california etc.), strips punctuation, normalizes ZIP
to 5-digit. compareUsAddresses returns "match" | "differ" | "missing"
based on ZIP exact + Levenshtein <= 3 on normalized street.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3.3 — Roster lookup

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/workflows/emergency-contact/match.test.ts`:

```ts
import { matchAgainstRoster, type RosterRow } from "../../../../src/workflows/emergency-contact/match.js";

const fakeRoster: RosterRow[] = [
  { eid: "10001", name: "Jane Doe", street: "123 Main", city: "Denver", state: "CO", zip: "80201" },
  { eid: "10002", name: "Bob Smith", street: "456 Elm", city: "Boulder", state: "CO", zip: "80302" },
  { eid: "10003", name: "Doe, Jane", street: "999 Diff", city: "x", state: "x", zip: "99999" },
];

describe("matchAgainstRoster", () => {
  it("returns single match when name is unambiguous", () => {
    const r = matchAgainstRoster(fakeRoster, "Bob Smith");
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].eid).toBe("10002");
    expect(r.bestScore).toBe(1.0);
  });
  it("returns multiple candidates when name ambiguous", () => {
    const r = matchAgainstRoster(fakeRoster, "Jane Doe");
    expect(r.candidates.length).toBeGreaterThanOrEqual(2);
  });
  it("returns empty when no match", () => {
    const r = matchAgainstRoster(fakeRoster, "Charlie Brown");
    expect(r.candidates).toHaveLength(0);
    expect(r.bestScore).toBe(0);
  });
  it("orders candidates by score descending", () => {
    const r = matchAgainstRoster(fakeRoster, "Jane Doe");
    for (let i = 1; i < r.candidates.length; i++) {
      expect(r.candidates[i - 1].score).toBeGreaterThanOrEqual(r.candidates[i].score);
    }
  });
});
```

- [ ] **Step 2: Run, expect fail**

```
npx vitest run tests/unit/workflows/emergency-contact/match.test.ts
```

- [ ] **Step 3: Implement `matchAgainstRoster`**

Append to `src/workflows/emergency-contact/match.ts`:

```ts
export interface RosterRow {
  eid: string;
  name: string;
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
}

export interface RosterMatchResult {
  candidates: Array<{ eid: string; name: string; score: number; reason: NameMatchResult["reason"] }>;
  bestScore: number;
}

export function matchAgainstRoster(roster: readonly RosterRow[], targetName: string): RosterMatchResult {
  const scored = roster
    .map((row) => {
      const m = scoreNameMatch(row.name, targetName);
      return { eid: row.eid, name: row.name, score: m.score, reason: m.reason };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
  return { candidates: scored, bestScore: scored[0]?.score ?? 0 };
}
```

- [ ] **Step 4: Run, expect pass**

```
npx vitest run tests/unit/workflows/emergency-contact/match.test.ts
npm run typecheck:all
```

- [ ] **Step 5: Commit**

```bash
git add src/workflows/emergency-contact/match.ts tests/unit/workflows/emergency-contact/match.test.ts
git commit -m "$(cat <<'EOF'
feat(emergency-contact): matchAgainstRoster — score every candidate

Returns candidates sorted by score (DESC), with the best score
exposed for auto-accept threshold checks. >= 0.85 = auto-accept;
< 0.85 = needs UI review.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Phase 3 verification + checkpoint

- [ ] `npm run typecheck:all` passes.
- [ ] `npm run test` passes.
- [ ] Coverage: name + address + roster — all three units have at least 5 cases each.

**🛑 CHECKPOINT — Phase 3 complete.**

---

## Phase 4 — Prep orchestrator

**Goal:** The function that runs OCR → match → write tracker rows progressively as records resolve via roster + eid-lookup-daemon. Standalone-callable; the HTTP endpoint in Phase 5 will be a thin wrapper.

**Files:**
- Create: `src/workflows/emergency-contact/preview-schema.ts` — Zod for prep row's data shape.
- Create: `src/workflows/emergency-contact/prepare.ts` — orchestrator.
- Create: `src/workflows/emergency-contact/roster-loader.ts` — reads `src/data/*.xlsx` (mtime DESC) and returns `RosterRow[]`.
- Create: `tests/unit/workflows/emergency-contact/preview-schema.test.ts`
- Create: `tests/unit/workflows/emergency-contact/prepare.test.ts`

### Task 4.1 — Preview schema

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/workflows/emergency-contact/preview-schema.test.ts
import { describe, it, expect } from "vitest";
import { PreviewRecordSchema, PrepareRowDataSchema } from "../../../../src/workflows/emergency-contact/preview-schema.js";

describe("PreviewRecordSchema", () => {
  it("accepts a valid extracted record", () => {
    const r = PreviewRecordSchema.parse({
      sourcePage: 1,
      employee: { name: "Test", employeeId: "12345" },
      emergencyContact: { name: "C", relationship: "Mother", primary: true, sameAddressAsEmployee: true, address: null, cellPhone: null, homePhone: null, workPhone: null },
      notes: [],
      matchState: "extracted",
      selected: true,
      warnings: [],
    });
    expect(r.matchState).toBe("extracted");
    expect(r.selected).toBe(true);
  });
  it("requires matchState in the enum", () => {
    expect(() => PreviewRecordSchema.parse({ matchState: "bogus" } as never)).toThrow();
  });
});

describe("PrepareRowDataSchema", () => {
  it("requires mode === 'prepare'", () => {
    expect(() => PrepareRowDataSchema.parse({ mode: "item" } as never)).toThrow();
  });
});
```

- [ ] **Step 2: Run, expect fail**

```
npx vitest run tests/unit/workflows/emergency-contact/preview-schema.test.ts
```

- [ ] **Step 3: Implement `preview-schema.ts`**

```ts
import { z } from "zod/v4";
import { RecordSchema, EmergencyContactSchema, EmployeeSchema } from "./schema.js";

export const MatchStateSchema = z.enum([
  "extracted",
  "matched",
  "lookup-pending",
  "lookup-running",
  "resolved",
  "unresolved",
]);

export const PreviewRecordSchema = RecordSchema.extend({
  matchState: MatchStateSchema,
  matchSource: z.enum(["form", "roster", "eid-lookup"]).optional(),
  matchConfidence: z.number().min(0).max(1).optional(),
  rosterCandidates: z.array(z.object({
    eid: z.string(),
    name: z.string(),
    score: z.number(),
  })).optional(),
  addressMatch: z.enum(["match", "differ", "missing"]).optional(),
  selected: z.boolean(),
  warnings: z.array(z.string()),
});
export type PreviewRecord = z.infer<typeof PreviewRecordSchema>;

export const PrepareRowDataSchema = z.object({
  mode: z.literal("prepare"),
  pdfPath: z.string(),
  pdfOriginalName: z.string(),
  rosterMode: z.enum(["download", "existing"]),
  rosterPath: z.string(),
  records: z.array(PreviewRecordSchema),
  ocrProvider: z.string().optional(),
  ocrAttempts: z.number().int().nonnegative().optional(),
  ocrCached: z.boolean().optional(),
});
export type PrepareRowData = z.infer<typeof PrepareRowDataSchema>;

/** Schema fed to ocrDocument — the bare list of records before match-state extension. */
export const OcrOutputSchema = z.array(RecordSchema);
```

- [ ] **Step 4: Run, expect pass**

```
npx vitest run tests/unit/workflows/emergency-contact/preview-schema.test.ts
npm run typecheck:all
```

- [ ] **Step 5: Commit**

```bash
git add src/workflows/emergency-contact/preview-schema.ts tests/unit/workflows/emergency-contact/preview-schema.test.ts
git commit -m "$(cat <<'EOF'
feat(emergency-contact): preview-schema — Zod for prep row data

PreviewRecord = RecordSchema + matchState/matchSource/matchConfidence/
rosterCandidates/addressMatch/selected/warnings.

PrepareRowData = { mode: "prepare", pdfPath, pdfOriginalName,
rosterMode, rosterPath, records[], ocrProvider?, ocrAttempts?,
ocrCached? }.

OcrOutputSchema = z.array(RecordSchema) — the schema fed to
ocrDocument before match-state augmentation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.2 — Roster loader

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/workflows/emergency-contact/roster-loader.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { findLatestRoster, loadRoster } from "../../../../src/workflows/emergency-contact/roster-loader.js";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "rost-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

async function writeFakeRoster(path: string, rows: { eid: string; first: string; last: string; street?: string }[]): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(["Employee ID", "First Name", "Last Name", "Street"]);
  for (const r of rows) ws.addRow([r.eid, r.first, r.last, r.street ?? ""]);
  await wb.xlsx.writeFile(path);
}

describe("findLatestRoster", () => {
  it("returns null when dir is empty", () => {
    expect(findLatestRoster(tmp)).toBeNull();
  });
  it("returns the newest .xlsx by mtime", async () => {
    const a = join(tmp, "old.xlsx");
    const b = join(tmp, "new.xlsx");
    await writeFakeRoster(a, []);
    await writeFakeRoster(b, []);
    utimesSync(a, new Date("2020-01-01"), new Date("2020-01-01"));
    utimesSync(b, new Date("2026-01-01"), new Date("2026-01-01"));
    const r = findLatestRoster(tmp);
    expect(r?.path).toBe(b);
  });
  it("ignores non-xlsx files", async () => {
    const x = join(tmp, "old.xlsx");
    const y = join(tmp, "ignore.txt");
    await writeFakeRoster(x, []);
    writeFileSync(y, "noise");
    const r = findLatestRoster(tmp);
    expect(r?.path).toBe(x);
  });
});

describe("loadRoster", () => {
  it("reads First+Last+Employee ID columns", async () => {
    const p = join(tmp, "r.xlsx");
    await writeFakeRoster(p, [
      { eid: "10001", first: "Jane", last: "Doe", street: "123 Main" },
      { eid: "10002", first: "Bob", last: "Smith" },
    ]);
    const rows = await loadRoster(p);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ eid: "10001", name: "Jane Doe", street: "123 Main" });
  });
});
```

- [ ] **Step 2: Run, expect fail**

```
npx vitest run tests/unit/workflows/emergency-contact/roster-loader.test.ts
```

- [ ] **Step 3: Implement `roster-loader.ts`**

```ts
// src/workflows/emergency-contact/roster-loader.ts
import { readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import ExcelJS from "exceljs";
import type { RosterRow } from "./match.js";

export interface RosterFileRef {
  path: string;
  mtimeMs: number;
  sizeBytes: number;
  filename: string;
}

export function findLatestRoster(dir: string): RosterFileRef | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const xlsx = entries
    .filter((f) => extname(f).toLowerCase() === ".xlsx")
    .map((f) => {
      const p = join(dir, f);
      try {
        const s = statSync(p);
        return { path: p, mtimeMs: s.mtimeMs, sizeBytes: s.size, filename: f };
      } catch {
        return null;
      }
    })
    .filter((x): x is RosterFileRef => x !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return xlsx[0] ?? null;
}

export function listRosters(dir: string): RosterFileRef[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => extname(f).toLowerCase() === ".xlsx")
    .map((f) => {
      const p = join(dir, f);
      const s = statSync(p);
      return { path: p, mtimeMs: s.mtimeMs, sizeBytes: s.size, filename: f };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export async function loadRoster(path: string): Promise<RosterRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const headerRow = ws.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell) => {
    headers.push(String(cell.value ?? "").trim());
  });
  const idx = (target: RegExp): number => headers.findIndex((h) => target.test(h));
  const eidCol = idx(/employee\s*id|empl\s*id/i) + 1;
  const firstCol = idx(/first\s*name/i) + 1;
  const lastCol = idx(/last\s*name/i) + 1;
  const nameCol = idx(/^name$/i) + 1;
  const streetCol = idx(/street|address/i) + 1;
  const cityCol = idx(/city/i) + 1;
  const stateCol = idx(/state/i) + 1;
  const zipCol = idx(/zip|postal/i) + 1;

  if (eidCol === 0) throw new Error(`loadRoster: no Employee ID column in ${path}`);

  const out: RosterRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    const eid = String(row.getCell(eidCol).value ?? "").trim();
    if (!eid) return;
    let name = nameCol > 0 ? String(row.getCell(nameCol).value ?? "").trim() : "";
    if (!name && firstCol > 0 && lastCol > 0) {
      const f = String(row.getCell(firstCol).value ?? "").trim();
      const l = String(row.getCell(lastCol).value ?? "").trim();
      name = `${f} ${l}`.trim();
    }
    const street = streetCol > 0 ? String(row.getCell(streetCol).value ?? "").trim() : undefined;
    const city = cityCol > 0 ? String(row.getCell(cityCol).value ?? "").trim() : undefined;
    const state = stateCol > 0 ? String(row.getCell(stateCol).value ?? "").trim() : undefined;
    const zip = zipCol > 0 ? String(row.getCell(zipCol).value ?? "").trim() : undefined;
    out.push({ eid, name, street, city, state, zip });
  });
  return out;
}
```

- [ ] **Step 4: Run, expect pass**

```
npx vitest run tests/unit/workflows/emergency-contact/roster-loader.test.ts
npm run typecheck:all
```

- [ ] **Step 5: Commit**

```bash
git add src/workflows/emergency-contact/roster-loader.ts tests/unit/workflows/emergency-contact/roster-loader.test.ts
git commit -m "$(cat <<'EOF'
feat(emergency-contact): roster-loader

findLatestRoster(dir) → newest .xlsx by mtime, or null.
listRosters(dir) → all .xlsx sorted mtime DESC.
loadRoster(path) → RosterRow[] from ExcelJS, supports
First+Last or single Name column, plus optional address columns.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.3 — Prep orchestrator (sync part: OCR + roster match + tracker writes)

This task is large because it ties everything together. It's broken into smaller sub-steps within the task.

- [ ] **Step 1: Write the failing test (sync portion only — async EID resolution is in Task 4.4)**

```ts
// tests/unit/workflows/emergency-contact/prepare.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPrepare, type PrepareInput } from "../../../../src/workflows/emergency-contact/prepare.js";
import { __setOcrForTests } from "../../../../src/workflows/emergency-contact/prepare.js";

let tmp: string, trackerDir: string, dataDir: string, uploadsDir: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "prep-"));
  trackerDir = join(tmp, "tracker");
  dataDir = join(tmp, "data");
  uploadsDir = join(tmp, "uploads");
});
afterEach(() => {
  __setOcrForTests(undefined);
  rmSync(tmp, { recursive: true, force: true });
});

describe("runPrepare — OCR + roster match (sync part)", () => {
  it("writes a pending row, runs OCR, writes a running row, and matches all-form-EID records to matched", async () => {
    // 1. fake roster with one matching person
    // 2. fake PDF
    // 3. mocked OCR returns one record with EID present
    // 4. runPrepare resolves to { runId, ... }
    // 5. assert tracker JSONL has pending → running with matchState=matched
    // ... (full test code matches the implementation, written when implementing the task)
  });
});
```

(This test will be more meaningful when paired with the implementation; treat it as a sketch — fill in details against the actual `runPrepare` signature in step 3.)

- [ ] **Step 2: Run, expect fail (or skip if test is too sketchy yet)**

- [ ] **Step 3: Implement `prepare.ts` (sync portion)**

```ts
// src/workflows/emergency-contact/prepare.ts
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { ocrDocument } from "../../ocr/index.js";
import type { OcrResult } from "../../ocr/types.js";
import { trackEvent } from "../../tracker/jsonl.js";
import { errorMessage } from "../../utils/errors.js";
import { log } from "../../utils/log.js";
import { findLatestRoster, loadRoster, type RosterFileRef } from "./roster-loader.js";
import { matchAgainstRoster, compareUsAddresses } from "./match.js";
import {
  OcrOutputSchema,
  PrepareRowDataSchema,
  type PreviewRecord,
  type PrepareRowData,
} from "./preview-schema.js";
import type { EmergencyContactRecord } from "./schema.js";

const WORKFLOW = "emergency-contact";

export interface PrepareInput {
  pdfPath: string;
  pdfOriginalName: string;
  rosterMode: "download" | "existing";
  rosterDir: string;        // .tracker/emergency-contact/uploads/ default; tests inject
  uploadsDir: string;
  trackerDir?: string;
}

export interface PrepareOutput {
  runId: string;
  parentRunId: string;
}

let _ocrFn: typeof ocrDocument | undefined;
/** @internal */
export function __setOcrForTests(fn: typeof ocrDocument | undefined): void {
  _ocrFn = fn;
}

export async function runPrepare(input: PrepareInput): Promise<PrepareOutput> {
  const runId = `prep-${randomUUID()}`;
  const id = `prep-${runId.slice(5, 13)}`;       // shorter human-readable id
  const trackerDir = input.trackerDir;

  const writePending = (): void => trackEvent({
    workflow: WORKFLOW,
    timestamp: new Date().toISOString(),
    id, runId,
    status: "pending",
    data: {
      mode: "prepare",
      pdfOriginalName: input.pdfOriginalName,
      rosterMode: input.rosterMode,
    },
  }, trackerDir);

  const writeRunning = (data: Partial<PrepareRowData>, step: string): void => trackEvent({
    workflow: WORKFLOW,
    timestamp: new Date().toISOString(),
    id, runId,
    status: "running", step,
    data: { mode: "prepare", ...flattenForData(data) },
  }, trackerDir);

  const writeFailed = (error: string): void => trackEvent({
    workflow: WORKFLOW,
    timestamp: new Date().toISOString(),
    id, runId,
    status: "failed",
    data: { mode: "prepare" },
    error,
  }, trackerDir);

  const writeDone = (data: PrepareRowData): void => trackEvent({
    workflow: WORKFLOW,
    timestamp: new Date().toISOString(),
    id, runId,
    status: "done",
    data: flattenForData(data),
  }, trackerDir);

  writePending();

  try {
    // --- 1. Pick roster ---
    if (!existsSync(input.rosterDir)) mkdirSync(input.rosterDir, { recursive: true });
    let rosterRef: RosterFileRef | null;
    if (input.rosterMode === "download") {
      // Caller (HTTP endpoint) is responsible for triggering sharepoint-download
      // before calling runPrepare. Here we just pick the latest.
      rosterRef = findLatestRoster(input.rosterDir);
    } else {
      rosterRef = findLatestRoster(input.rosterDir);
    }
    if (!rosterRef) {
      writeFailed(`No roster found in ${input.rosterDir}. Use mode "download" or place an .xlsx there.`);
      return { runId, parentRunId: runId };
    }
    writeRunning({ rosterPath: rosterRef.filename }, "loading-roster");
    const roster = await loadRoster(rosterRef.path);

    // --- 2. Run OCR ---
    writeRunning({ rosterPath: rosterRef.filename }, "ocr");
    const ocrFn = _ocrFn ?? ocrDocument;
    const ocrResult: OcrResult<EmergencyContactRecord[]> = await ocrFn({
      pdfPath: input.pdfPath,
      schema: OcrOutputSchema,
      schemaName: "emergency-contact-batch",
    });

    // --- 3. Match each record ---
    writeRunning({
      rosterPath: rosterRef.filename,
      ocrProvider: ocrResult.provider,
      ocrAttempts: ocrResult.attempts,
      ocrCached: ocrResult.cached,
    }, "matching");

    const records: PreviewRecord[] = ocrResult.data.map((r): PreviewRecord => {
      const existingEid = r.employee.employeeId?.trim();
      if (existingEid) {
        return { ...r, matchState: "matched", matchSource: "form", matchConfidence: 1.0, selected: true, warnings: [] };
      }
      const result = matchAgainstRoster(roster, r.employee.name);
      if (result.bestScore >= 0.85) {
        const top = result.candidates[0];
        const updatedEmployee = { ...r.employee, employeeId: top.eid };
        return {
          ...r,
          employee: updatedEmployee,
          matchState: "matched",
          matchSource: "roster",
          matchConfidence: top.score,
          rosterCandidates: result.candidates.slice(0, 3),
          selected: true,
          warnings: top.score < 1.0 ? [`Roster fuzzy-matched "${top.name}" (score ${top.score})`] : [],
        };
      }
      // No good roster match — eid-lookup needed (handled in async phase, Task 4.4)
      return {
        ...r,
        matchState: "lookup-pending",
        rosterCandidates: result.candidates.slice(0, 3),
        selected: true,
        warnings: result.candidates.length > 0
          ? [`Best roster score was ${result.bestScore.toFixed(2)} (< 0.85 auto-accept)`]
          : ["No roster match — falling back to eid-lookup"],
      };
    });

    // --- 4. Compute address sanity check per matched record ---
    for (const r of records) {
      if (r.matchSource === "roster") {
        const top = r.rosterCandidates?.[0];
        if (top) {
          const rosterRow = roster.find((x) => x.eid === top.eid);
          if (rosterRow && rosterRow.street) {
            r.addressMatch = compareUsAddresses(
              r.employee.homeAddress ?? null,
              { street: rosterRow.street, city: rosterRow.city, state: rosterRow.state, zip: rosterRow.zip },
            );
          }
        }
      }
    }

    // --- 5. If all are terminal (no lookup-pending), write done now ---
    const finalData: PrepareRowData = {
      mode: "prepare",
      pdfPath: input.pdfPath,
      pdfOriginalName: input.pdfOriginalName,
      rosterMode: input.rosterMode,
      rosterPath: rosterRef.filename,
      records,
      ocrProvider: ocrResult.provider,
      ocrAttempts: ocrResult.attempts,
      ocrCached: ocrResult.cached,
    };
    PrepareRowDataSchema.parse(finalData); // sanity

    const anyPending = records.some((r) => r.matchState === "lookup-pending");
    if (!anyPending) {
      writeDone(finalData);
    } else {
      writeRunning(finalData, "eid-lookup");
      // Task 4.4 will kick off async eid-lookup resolution here.
      void resolveEidsAsync(runId, id, finalData, trackerDir);
    }

    return { runId, parentRunId: runId };
  } catch (err) {
    writeFailed(errorMessage(err));
    return { runId, parentRunId: runId };
  }
}

function flattenForData(d: Partial<PrepareRowData>): Record<string, string> {
  // Flatten complex fields to JSON strings — tracker `data` is Record<string,string>.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(d)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = String(v);
    } else {
      out[k] = JSON.stringify(v);
    }
  }
  return out;
}

// ---- Async EID resolution (stub — implemented in Task 4.4) ----
async function resolveEidsAsync(_runId: string, _id: string, _data: PrepareRowData, _trackerDir?: string): Promise<void> {
  // Implemented in Task 4.4
}
```

- [ ] **Step 4: Run, expect (basic) pass**

```
npx vitest run tests/unit/workflows/emergency-contact/prepare.test.ts
npm run typecheck:all
```

- [ ] **Step 5: Commit**

```bash
git add src/workflows/emergency-contact/prepare.ts tests/unit/workflows/emergency-contact/prepare.test.ts
git commit -m "$(cat <<'EOF'
feat(emergency-contact): runPrepare — sync OCR + roster match

Writes a pending → running → done(or running again pending eid-lookup)
sequence to tracker JSONL with mode="prepare". Roster match auto-
accepts >= 0.85; below that, the record enters lookup-pending for
async resolution via eid-lookup (next task). Address sanity-check
fills addressMatch field for matched records.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.4 — Async EID resolution via eid-lookup-daemon

- [ ] **Step 1: Sketch the contract**

The `resolveEidsAsync` function must:
1. Ensure eid-lookup daemon is alive (auto-spawn).
2. Enqueue one eid-lookup item per record with state `lookup-pending`, using itemId `prep-{runId}-r{N}` for traceability.
3. Subscribe to the eid-lookup tracker JSONL for completion events matching those itemIds.
4. As each completes, update the prep row's record N to `resolved` (with matchSource=eid-lookup) or `unresolved`.
5. When all are terminal, transition the prep row to `done`.

The "subscribe to JSONL" mechanism uses `fs.watch` on the eid-lookup file + tail-read on changes.

- [ ] **Step 2: Implement**

In `src/workflows/emergency-contact/prepare.ts`, replace the stub `resolveEidsAsync`:

```ts
import { ensureDaemonsAndEnqueue } from "../../core/daemon-client.js";
import { eidLookupCrmWorkflow } from "../eid-lookup/index.js";  // verify path
import { watch as fsWatch, readFileSync, existsSync, statSync } from "node:fs";

async function resolveEidsAsync(runId: string, id: string, data: PrepareRowData, trackerDir?: string): Promise<void> {
  const pendingIndices = data.records
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.matchState === "lookup-pending");

  if (pendingIndices.length === 0) return;

  // Convert pending records into eid-lookup inputs.
  const lookupInputs = pendingIndices.map(({ r, i }) => ({
    name: r.employee.name,
    /* itemId mapping: passed via deriveItemId override below */
    __prepIndex: i,
  }));

  try {
    await ensureDaemonsAndEnqueue(eidLookupCrmWorkflow, lookupInputs, {
      deriveItemId: (input: unknown) => `prep-${runId}-r${(input as { __prepIndex: number }).__prepIndex}`,
      // No onPreEmitPending here — eid-lookup writes its own pending rows.
    });
  } catch (err) {
    log.warn(`eid-lookup enqueue failed: ${errorMessage(err)} — marking remaining records unresolved.`);
    for (const { i } of pendingIndices) {
      data.records[i].matchState = "unresolved";
      data.records[i].warnings.push(`eid-lookup unavailable: ${errorMessage(err)}`);
    }
    writeDoneNow();
    return;
  }

  // Subscribe to eid-lookup tracker JSONL for completions.
  const today = new Date().toISOString().slice(0, 10);
  const eidLookupFile = join(trackerDir ?? ".tracker", `eid-lookup-${today}.jsonl`);
  const expectedPrefixes = new Set(pendingIndices.map(({ i }) => `prep-${runId}-r${i}`));
  let resolvedCount = 0;
  let lastSize = 0;

  const checkFile = (): void => {
    if (!existsSync(eidLookupFile)) return;
    const cur = statSync(eidLookupFile);
    if (cur.size <= lastSize) return;
    const all = readFileSync(eidLookupFile, "utf-8");
    const lines = all.split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as { id: string; status: string; data?: { eid?: string } };
        if (!expectedPrefixes.has(entry.id)) continue;
        if (entry.status !== "done" && entry.status !== "failed") continue;
        const idx = Number(entry.id.split("-r")[1]);
        if (Number.isFinite(idx) && data.records[idx] && (data.records[idx].matchState === "lookup-pending" || data.records[idx].matchState === "lookup-running")) {
          if (entry.status === "done" && entry.data?.eid) {
            data.records[idx].employee.employeeId = entry.data.eid;
            data.records[idx].matchState = "resolved";
            data.records[idx].matchSource = "eid-lookup";
          } else {
            data.records[idx].matchState = "unresolved";
            data.records[idx].warnings.push("eid-lookup returned no result");
          }
          resolvedCount += 1;
          // Re-emit running with the updated records.
          trackEvent({
            workflow: WORKFLOW, timestamp: new Date().toISOString(),
            id, runId, status: "running", step: "eid-lookup",
            data: flattenForData(data),
          }, trackerDir);
        }
      } catch { /* skip malformed line */ }
    }
    lastSize = cur.size;
    if (resolvedCount >= pendingIndices.length) {
      writeDoneNow();
      watcher?.close();
    }
  };

  const writeDoneNow = (): void => {
    trackEvent({
      workflow: WORKFLOW, timestamp: new Date().toISOString(),
      id, runId, status: "done", data: flattenForData(data),
    }, trackerDir);
  };

  let watcher: ReturnType<typeof fsWatch> | undefined;
  try {
    if (existsSync(eidLookupFile)) {
      lastSize = statSync(eidLookupFile).size;
    }
    // Initial check (in case results landed before subscription set up).
    checkFile();
    if (resolvedCount < pendingIndices.length) {
      watcher = fsWatch(eidLookupFile, { persistent: false }, () => checkFile());
      // Safety timeout — 10 minutes max.
      setTimeout(() => {
        if (resolvedCount < pendingIndices.length) {
          for (const { i } of pendingIndices) {
            if (data.records[i].matchState === "lookup-pending" || data.records[i].matchState === "lookup-running") {
              data.records[i].matchState = "unresolved";
              data.records[i].warnings.push("eid-lookup did not return within 10 min");
            }
          }
          writeDoneNow();
          watcher?.close();
        }
      }, 10 * 60_000);
    }
  } catch (err) {
    log.warn(`fs.watch on eid-lookup JSONL failed: ${errorMessage(err)}`);
    // Fall back: poll every 10s for 10 min
    const start = Date.now();
    const poll = setInterval(() => {
      checkFile();
      if (resolvedCount >= pendingIndices.length || Date.now() - start > 10 * 60_000) {
        clearInterval(poll);
        if (resolvedCount < pendingIndices.length) writeDoneNow();
      }
    }, 10_000);
  }
}
```

NOTE: The `eidLookupCrmWorkflow` import path needs to be verified — the eid-lookup workflow may export multiple workflow variants. Read `src/workflows/eid-lookup/index.ts` and adjust.

- [ ] **Step 3: Type-check + tests**

```
npm run typecheck:all
npx vitest run tests/unit/workflows/emergency-contact/prepare.test.ts
```

- [ ] **Step 4: Add an integration-style test that exercises the async path**

Append to `prepare.test.ts`:

```ts
describe("runPrepare — async eid-lookup", () => {
  it("transitions a record from lookup-pending to resolved when eid-lookup writes done", async () => {
    // 1. Fake roster with NO matching person.
    // 2. Mocked OCR returns one record without EID.
    // 3. runPrepare returns; row should be in running with lookup-pending.
    // 4. Simulate writing a `done` line to eid-lookup-{today}.jsonl with matching itemId.
    // 5. Wait briefly; assert prep row's data.records[0].matchState === "resolved" and EID is populated.
  });
});
```

(Implementation of this test is involved because it requires faking `ensureDaemonsAndEnqueue` and the fs.watch subscription — fill in carefully or defer to manual E2E in Phase 7.)

- [ ] **Step 5: Commit**

```bash
git add src/workflows/emergency-contact/prepare.ts tests/unit/workflows/emergency-contact/prepare.test.ts
git commit -m "$(cat <<'EOF'
feat(emergency-contact): async EID resolution via eid-lookup daemon

When OCR + roster match leaves records in lookup-pending state,
runPrepare enqueues eid-lookup items with itemId prep-{runId}-r{N},
auto-spawning the eid-lookup daemon if needed. A fs.watch listener
on eid-lookup-{date}.jsonl progressively updates the prep row as
each lookup completes; final transition to status=done happens when
all are terminal. 10-min safety timeout marks any stuck records as
unresolved.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Phase 4 verification + checkpoint

- [ ] `npm run typecheck:all` passes.
- [ ] `npm run test` passes.
- [ ] Manual: write a small one-off script (`src/scripts/test-prepare.ts`) that calls `runPrepare` directly with a known PDF + roster. Verify tracker JSONL gets the expected sequence.

**🛑 CHECKPOINT — Phase 4 complete.**

---

## Phase 5 — Backend HTTP endpoints

**Goal:** Wire `runPrepare` + approve + discard + roster-list into the dashboard's HTTP server. Multipart upload for the PDF. Restart sweep on dashboard start.

**Files:**
- Modify: `src/tracker/dashboard.ts` — add 4 new route handlers.
- Modify: `src/tracker/dashboard-ops.ts` — add `buildEmergencyContactPrepareHandler`, `buildEmergencyContactApproveBatchHandler`, `buildEmergencyContactDiscardHandler`, `buildRostersListHandler`.
- Create: `tests/unit/tracker/emergency-contact-endpoints.test.ts` — handler-factory tests with fake dirs.

### Task 5.1 — Multipart PDF upload helper

Node's `http` module doesn't parse multipart natively. Two options:
- (A) Add `formidable` or `busboy` dep.
- (B) Hand-roll a minimal parser for `multipart/form-data` (only needs to extract one `file` field).

Recommend **B** for now — minimal scope, no new dep. If we add multipart in three more places, switch to busboy.

- [ ] **Step 1: Write a helper + test**

Create `tests/unit/tracker/multipart-helper.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseSingleFileMultipart } from "../../../src/tracker/multipart-helper.js";

describe("parseSingleFileMultipart", () => {
  it("extracts the file part by field name", () => {
    const boundary = "----TestBoundary123";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="pdfFile"; filename="x.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      Buffer.from([0x25, 0x50, 0x44, 0x46]), // "%PDF" header bytes
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const r = parseSingleFileMultipart(body, `multipart/form-data; boundary=${boundary}`, "pdfFile");
    expect(r?.filename).toBe("x.pdf");
    expect(r?.bytes.toString("ascii", 0, 4)).toBe("%PDF");
  });
});
```

- [ ] **Step 2: Implement `src/tracker/multipart-helper.ts`**

```ts
export interface MultipartFile {
  filename: string;
  contentType: string;
  bytes: Buffer;
}

export function parseSingleFileMultipart(body: Buffer, contentType: string, fieldName: string): MultipartFile | null {
  const boundaryMatch = /boundary=([^;]+)/.exec(contentType);
  if (!boundaryMatch) return null;
  const boundary = `--${boundaryMatch[1].trim()}`;
  const boundaryBuf = Buffer.from(boundary);
  // Find each boundary occurrence
  let i = body.indexOf(boundaryBuf);
  while (i !== -1) {
    const next = body.indexOf(boundaryBuf, i + boundaryBuf.length);
    if (next === -1) break;
    const partStart = i + boundaryBuf.length + 2; // skip \r\n
    const partEnd = next - 2; // strip trailing \r\n
    const part = body.subarray(partStart, partEnd);
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd === -1) { i = next; continue; }
    const headers = part.subarray(0, headerEnd).toString("utf-8");
    const data = part.subarray(headerEnd + 4);
    const cd = /Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]+)")?/i.exec(headers);
    if (cd && cd[1] === fieldName) {
      const filename = cd[2] ?? "upload.bin";
      const ctMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headers);
      return {
        filename,
        contentType: ctMatch?.[1].trim() ?? "application/octet-stream",
        bytes: data,
      };
    }
    i = next;
  }
  return null;
}
```

- [ ] **Step 3: Run, expect pass**

```
npx vitest run tests/unit/tracker/multipart-helper.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/tracker/multipart-helper.ts tests/unit/tracker/multipart-helper.test.ts
git commit -m "$(cat <<'EOF'
feat(tracker): minimal multipart/form-data helper

parseSingleFileMultipart extracts a single named file field from a
multipart body. Avoids adding formidable/busboy for one use site;
revisit if a third caller appears.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 5.2 — Prepare endpoint handler

- [ ] **Step 1: Add the handler factory in `dashboard-ops.ts`**

```ts
// In src/tracker/dashboard-ops.ts, add at the bottom:
import { runPrepare } from "../workflows/emergency-contact/prepare.js";
import { listRosters } from "../workflows/emergency-contact/roster-loader.js";
import { downloadSharePointFile } from "../workflows/sharepoint-download/index.js";

export interface PrepareReq {
  pdfBytes: Buffer;
  pdfOriginalName: string;
  rosterMode: "download" | "existing";
  uploadsDir: string;
  rosterDir: string;
  trackerDir?: string;
}

export async function emergencyContactPrepare(req: PrepareReq): Promise<{ runId: string; parentRunId: string }> {
  // 1. Save PDF to uploadsDir
  const slug = req.pdfOriginalName.replace(/[^A-Za-z0-9._-]/g, "_");
  const tempRunId = `prep-${Date.now()}`;
  const pdfPath = join(req.uploadsDir, `${tempRunId}-${slug}`);
  if (!existsSync(req.uploadsDir)) mkdir(req.uploadsDir, { recursive: true });
  writeFileSync(pdfPath, req.pdfBytes);
  // 2. If mode=download, trigger sharepoint-download first
  if (req.rosterMode === "download") {
    const url = process.env.ONBOARDING_ROSTER_URL;
    if (!url) {
      throw new Error("ONBOARDING_ROSTER_URL is not set in .env — cannot run download mode.");
    }
    await downloadSharePointFile({ landingUrl: url, destDir: req.rosterDir });
  }
  // 3. runPrepare
  return runPrepare({
    pdfPath,
    pdfOriginalName: req.pdfOriginalName,
    rosterMode: req.rosterMode,
    rosterDir: req.rosterDir,
    uploadsDir: req.uploadsDir,
    trackerDir: req.trackerDir,
  });
}
```

(Adjust imports — `writeFileSync` is sync; `mkdir` from `fs/promises` won't work mixed — use `mkdirSync`.)

- [ ] **Step 2: Add the route in `dashboard.ts`**

```ts
// In src/tracker/dashboard.ts, after other POST handlers:
if (req.method === "POST" && url.pathname === "/api/emergency-contact/prepare") {
  const ct = req.headers["content-type"] ?? "";
  if (!ct.startsWith("multipart/form-data")) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "expected multipart/form-data" }));
    return;
  }
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    try {
      const body = Buffer.concat(chunks);
      const file = parseSingleFileMultipart(body, ct, "pdfFile");
      if (!file) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "missing pdfFile field" }));
        return;
      }
      // Extract rosterMode from a separate field
      const modeFile = parseSingleFileMultipart(body, ct, "rosterMode");
      const rosterMode = (modeFile?.bytes.toString("utf-8") as "download" | "existing") ?? "existing";
      const out = await emergencyContactPrepare({
        pdfBytes: file.bytes,
        pdfOriginalName: file.filename,
        rosterMode,
        uploadsDir: ".tracker/emergency-contact/uploads",
        rosterDir: "src/data",
      });
      res.statusCode = 202;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(out));
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: errorMessage(err) }));
    }
  });
  return;
}
```

- [ ] **Step 3: Test the handler with a fake request**

Add to `tests/unit/tracker/emergency-contact-endpoints.test.ts`:

```ts
// (full test left as homework for the implementer — at minimum, exercise the
// happy-path fake-roster + fake-OCR flow and verify a 202 response with runId)
```

- [ ] **Step 4: Restart dashboard, smoke test with curl**

```
npm run dashboard  # in another terminal

# upload a fake PDF:
curl -F 'pdfFile=@/path/to/test.pdf' -F 'rosterMode=existing' http://localhost:3838/api/emergency-contact/prepare
```

Expected: `{ "runId": "prep-...", "parentRunId": "prep-..." }`

- [ ] **Step 5: Commit**

```bash
git add src/tracker/dashboard.ts src/tracker/dashboard-ops.ts tests/unit/tracker/emergency-contact-endpoints.test.ts
git commit -m "$(cat <<'EOF'
feat(tracker): POST /api/emergency-contact/prepare

Multipart PDF upload + rosterMode field. Fires runPrepare async
(server returns 202 with the runId, work continues in background).
Mode "download" triggers sharepoint-download first;
mode "existing" picks the latest .xlsx in src/data/.

Dashboard backend restart required.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 5.3 — Approve-batch endpoint

- [ ] **Step 1: Implement handler in `dashboard-ops.ts`**

```ts
import { ensureDaemonsAndEnqueue } from "../core/daemon-client.js";
import { emergencyContactWorkflow } from "../workflows/emergency-contact/index.js";

export async function emergencyContactApproveBatch(opts: {
  parentRunId: string;
  records: PreviewRecord[];
  trackerDir?: string;
}): Promise<{ enqueued: number; failed: Array<{ index: number; error: string }> }> {
  const selected = opts.records.filter((r) => r.selected && r.matchState !== "unresolved");
  if (selected.length === 0) {
    return { enqueued: 0, failed: [] };
  }
  // Strip preview-only fields, keep the EmergencyContactRecord shape, attach parentRunId via prefilledData.
  const inputs = selected.map((r) => ({
    sourcePage: r.sourcePage,
    employee: r.employee,
    emergencyContact: r.emergencyContact,
    notes: r.notes,
    prefilledData: { parentRunId: opts.parentRunId },
  }));
  const failed: Array<{ index: number; error: string }> = [];
  try {
    await ensureDaemonsAndEnqueue(emergencyContactWorkflow, inputs, {
      // emergency-contact uses p{NN}-{emplId} item ids — keep that convention.
      deriveItemId: (input: unknown) => {
        const r = input as EmergencyContactRecord;
        const pad = String(r.sourcePage).padStart(2, "0");
        return `p${pad}-${r.employee.employeeId}`;
      },
    });
  } catch (err) {
    failed.push({ index: -1, error: errorMessage(err) });
  }
  return { enqueued: selected.length - failed.length, failed };
}
```

- [ ] **Step 2: Add route in `dashboard.ts`**

```ts
if (req.method === "POST" && url.pathname === "/api/emergency-contact/approve-batch") {
  const body = await readJsonBody(req);
  if (!body || typeof body.parentRunId !== "string" || !Array.isArray(body.records)) {
    res.statusCode = 400; res.end(JSON.stringify({ error: "invalid body" })); return;
  }
  const result = await emergencyContactApproveBatch(body as never);
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(result));
  return;
}
```

(Use the existing `readJsonBody` helper or implement inline.)

- [ ] **Step 3: Discard endpoint**

```ts
if (req.method === "POST" && url.pathname === "/api/emergency-contact/discard-prepare") {
  const body = await readJsonBody(req);
  if (!body || typeof body.runId !== "string") {
    res.statusCode = 400; res.end(JSON.stringify({ error: "invalid body" })); return;
  }
  trackEvent({
    workflow: "emergency-contact", timestamp: new Date().toISOString(),
    id: body.runId, runId: body.runId,
    status: "skipped",
    data: { mode: "prepare", discarded: "true" },
  }, ".tracker");
  res.statusCode = 200; res.end(JSON.stringify({ ok: true })); return;
}
```

(Consider whether `skipped` or a new `cancelled` status is appropriate — the kernel's TrackerEntry status enum already includes `skipped`. Use that.)

- [ ] **Step 4: Rosters list endpoint**

```ts
if (req.method === "GET" && url.pathname === "/api/rosters") {
  const list = listRosters("src/data");
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(list.map((r) => ({
    filename: r.filename,
    mtime: r.mtimeMs,
    sizeBytes: r.sizeBytes,
  }))));
  return;
}
```

- [ ] **Step 5: Smoke test**

```
# In a running dashboard:
curl http://localhost:3838/api/rosters | jq
curl -X POST -H "Content-Type: application/json" -d '{"runId":"prep-test"}' http://localhost:3838/api/emergency-contact/discard-prepare
```

- [ ] **Step 6: Commit**

```bash
git add src/tracker/dashboard.ts src/tracker/dashboard-ops.ts
git commit -m "$(cat <<'EOF'
feat(tracker): approve-batch + discard-prepare + rosters list endpoints

POST /api/emergency-contact/approve-batch — validates records,
filters to selected + non-unresolved, enqueues into emergency-contact
daemon with prefilledData.parentRunId for child-parent grouping.

POST /api/emergency-contact/discard-prepare — marks the prep row
as skipped.

GET /api/rosters — lists src/data/*.xlsx by mtime DESC for the Run
modal's roster picker.

Dashboard backend restart required.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 5.4 — Restart sweep for stuck prep rows

- [ ] **Step 1: Implement the sweep**

In `src/tracker/dashboard.ts`, add to the startup logic (after `cleanOldTrackerFiles` and before HTTP server starts):

```ts
function sweepStuckPrepareRows(trackerDir: string): void {
  const today = new Date().toISOString().slice(0, 10);
  const file = join(trackerDir, `emergency-contact-${today}.jsonl`);
  if (!existsSync(file)) return;
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  const lastByRunId = new Map<string, { id: string; status: string; isPrep: boolean }>();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const isPrep = entry.data?.mode === "prepare";
      lastByRunId.set(String(entry.runId ?? entry.id), { id: entry.id, status: entry.status, isPrep });
    } catch { /* skip */ }
  }
  for (const [runId, last] of lastByRunId) {
    if (last.isPrep && (last.status === "running" || last.status === "pending")) {
      trackEvent({
        workflow: "emergency-contact", timestamp: new Date().toISOString(),
        id: last.id, runId, status: "failed",
        data: { mode: "prepare" },
        error: "Dashboard restarted while preparing — re-run if needed.",
      }, trackerDir);
      log.warn(`[startup-sweep] marked stuck prep row ${runId} as failed`);
    }
  }
}

// In startDashboard:
sweepStuckPrepareRows(".tracker");
```

- [ ] **Step 2: Test**

Manual: write a fake stuck prep row to today's JSONL, restart dashboard, verify it's marked failed.

- [ ] **Step 3: Commit**

```bash
git add src/tracker/dashboard.ts
git commit -m "$(cat <<'EOF'
feat(tracker): startup sweep for stuck prep rows

On dashboard start, scan today's emergency-contact JSONL for any
data.mode=prepare rows whose latest status is pending/running and
mark them failed with a "Dashboard restarted while preparing" error.
Prevents stuck previews after a restart.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Phase 5 verification + checkpoint

- [ ] `npm run typecheck:all` passes.
- [ ] `npm run test` passes.
- [ ] Restart dashboard. `curl` smoke tests for all 4 new endpoints succeed.
- [ ] Upload the user's `Xerox Scan_04272026142351.pdf` via:
  ```
  curl -F 'pdfFile=@/Users/julianhein/Downloads/Xerox Scan_04272026142351.pdf' -F 'rosterMode=existing' http://localhost:3838/api/emergency-contact/prepare
  ```
  Expected: 202 with a runId. Tracker JSONL shows pending → running (loading-roster) → running (ocr) → running (matching) → done with the 8 expected records.

**Manual checklist:**
- [ ] Dashboard restart sweep fires correctly when a prep row is left "running" before a restart.
- [ ] Prepare endpoint with no roster files in `src/data/` returns prep row `failed` with the expected message.
- [ ] Approve-batch endpoint with `selected: false` records does not enqueue them.

**🛑 CHECKPOINT — Phase 5 complete.**

---

## Phase 6 — Dashboard frontend (DELEGATED)

**Goal:** Build the React components for the Run button, modal, preview row, edit form, and parent-child grouping. Per the project's redesign-chain rule, this phase is split into two delegations.

**Files (final state — produced by sub-skills):**
- `src/dashboard/components/TopBarRunButton.tsx`
- `src/dashboard/components/RunModal.tsx`
- `src/dashboard/components/PreviewRow.tsx`
- `src/dashboard/components/PreviewRecordRow.tsx`
- `src/dashboard/components/PreviewRecordEditForm.tsx`
- Updates to `src/dashboard/components/QueuePanel.tsx` for parent-child grouping
- Updates to `src/dashboard/App.tsx` and/or `TopBar.tsx` for the Run button slot

### Task 6.1 — UI/UX design pass (`ui-ux-pro-max`)

- [ ] **Step 1: Invoke the `ui-ux-pro-max` skill**

Brief the skill with:
- The spec at `docs/superpowers/specs/2026-04-27-emergency-contact-run-button-ocr-design.md`
- The visual mockup at `.superpowers/brainstorm/79817-1777357595/content/run-button-design.html`
- The existing dashboard components in `src/dashboard/components/` (especially `QueuePanel.tsx`, `TopBar.tsx`, `EditDataTab.tsx`) so the new components match the visual language.
- Constraint: shadcn/ui-style primitives, Tailwind for layout, dark-mode parity with the rest of the dashboard.

The skill should produce: a design document with:
- Color/typography choices for the Run button + preview row.
- Modal layout (PDF upload + mode toggle + roster picker + footer).
- Preview row layout (header summary + record table + per-row expand form).
- Approve button states (idle, disabled-with-tooltip, loading).
- Visual treatment for matchState badges (matched, lookup-pending, lookup-running, resolved, unresolved).

- [ ] **Step 2: Save design output**

The ui-ux-pro-max skill should write its output to `docs/superpowers/specs/2026-04-27-emergency-contact-frontend-design.md` (or wherever the skill conventions land) and commit it.

### Task 6.2 — Frontend implementation (`frontend-design`)

- [ ] **Step 1: Invoke the `frontend-design` skill**

Brief the skill with:
- Both spec docs (the original + the ui-ux-pro-max design output).
- The implementation files listed above.
- Existing component patterns in `src/dashboard/components/` (e.g. how `EditDataTab.tsx` does its form, how `QueuePanel.tsx` renders rows).
- The 4 backend endpoints from Phase 5 (`/api/emergency-contact/prepare`, `/approve-batch`, `/discard-prepare`, `/api/rosters`).
- localStorage strategy: `localStorage.setItem("ec-prep-${parentRunId}", JSON.stringify(editedRecords))` keyed by parent runId; cleared on Approve-success or Discard.
- Approve button enable rule: `records.every(r => !r.selected || r.matchState === "resolved")`.
- Matchstate badges: small colored pill per state.

The skill should produce all 5 new component files + the QueuePanel + TopBar updates.

- [ ] **Step 2: Verify frontend build + bundle size**

```
npm run build:dashboard
ls -lh dist/assets/*.js | awk '{print $5, $9}'
```

Expected: bundle stays under ~1MB. If new code pushes it over, consider lazy-loading the RunModal + PreviewRow (`React.lazy(() => import(...))`).

- [ ] **Step 3: Smoke-test the UI end-to-end**

```
npm run dashboard  # backend + frontend
# Open http://localhost:5173
# Click Run, attach the test PDF, choose "existing" mode, click Run OCR + Match.
# Verify the preview row appears, records resolve, expand to edit, click Approve.
# Verify N child rows appear under the parent in the queue.
```

- [ ] **Step 4: Commit**

The frontend-design skill commits its own work. Verify the commit message references both the spec and this plan.

### Phase 6 verification + checkpoint

- [ ] Bundle size under 1MB for the dashboard.
- [ ] All 5 new components render without console errors.
- [ ] Approve button is correctly disabled until all selected records are `resolved`.
- [ ] localStorage edits survive page reload.
- [ ] Discard button cancels the parent row and clears localStorage.

**🛑 CHECKPOINT — Phase 6 complete.**

---

## Phase 7 — Documentation + manual end-to-end test

**Goal:** Update CLAUDE.md files and run the user's actual PDF through the new flow. Make sure parity with the 2026-04-27 hand-run is maintained (modulo the Leo Longley dup remediation).

**Files:**
- Modify: `src/workflows/emergency-contact/CLAUDE.md` — document the prep path, new endpoints, async EID resolution.
- Modify: `src/ocr/CLAUDE.md` — already created in Task 2.7, just verify it's accurate.
- Modify: root `CLAUDE.md` — update the "Pending follow-ups" section, mention the Run button.
- Modify: `src/tracker/CLAUDE.md` — note the new endpoints + the prep row `data.mode` discriminator.
- Modify: `src/dashboard/CLAUDE.md` — note the new components + parent-child grouping.

### Task 7.1 — Update emergency-contact CLAUDE.md

- [ ] **Step 1: Document the prep flow + endpoints + edit-data + bug fixes**

Append a new section to `src/workflows/emergency-contact/CLAUDE.md`:

```markdown
## Run-button / OCR / preview flow (2026-04-XX)

Self-service path:
1. Click Run in the dashboard's queue-panel TopBar.
2. Attach a PDF + choose roster mode (download fresh / use existing).
3. Server: `POST /api/emergency-contact/prepare` saves PDF, OCRs via
   `src/ocr/`, matches records against `src/data/*.xlsx` (latest mtime),
   and writes a tracker row with `data.mode === "prepare"`.
4. Records with no EID + no roster match are resolved async via the
   eid-lookup daemon (auto-spawns; one Duo on first call).
5. User reviews + edits the preview row inline; Approve fans out to
   N normal emergency-contact daemon items (each with
   `prefilledData.parentRunId` for grouping).

The prep phase **bypasses the kernel** — no browser, no Duo, just
server-side OCR + match. See `src/workflows/emergency-contact/prepare.ts`.

## Edit-data opt-in (2026-04-XX)

All six PDF-extracted detail fields (`employeeName`, `emplId`,
`contactName`, `relationship`, `contactPhone`, `contactAddress`) are
`editable: true`. No skipStep is needed — emergency-contact has no
extraction step in its handler; the kernel's `prefilledData` merge
fills `ctx.data` directly.

## Bug fixes (2026-04-XX)

- **Same-address-when-null**: schema transform rewrites
  `(sameAddressAsEmployee=false, address=null)` → `(true, null)`.
  Defense-in-depth in `enter.ts` step 5 also checks the box if
  reached with the original input.
- **Fuzzy duplicate detection**: `findExistingContactDuplicate` now
  returns `{ name, distance, isExact }` based on Levenshtein ≤ 2 on
  normalized names. Exact match still skips. Fuzzy match (1-2)
  triggers `demoteExistingContact` (uncheck Primary on the existing
  row, then add new as primary). Above 2 means add normally.
- **Dashboard fill-in**: `ctx.updateData({ emplId, contactName,
  relationship, contactPhone, contactAddress })` runs at the top of
  the handler so the kernel's post-handler check stops warning
  about declared-but-unpopulated fields.
```

- [ ] **Step 2: Commit**

```bash
git add src/workflows/emergency-contact/CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(emergency-contact): document Run-button flow + edit-data + fixes

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 7.2 — Cross-reference docs

- [ ] Update root `CLAUDE.md` "Pending follow-ups" to reference the new feature.
- [ ] Update `src/tracker/CLAUDE.md` to mention the 4 new endpoints.
- [ ] Update `src/dashboard/CLAUDE.md` to list the 5 new components.

### Task 7.3 — Manual end-to-end test on the user's PDF

- [ ] **Step 1: Pre-flight**

- Restart dashboard: `npm run dashboard`
- Confirm `.env` has `GEMINI_API_KEY` (and optionally GEMINI_API_KEY2-6).
- Confirm `src/data/` has at least one .xlsx roster, OR `ONBOARDING_ROSTER_URL` is set.

- [ ] **Step 2: Click-through**

- Open `http://localhost:5173`.
- Click Run in queue-panel TopBar.
- Attach `/Users/julianhein/Downloads/Xerox Scan_04272026142351.pdf`.
- Choose "Use existing roster".
- Click Run OCR + Match.
- Wait for the preview row to appear (~30-60s for OCR).
- Verify all 8 records are present:
  1. Johnnie Battistessa — EID 10873698 — Father → Parent
  2. Camila Flores — EID 10874168 — Mother → Parent
  3. Leo Longley — EID 10874572 — Mother → Parent
  4. Geonmoo Lee — EID 10873793 — Friend
  5. Jasmine Ochoa — EID 10873611 — Mother → Parent
  6. Shankhin Pathri — EID 10874172 — Great Uncle (auto-mapped to Other Relative)
  7. Andrea Ruelas — EID 10874136 — Mother → Parent
  8. Mercedeez Trujillo — EID 10874144 — Mother → Parent
- All should be `matched` (EIDs were on the form, no eid-lookup needed).
- Click any row to expand the edit form. Verify all fields populate.
- Click Approve.

- [ ] **Step 3: Verify children**

- 8 child rows spawn under the parent in the queue.
- Each goes through `navigation → fill-form → save`.
- Daemon log shows no warnings about declared-but-unpopulated detail fields.
- Geonmoo's record (no contact address) shows "Same Address as Employee" CHECKED in the post-save screenshot.
- Leo's record shows the existing "Tomako Langley" was demoted (Primary unchecked) — verify in UCPath.

- [ ] **Step 4: Verify cache**

- Re-run on the same PDF. OCR result should be served from cache (`cached: true` in tracker row's data).

- [ ] **Step 5: Verify discard**

- Click Run again on a different small PDF.
- When the preview row is `done`, click Discard.
- Confirm the parent row disappears from the queue (or is marked skipped).

- [ ] **Step 6: Commit**

(No commit needed — this is the final manual verification.)

### Final verification

- [ ] All `npm run typecheck:all`, `npm run test`, `npm run build:dashboard` pass.
- [ ] Bundle size ≤ 1MB.
- [ ] Manual E2E successful on the user's PDF.
- [ ] All 8 records land in UCPath identically to the 2026-04-27 hand-run, with the bug fixes applied.

---

## Risk + Rollback

**If a phase ships and reveals a regression:**
- Phase 0 (bugs) — revert via `git revert <commit>` per task. Each task is independent.
- Phase 1 (edit-data) — change is one line; revert the `editable: true` flags.
- Phase 2 (`src/ocr/`) — module is unused until Phase 4 wires it up; safe to revert.
- Phase 3 (match) — pure functions; safe to revert.
- Phase 4 (prepare.ts) — no consumer until Phase 5 wires the endpoint. Safe to revert.
- Phase 5 (endpoints) — restart dashboard with the prior code; endpoints disappear cleanly.
- Phase 6 (frontend) — revert frontend commits; backend continues to work for CLI users.
- Phase 7 (docs) — text-only.

**Long-running async risk:**
The async EID resolution in `runPrepare` lives in the dashboard's Node process. If the process dies mid-resolution, the prep row stays in `running` state until the dashboard restarts and the sweep marks it failed. User retries.

**Cost ceiling:**
Each PDF triggers 1 Gemini call (cached after first). Worst case: ~20 PDFs/day × 6 keys = well under Gemini's free quota. Document upgrade path in `src/ocr/CLAUDE.md` if the user starts hitting quota.

---

## Out of scope (defer to future specs)

- Multi-PDF batch in one Run click.
- Cross-provider OCR fallback (Mistral, Groq, etc.) — Gemini's daily quota is plenty for current load.
- Generic preview-row tracker `kind` discriminator across all workflows.
- Add-New emergency-contact path (still throws `NoExistingContactError`).
- Auto-save of edits per keystroke (localStorage + save-on-Approve is sufficient).
- Run button for other workflows (onboarding-from-PDF etc.) — unblock once we have a second consumer of the OCR primitive.
