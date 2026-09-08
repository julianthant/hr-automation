/** The UCPath job, not merely the person, named by a separation form. */
export interface SeparationJob {
  emplRecord: string;
  positionNumber: string;
  jobCode: string;
}

/** Kuali comments and the selected student title must agree when both identify a job. */
export function parseSeparationJobCode(comment: string, studentTitle: string): string | undefined {
  const codes = new Set(Array.from(comment.matchAll(/\bSTDT\s*([234])\b/gi), (m) =>
    ({ "2": "004921", "3": "004920", "4": "004919" })[m[1]]));
  if (codes.size > 1) throw new Error(`Kuali separation comment names multiple job titles: ${comment}`);
  const selected = studentTitle.trim().match(/^(\d{4,6})\s*-/)?.[1]?.padStart(6, "0");
  const named = [...codes][0];
  if (named && selected && named !== selected) {
    throw new Error(`Kuali comment identifies ${named}, but Student Title Code identifies ${selected}; correct the form before separating a job`);
  }
  return named ?? selected;
}

/** Read the submitted Smart HR header; missing identity is an error, never a non-match. */
export function parseTerminationJobHeader(body: string): { eid: string; emplRecord: string; effectiveDate: string } {
  const eid = body.match(/Employee ID:\s*(\d+)/)?.[1];
  const emplRecord = body.match(/Employee Record:\s*(\d+)\s*\(/)?.[1];
  const effectiveDate = body.match(/Effective Date:\s*(\d{2}\/\d{2}\/\d{4})/)?.[1];
  if (!eid || emplRecord === undefined || !effectiveDate) throw new Error("Cannot verify Smart HR employee ID, employment record, and effective date");
  return { eid, emplRecord, effectiveDate };
}

/** A different concurrent job can never satisfy this form's duplicate check. */
export function matchesSeparationJob(actual: Omit<SeparationJob, "jobCode"> & { jobCode?: string }, expected: SeparationJob): boolean {
  if (!/^\d{6}$/.test(expected.jobCode)) throw new Error(`Incomplete separation job code: ${expected.jobCode}`);
  for (const job of [actual, expected]) {
    if (!/^\d+$/.test(job.emplRecord) || !/^\d{7,8}$/.test(job.positionNumber) || (job.jobCode !== undefined && !/^\d{6}$/.test(job.jobCode))) {
      throw new Error(`Incomplete separation job identity: ${JSON.stringify(job)}`);
    }
  }
  return actual.emplRecord === expected.emplRecord && actual.positionNumber === expected.positionNumber && (actual.jobCode === undefined || actual.jobCode === expected.jobCode);
}

/** Only the current instruction identifies the task; Task 2 still displays a Task 1 section. */
export function parseKualiSeparationTask(text: string): 1 | 2 {
  const match = text.match(/PLEASE REVIEW AND COMPLETE CHECKLIST\s*-\s*Task ([12])\b/);
  if (!match) throw new Error("Kuali separation task instruction is missing or unknown; refusing to edit the form");
  return match[1] === "1" ? 1 : 2;
}
