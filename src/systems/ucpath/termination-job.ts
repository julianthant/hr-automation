import type { FrameLocator, Page } from "playwright";
import { matchesSeparationJob, parseSeparationJobCode, parseTerminationJobHeader, type SeparationJob } from "../../domain/separation-job.js";
import { getContentFrame, jobData, smartHR, ssSmartHRTransactions } from "./selectors.js";
import { waitForPeopleSoftProcessing } from "./navigate.js";

/** Select only the employment record resolved from this Kuali form's job. */
export async function selectTerminationEmploymentRecord(page: Page, job: SeparationJob): Promise<void> {
  const frame = getContentFrame(page);
  await ssSmartHRTransactions.emplIdInput(frame).press("Tab");
  await waitForPeopleSoftProcessing(frame, 15_000);
  const record = smartHR.employmentRecordSelect(frame);
  await record.selectOption(job.emplRecord);
  // Changing record refreshes the reason-code control. Select the reason only AFTER this round trip.
  await waitForPeopleSoftProcessing(frame, 15_000);
  if (await record.inputValue() !== job.emplRecord) throw new Error(`UCPath did not select employment record ${job.emplRecord}`);
}

/** Editable and submitted forms render the same job as inputs and spans respectively (live 2026-09-08). */
export async function readTerminationJob(frame: FrameLocator): Promise<Omit<SeparationJob, "jobCode"> & { jobCode?: string; eid: string; effectiveDate: string }> {
  const body = await smartHR.transactionBody(frame).innerText();
  const header = parseTerminationJobHeader(body);
  const positionInput = jobData.positionNumberInput(frame);
  const positionNumber = await positionInput.count() === 1
    ? await positionInput.inputValue()
    : body.match(/\b(\d{7,8})\s+Position Number\b/)?.[1];
  const title = body.match(/Employee Record:\s*\d+\s*\(([^)]+)\)/)?.[1];
  const jobCode = title ? parseSeparationJobCode(title, "") : undefined;
  if (!positionNumber) throw new Error(`Cannot verify the position for EID ${header.eid}, record ${header.emplRecord}`);
  return { ...header, positionNumber, jobCode };
}

/** Required immediately before a termination submission or transaction-number reuse. */
export async function verifyTerminationJob(frame: FrameLocator, eid: string, job: SeparationJob, effectiveDate: string): Promise<void> {
  const actual = await readTerminationJob(frame);
  if (actual.eid !== eid || actual.effectiveDate !== effectiveDate || !matchesSeparationJob(actual, job)) {
    throw new Error(`Wrong UCPath termination job: expected ${eid}/${job.emplRecord}/${job.positionNumber}/${effectiveDate}; got ${JSON.stringify(actual)}`);
  }
}
