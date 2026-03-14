---
phase: 3
slug: ucpath-transaction-entry
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-14
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node.js built-in test runner (node:test) + TypeScript (tsc --noEmit) |
| **Config file** | tsconfig.test.json (extends base tsconfig) |
| **Quick run command** | `npm test` |
| **Full suite command** | `npm test && npm run typecheck:all` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npm test && npm run typecheck:all`
- **After every plan wave:** Run `npm test && npm run typecheck:all`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 03-01-01 | 01 | 1 | ENTR-05 | unit | `npm test` (ActionPlan unit tests) | No -- Wave 0 | pending |
| 03-01-02 | 01 | 1 | ENTR-05 | unit | `npm test` (TransactionError types) | No -- Wave 0 | pending |
| 03-01-03 | 01 | 1 | ENTR-01 | smoke (manual) | Manual: `npm run create-transaction <email>` | N/A | pending |
| 03-01-04 | 01 | 1 | ENTR-02 | smoke (manual) | Manual: `npm run create-transaction <email>` | N/A | pending |
| 03-01-05 | 01 | 1 | ENTR-03 | smoke (manual) | Manual: `npm run create-transaction <email>` | N/A | pending |
| 03-01-06 | 01 | 1 | ENTR-04 | smoke (manual) | Manual: `npm run create-transaction <email>` | N/A | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

- [ ] `tests/unit/action-plan.test.ts` -- unit tests for ActionPlan (preview output, execute order, step numbering)
- [ ] `tests/unit/transaction-types.test.ts` -- unit tests for TransactionError, TransactionResult types
- [ ] `package.json` scripts -- add `create-transaction` and `create-transaction:dry` scripts

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Navigate UCPath to Smart HR Transactions | ENTR-01 | Requires live authenticated UCPath session with Duo MFA | Run `npm run create-transaction <email>`, verify navigation reaches Smart HR page |
| Select UC_FULL_HIRE template | ENTR-02 | Requires live UCPath session | Run `npm run create-transaction <email>`, verify template selected |
| Enter effective date | ENTR-03 | Requires live UCPath session | Run `npm run create-transaction <email>`, verify date entered |
| Click Create Transaction | ENTR-04 | Requires live UCPath session | Run `npm run create-transaction <email>`, verify transaction created or specific error |
| Dry-run shows all steps without submitting | ENTR-05 | Partial -- unit tests cover ActionPlan logic, manual verifies no UCPath modification | Run `npm run create-transaction:dry <email>`, verify no form modified |

---

## Validation Sign-Off

- [ ] All tasks have automated verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
