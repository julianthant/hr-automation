---
phase: 1
slug: authentication-and-project-foundation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-13
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node.js built-in test runner (node:test) + TypeScript (tsc --noEmit) |
| **Config file** | None needed -- built-in runner requires no config |
| **Quick run command** | `npx tsx --env-file=.env --test src/**/*.test.ts` |
| **Full suite command** | `npx tsx --env-file=.env --test src/**/*.test.ts && npx tsc --noEmit` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx tsc --noEmit`
- **After every plan wave:** Run `npx tsx --env-file=.env --test src/**/*.test.ts && npx tsc --noEmit`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 01-01-01 | 01 | 0 | -- | unit | `npx tsx --test src/utils/env.test.ts` | No -- Wave 0 | ⬜ pending |
| 01-01-02 | 01 | 0 | -- | unit | `npx tsx --test src/utils/log.test.ts` | No -- Wave 0 | ⬜ pending |
| 01-01-03 | 01 | 0 | -- | unit | `npx tsc --noEmit` | No -- Wave 0 | ⬜ pending |
| 01-02-01 | 02 | 1 | AUTH-01 | smoke (manual) | Manual: `npm run test-login` -- verify browser opens and UCPath loads | N/A | ⬜ pending |
| 01-02-02 | 02 | 1 | AUTH-02 | smoke (manual) | Manual: `npm run test-login` -- verify credentials entered, SSO proceeds | N/A | ⬜ pending |
| 01-02-03 | 02 | 1 | AUTH-03 | smoke (manual) | Manual: `npm run test-login` -- approve Duo, verify "Authenticated" message | N/A | ⬜ pending |
| 01-02-04 | 02 | 1 | AUTH-04 | smoke (manual) | Manual: `npm run test-login` -- verify ACT CRM shows authenticated state | N/A | ⬜ pending |
| 01-02-05 | 02 | 1 | AUTH-05 | smoke (manual) | Manual: run `npm run test-login` twice -- second should skip login | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/utils/env.test.ts` — unit test for env validation (missing vars, present vars)
- [ ] `src/utils/log.test.ts` — unit test that log output contains no PII patterns
- [ ] `tsconfig.json` — TypeScript config (created during scaffolding)
- [ ] `package.json` test script — `"test": "tsx --test src/**/*.test.ts"`

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Browser launches and navigates to UCPath | AUTH-01 | Requires live browser and real UCPath site | Run `npm run test-login`, verify browser opens and UCPath loads |
| SSO login with stored credentials | AUTH-02 | Requires real UCSD SSO and credential entry | Run `npm run test-login`, verify credentials are entered and SSO proceeds |
| Duo MFA wait + success detection | AUTH-03 | Requires human Duo MFA approval | Run `npm run test-login`, approve Duo prompt, verify "Authenticated" message |
| ACT CRM authentication | AUTH-04 | Requires live ACT CRM site | Run `npm run test-login`, verify ACT CRM shows authenticated state |
| Session reuse (skip login) | AUTH-05 | Requires valid saved session state | Run `npm run test-login` twice — second run should skip login flow |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
