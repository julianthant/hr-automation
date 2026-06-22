/**
 * OnBase "Document Types" catalog — mirrors the dropdown on OnBase's Import
 * Document screen (mapped live 2026-06-22). The run modal shows all of these so
 * the operator picks the same type they would in OnBase, but only the ones with
 * a `formType` are wired end-to-end today (Emergency Contact). The rest render
 * disabled ("coming soon") until their OCR form spec + import mapping exist.
 *
 * Client-bundle file: keep it dependency-free (no systems/* imports — those can
 * pull Playwright into the bundle). The doc-type + formType strings are
 * duplicated as plain constants here on purpose.
 */
export interface OnbaseDocumentType {
  /** The exact OnBase "Document Types" dropdown value. */
  docType: string;
  /** OnBase document-type group. */
  group: "Payroll Records" | "Personnel Records";
  /** The OCR formType this maps to, or undefined when not yet wired. */
  formType?: string;
}

/** The one wired document type today. */
export const ONBASE_EMERGENCY_CONTACT_DOC_TYPE = "X_HR_Emergency Contact";
export const ONBASE_EMERGENCY_CONTACT_FORM_TYPE = "onbase-emergency-contact";

export const ONBASE_DOCUMENT_TYPES: readonly OnbaseDocumentType[] = [
  // ── Payroll Records ──
  { docType: "X_HR_Benefits", group: "Payroll Records" },
  { docType: "X_HR_Taxes", group: "Payroll Records" },
  // ── Personnel Records ──
  { docType: "X_HR_Awards and Honors", group: "Personnel Records" },
  { docType: "X_HR_Certifications and Licenses", group: "Personnel Records" },
  { docType: "X_HR_Disciplinary", group: "Personnel Records" },
  { docType: "X_HR_Education", group: "Personnel Records" },
  {
    docType: ONBASE_EMERGENCY_CONTACT_DOC_TYPE,
    group: "Personnel Records",
    formType: ONBASE_EMERGENCY_CONTACT_FORM_TYPE,
  },
  { docType: "X_HR_Employee Relations", group: "Personnel Records" },
  { docType: "X_HR_General Correspondence", group: "Personnel Records" },
  { docType: "X_HR_Hiring", group: "Personnel Records" },
  { docType: "X_HR_Job Description", group: "Personnel Records" },
  { docType: "X_HR_Labor Relations", group: "Personnel Records" },
  { docType: "X_HR_Leaves", group: "Personnel Records" },
  { docType: "X_HR_Miscellaneous", group: "Personnel Records" },
  { docType: "X_HR_Performance Evaluations", group: "Personnel Records" },
  { docType: "X_HR_Personnel Document", group: "Personnel Records" },
  { docType: "X_HR_Salary", group: "Personnel Records" },
  { docType: "X_HR_Separation", group: "Personnel Records" },
  { docType: "X_HR_Service Credit", group: "Personnel Records" },
  { docType: "X_HR_Staff Volunteers", group: "Personnel Records" },
  { docType: "X_HR_Telecommuting", group: "Personnel Records" },
  { docType: "X_HR_Timekeeping", group: "Personnel Records" },
  { docType: "X_HR_Training", group: "Personnel Records" },
  { docType: "X_HR_Work Schedule", group: "Personnel Records" },
];

/** True when a document type is wired end-to-end (has an OCR form spec). */
export function isOnbaseDocTypeWired(docType: string): boolean {
  return Boolean(ONBASE_DOCUMENT_TYPES.find((d) => d.docType === docType)?.formType);
}

/** The OCR formType for a wired document type, or undefined. */
export function onbaseDocTypeFormType(docType: string): string | undefined {
  return ONBASE_DOCUMENT_TYPES.find((d) => d.docType === docType)?.formType;
}

/** A human label for a document type (strips the `X_HR_` prefix). */
export function onbaseDocTypeLabel(docType: string): string {
  return docType.replace(/^X_HR_/, "");
}
