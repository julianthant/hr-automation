/** The UCPath job, not merely the person, named by a separation form. */
export interface SeparationJob {
  emplRecord: string;
  positionNumber: string;
  jobCode: string;
}

/** One Workforce employment row that can be matched to a Kuali student title. */
export interface WorkforceJobChoice {
  emplRecord: string;
  jobCode: string;
  jobDescription?: string;
  hrStatus?: string;
  positionNumber?: string;
}

/** `4920` and `004920` are the same title code. Anything else is not a job code. */
export function normalizeSeparationJobCode(code: string | undefined): string {
  const digits = code?.trim().match(/^(\d{4,6})$/)?.[1];
  return digits ? digits.padStart(6, "0") : "";
}

function describeWorkforceJob(job: WorkforceJobChoice): string {
  return [
    `record ${job.emplRecord || "?"}`,
    job.hrStatus,
    normalizeSeparationJobCode(job.jobCode) || job.jobCode || "no job code",
    job.jobDescription,
    job.positionNumber ? `position ${job.positionNumber}` : "",
  ].filter(Boolean).join(" ");
}

/**
 * Pick the Workforce job the Kuali form named.
 * The requested title wins over "the one active row", including when that title
 * is already inactive, so an existing termination can be reused instead of
 * filing against a different concurrent job. Two positions with the same title
 * fail: the form does not say which position.
 */
export function selectWorkforceJobForKuali<T extends WorkforceJobChoice>(
  eid: string,
  requestedJobCode: string | undefined,
  candidates: readonly T[],
): T {
  const described = candidates.map(describeWorkforceJob).join("; ") || "no jobs";
  if (candidates.length === 0) {
    throw new Error(`EID ${eid}: Workforce listed no jobs to compare with the Kuali form.`);
  }
  const requested = normalizeSeparationJobCode(requestedJobCode);
  if (!requested) {
    if (candidates.length === 1) return candidates[0];
    const active = candidates.filter((job) => !/terminat|inactive/i.test(job.hrStatus ?? ""));
    if (active.length === 1) return active[0];
    throw new Error(
      `EID ${eid}: the Kuali form has no Student Title Code, and Workforce has more than one job (${described}). Refusing to terminate or reuse an arbitrary job.`,
    );
  }
  const matches = candidates.filter((job) => normalizeSeparationJobCode(job.jobCode) === requested);
  const unique: T[] = [];
  for (const job of matches) {
    const key = `${job.emplRecord}|${job.positionNumber ?? ""}`;
    const existing = unique.findIndex((kept) => `${kept.emplRecord}|${kept.positionNumber ?? ""}` === key);
    if (existing === -1) unique.push(job);
    else if (!unique[existing].positionNumber && job.positionNumber) unique[existing] = job;
  }
  if (unique.length === 1) return unique[0];
  const jobs = new Map<string, T>();
  for (const job of candidates) {
    const key = job.positionNumber
      ? `${job.emplRecord}|${job.positionNumber}`
      : `${job.emplRecord}|${normalizeSeparationJobCode(job.jobCode)}`;
    const kept = jobs.get(key);
    if (!kept || (!kept.positionNumber && job.positionNumber)) jobs.set(key, job);
  }
  if (jobs.size === 1) return [...jobs.values()][0];
  if (unique.length === 0) {
    throw new Error(
      `EID ${eid}: Kuali form asks for job ${requested}, but Workforce has ${described}. This run will not terminate or mark as duplicate a different job.`,
    );
  }
  throw new Error(
    `EID ${eid}: Kuali form asks for job ${requested}, and Workforce has more than one matching job (${unique.map(describeWorkforceJob).join("; ")}). The form does not say which position.`,
  );
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

/**
 * PURE: verify that an existing termination transaction's comments describe the
 * exact same termination as the expected comments.
 *
 * Permitted difference: duplicate Kuali requests (e.g. doc #4653 vs #4652 / #4651)
 * have identical substantive termination details (effective date, Last Day Worked,
 * leave clause) and differ ONLY in the Kuali form reference ("Kuali form #<docId>.").
 *
 * Substantive mismatches (different dates, different leave clauses, extraneous narrative)
 * return false.
 */
export function commentsMatchTermination(
  actualComments: string,
  expectedComments: string,
): boolean {
  const normActual = actualComments.trim();
  const normExpected = expectedComments.trim();
  if (!normActual || !normExpected) return false;
  if (normActual === normExpected) return true;

  const stripFormRef = (s: string) =>
    s.replace(/\s*Kuali\s+form\s+#\d+\.?/gi, "").trim();

  const actualBase = stripFormRef(normActual);
  const expectedBase = stripFormRef(normExpected);

  const hasActualForm = /Kuali\s+form\s+#\d+/i.test(normActual);
  const hasExpectedForm = /Kuali\s+form\s+#\d+/i.test(normExpected);

  return hasActualForm && hasExpectedForm && actualBase.length > 0 && actualBase === expectedBase;
}
