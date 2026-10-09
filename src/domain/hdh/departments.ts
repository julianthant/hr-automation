const ACCEPTED_DEPT_KEYWORDS = ["housing", "dining", "hospitality"] as const;

export function isAcceptedHdhDepartment(dept: string | undefined | null): boolean {
  if (!dept) return false;
  const normalized = dept.toLowerCase();
  return ACCEPTED_DEPT_KEYWORDS.some((keyword) => normalized.includes(keyword));
}
