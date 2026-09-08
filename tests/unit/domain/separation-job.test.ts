import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { matchesSeparationJob, parseKualiSeparationTask, parseSeparationJobCode, parseTerminationJobHeader } from "../../../src/domain/separation-job.js";

describe("separation job identity", () => {
  it("distinguishes summer and academic-year forms from their comments", () => {
    assert.equal(parseSeparationJobCode("Summer position - STDT 4", "4919 - STDT 4"), "004919");
    assert.equal(parseSeparationJobCode("Academic year position - STDT 3", "4920 - STDT 3"), "004920");
    assert.throws(() => parseSeparationJobCode("STDT 3", "4919 - STDT 4"), /correct the form/);
    assert.throws(() => parseSeparationJobCode("STDT 3 and STDT 4", ""), /multiple/);
  });
  it("does not reuse Jayla's STDT 4 transaction for her STDT 3 form", () => {
    const academic = { emplRecord: "0", positionNumber: "41202096", jobCode: "004920" };
    assert.equal(matchesSeparationJob({ emplRecord: "1", positionNumber: "41079142", jobCode: "004919" }, academic), false);
    assert.equal(matchesSeparationJob(academic, academic), true);
    assert.throws(() => matchesSeparationJob(academic, { ...academic, jobCode: "" }), /Incomplete/);
    assert.equal(matchesSeparationJob({ ...academic, positionNumber: "41202099" }, academic), false);
    assert.throws(() => matchesSeparationJob({ ...academic, emplRecord: "" }, academic), /Incomplete/);
  });
  it("reads record zero and refuses an incomplete receipt", () => {
    assert.deepEqual(parseTerminationJobHeader("Effective Date: 09/02/2026 Employee ID: 10599318 Employee Record: 0 (STDT 3)"), {
      eid: "10599318", emplRecord: "0", effectiveDate: "09/02/2026",
    });
    assert.throws(() => parseTerminationJobHeader("Employee ID: 10599318"), /Cannot verify/);
  });
  it("stops on Task 2 even though its form still displays the Task 1 section", () => {
    assert.equal(parseKualiSeparationTask("PLEASE REVIEW AND COMPLETE CHECKLIST - Task 2\nTimekeeper Tasks - Step 1"), 2);
    assert.equal(parseKualiSeparationTask("PLEASE REVIEW AND COMPLETE CHECKLIST - Task 1"), 1);
    assert.throws(() => parseKualiSeparationTask("Timekeeper Tasks - Step 1"), /instruction/);
  });
});
