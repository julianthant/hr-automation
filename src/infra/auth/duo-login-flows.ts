import type { Page } from "playwright";
import {
  loginToUCPath,
  loginToACTCrm,
  loginToUKG,
  loginToKuali,
  loginToNewKronos,
  loginToServiceNow,
  loginToOnBase,
} from "./login.js";
import { loginToI9 } from "../../systems/i9/login.js";
import { KUALI_SPACE_URL } from "../../config.js";

export interface DuoLoginFlow {
  /** Short stable key for `--systems` selection and test naming. */
  key: string;
  /** Human label for logs / pass-fail tables. */
  label: string;
  /** Adapts each login fn to a uniform `(page) => Promise<boolean>` (Kuali takes a space URL first). */
  run: (page: Page) => Promise<boolean>;
}

/**
 * Every UCSD SSO flow that goes through Duo MFA. Each must run in its own fresh
 * browser — these are independent SSO realms and must never share a context.
 *
 * With `HR_AUTOMATION_DUO_WEBAUTHN=1` every flow here approves Duo hands-off via
 * the shared WebAuthn path (arm at `clickSsoSubmit` → `selectDuoFactor`). i9
 * Complete joined this list on 2026-07-01: it now authenticates through the UCOP
 * portal via UCSD Shibboleth SSO + Duo (was standalone email/password before).
 *
 * Single source of truth for both the `test-login` CLI smoke (`src/cli.ts`) and
 * the live auth integration test (`tests/live/auth.test.ts`): adding a Duo flow
 * here automatically extends both.
 */
export const DUO_LOGIN_FLOWS: ReadonlyArray<DuoLoginFlow> = [
  { key: "ucpath", label: "UCPath", run: (page) => loginToUCPath(page) },
  { key: "crm", label: "ACT CRM", run: (page) => loginToACTCrm(page) },
  { key: "ukg", label: "UKG (OldKronos)", run: (page) => loginToUKG(page) },
  { key: "kuali", label: "Kuali Build", run: (page) => loginToKuali(page, KUALI_SPACE_URL) },
  { key: "newkronos", label: "New Kronos (WFD)", run: (page) => loginToNewKronos(page) },
  { key: "servicenow", label: "ServiceNow", run: (page) => loginToServiceNow(page) },
  { key: "onbase", label: "OnBase", run: (page) => loginToOnBase(page) },
  { key: "i9", label: "I-9 Complete", run: (page) => loginToI9(page) },
];
