import { afterEach, beforeEach } from "vitest";
import {
  assertNoUnexpectedStderr,
  installStderrWriteCapture,
  resetStderrAudit,
  setActiveTestFileForStderrAudit,
  uninstallStderrWriteCapture,
} from "./log-audit-core.js";

beforeEach((ctx) => {
  setActiveTestFileForStderrAudit(ctx.task.file?.filepath ?? "");
  resetStderrAudit();
  installStderrWriteCapture();
});

afterEach(() => {
  uninstallStderrWriteCapture();
  assertNoUnexpectedStderr();
  setActiveTestFileForStderrAudit("");
});
