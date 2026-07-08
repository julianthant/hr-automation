import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  hasIdentifyingCrmData,
  navigatedToCrmRecordHost,
  type CrmOnboardingRecord,
} from "../../../../src/systems/crm/onboarding-records.js";

function blankRecord(patch: Partial<CrmOnboardingRecord> = {}): Pick<
  CrmOnboardingRecord,
  "name" | "ppsId" | "ucpathEmployeeId"
> {
  return { name: "", ppsId: "", ucpathEmployeeId: "", ...patch };
}

describe("hasIdentifyingCrmData", () => {
  it("returns false for a fully blank record (failed navigation / stale link)", () => {
    assert.equal(hasIdentifyingCrmData(blankRecord()), false);
  });

  it("returns false when name is just the comma/space separator with no tokens", () => {
    assert.equal(hasIdentifyingCrmData(blankRecord({ name: ", " })), false);
  });

  it("returns true when only a name is present", () => {
    assert.equal(hasIdentifyingCrmData(blankRecord({ name: "Sanchez, Raquel" })), true);
  });

  it("returns true when only a PPS ID is present", () => {
    assert.equal(hasIdentifyingCrmData(blankRecord({ ppsId: "12345" })), true);
  });

  it("returns true when only a UCPath Employee ID is present", () => {
    assert.equal(hasIdentifyingCrmData(blankRecord({ ucpathEmployeeId: "10526678" })), true);
  });
});

describe("navigatedToCrmRecordHost", () => {
  const recordUrl = "https://act-crm.my.site.com/hr/ONB_ViewOnboarding?id=abc123";

  it("returns true when the browser stayed on the same host", () => {
    assert.equal(
      navigatedToCrmRecordHost("https://act-crm.my.site.com/hr/ONB_ViewOnboarding?id=abc123", recordUrl),
      true,
    );
  });

  it("returns true even if the path drifted, as long as the host matches", () => {
    assert.equal(
      navigatedToCrmRecordHost("https://act-crm.my.site.com/hr/SomeOtherPage", recordUrl),
      true,
    );
  });

  it("returns false when redirected off-host (e.g. an SSO/login page)", () => {
    assert.equal(
      navigatedToCrmRecordHost("https://login.ucsd.edu/sso/login?returnUrl=...", recordUrl),
      false,
    );
  });

  it("returns false for a hostless current URL (e.g. about:blank)", () => {
    assert.equal(navigatedToCrmRecordHost("about:blank", recordUrl), false);
  });

  it("returns false when the current URL is malformed / unparseable", () => {
    assert.equal(navigatedToCrmRecordHost("not a url", recordUrl), false);
  });
});
