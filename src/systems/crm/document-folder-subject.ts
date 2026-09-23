/**
 * Map onboarding-roster Legal Name / Lived Name columns onto the fields
 * `buildCrmDocumentFolderName` expects: legal first/middle/last, plus lived
 * first only when it differs from legal first.
 */

export interface CrmDocumentFolderSubject {
  firstName: string;
  lastName: string;
  middleName?: string;
  livedName?: string;
}

export function folderSubjectFromLegalLived(
  legalName: string,
  livedName: string,
): CrmDocumentFolderSubject {
  const legal = parseFirstMiddleLast(legalName);
  const livedFirst = firstToken(livedName);
  const subject: CrmDocumentFolderSubject = {
    firstName: legal.firstName,
    lastName: legal.lastName,
  };
  if (legal.middleName) subject.middleName = legal.middleName;
  if (livedFirst && livedFirst.toLowerCase() !== legal.firstName.toLowerCase()) {
    subject.livedName = livedFirst;
  }
  return subject;
}

function parseFirstMiddleLast(fullName: string): {
  firstName: string;
  middleName?: string;
  lastName: string;
} {
  const tokens = fullName.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    throw new Error(`Cannot parse empty legal name`);
  }
  if (tokens.length === 1) {
    return { firstName: tokens[0], lastName: tokens[0] };
  }
  if (tokens.length === 2) {
    return { firstName: tokens[0], lastName: tokens[1] };
  }
  return {
    firstName: tokens[0],
    middleName: tokens.slice(1, -1).join(" "),
    lastName: tokens[tokens.length - 1],
  };
}

function firstToken(value: string): string {
  return value.trim().split(/\s+/).filter(Boolean)[0] ?? "";
}
