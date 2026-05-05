import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { routeNotification } from "../../../src/domain/notifications/policy.js";
import { renderTelegramNotification } from "../../../src/domain/notifications/render.js";

describe("notification policy", () => {
  it("routes auth waiting to Telegram and dashboard toast", () => {
    assert.deepEqual(routeNotification({ category: "auth", occasion: "waiting" }), {
      dashboardToast: true,
      telegram: true,
    });
  });

  it("keeps debug events out of operator notifications", () => {
    assert.deepEqual(routeNotification({ category: "debug", occasion: "recorded" }), {
      dashboardToast: false,
      telegram: false,
    });
  });

  it("renders Telegram text with subject and without run id by default", () => {
    const text = renderTelegramNotification({
      title: "Duo prompt",
      subject: "Oath Signature EID 00123456",
      workflow: "oath-signature",
      systemLabel: "UCPath",
      runId: "019df1ce-hidden",
    });
    assert.match(text, /Oath Signature EID 00123456/);
    assert.doesNotMatch(text, /019df1ce-hidden/);
  });
});
