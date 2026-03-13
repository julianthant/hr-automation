---
phase: 2
slug: data-extraction-from-act-crm
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-13
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node.js built-in test runner (node:test) + TypeScript (tsc --noEmit) |
| **Config file** | none — built-in runner requires no config |
| **Quick run command** | `npx tsx --test src/**/*.test.ts` |
| **Full suite command** | `npx tsx --test src/**/*.test.ts && npx tsc --noEmit` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx tsx --test src/extraction/schema.test.ts && npx tsc --noEmit`
- **After every plan wave:** Run `npx tsx --test src/**/*.test.ts && npx tsc --noEmit`
- **Before `/gsd:verify-work`:** Full suite must be green + manual `npm run extract <test-email>`
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 02-01-01 | 01 | 1 | EXTR-05 | unit | `npx tsx --test src/extraction/schema.test.ts` | ❌ W0 | ⬜ pending |
| 02-01-02 | 01 | 1 | EXTR-05 | unit | `npx tsc --noEmit` | ✅ | ⬜ pending |
| 02-02-01 | 02 | 2 | EXTR-01 | manual | `npm run extract <email>` — verify search executes | N/A | ⬜ pending |
| 02-02-02 | 02 | 2 | EXTR-02 | manual | `npm run extract <email>` — verify correct row selected | N/A | ⬜ pending |
| 02-02-03 | 02 | 2 | EXTR-03 | manual | `npm run extract <email>` — verify navigation to entry sheet | N/A | ⬜ pending |
| 02-02-04 | 02 | 2 | EXTR-04 | manual | `npm run extract <email>` — verify all fields extracted | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/extraction/schema.test.ts` — unit tests for Zod schema validation (valid data passes, missing fields rejected, malformed SSN/postal code rejected, error messages are human-readable)
- [ ] `package.json` script — add `"extract": "tsx --env-file=.env src/cli.ts extract"` script

*Existing infrastructure covers TypeScript compilation check.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Search ACT CRM by email | EXTR-01 | Requires live authenticated ACT CRM session | Run `npm run extract <email>`, verify search input is filled and submitted |
| Select latest date row | EXTR-02 | Requires live search results from ACT CRM | Run `npm run extract <email>`, verify correct row (latest date) is clicked |
| Navigate to UCPath Entry Sheet | EXTR-03 | Requires live ACT CRM profile page | Run `npm run extract <email>`, verify entry sheet page loads |
| Extract all required fields | EXTR-04 | Requires live UCPath Entry Sheet with real data | Run `npm run extract <email>`, verify all 10 fields extracted |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
