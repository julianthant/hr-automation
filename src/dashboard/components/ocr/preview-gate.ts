export type PreviewPageStatus = "loading" | "ok" | "error";

export interface PreviewApprovalGateInput {
  requiredPages: number[];
  previewStatusByPage: Record<number, PreviewPageStatus | undefined>;
  selectedCount: number;
}

export interface PreviewApprovalGate {
  blocked: boolean;
  approveVisible: boolean;
  reason: string;
  loadedCount: number;
  totalCount: number;
  pendingPages: number[];
  failedPages: number[];
}

function uniqueSortedPages(pages: number[]): number[] {
  return Array.from(
    new Set(
      pages
        .filter((page) => Number.isFinite(page) && page > 0)
        .map((page) => Math.trunc(page)),
    ),
  ).sort((a, b) => a - b);
}

function formatPages(pages: number[]): string {
  if (pages.length <= 3) return pages.join(", ");
  return `${pages.slice(0, 3).join(", ")} +${pages.length - 3} more`;
}

export function derivePreviewApprovalGate(input: PreviewApprovalGateInput): PreviewApprovalGate {
  const requiredPages = uniqueSortedPages(input.requiredPages);
  const failedPages = requiredPages.filter((page) => input.previewStatusByPage[page] === "error");
  const pendingPages = requiredPages.filter((page) => input.previewStatusByPage[page] !== "ok" && input.previewStatusByPage[page] !== "error");
  const loadedCount = requiredPages.length - failedPages.length - pendingPages.length;

  if (input.selectedCount <= 0) {
    return {
      blocked: true,
      approveVisible: false,
      reason: "Select at least one reviewed record before approving.",
      loadedCount,
      totalCount: requiredPages.length,
      pendingPages,
      failedPages,
    };
  }

  if (requiredPages.length === 0) {
    return {
      blocked: true,
      approveVisible: false,
      reason: "Source preview is not available for this OCR row.",
      loadedCount,
      totalCount: 0,
      pendingPages: [],
      failedPages: [],
    };
  }

  if (failedPages.length > 0) {
    return {
      blocked: true,
      approveVisible: false,
      reason: `Preview failed for page ${formatPages(failedPages)}. Open the page URL or retry OCR before approving.`,
      loadedCount,
      totalCount: requiredPages.length,
      pendingPages,
      failedPages,
    };
  }

  if (pendingPages.length > 0) {
    return {
      blocked: true,
      approveVisible: false,
      reason: `Review source preview before approving (${loadedCount}/${requiredPages.length} page${requiredPages.length === 1 ? "" : "s"} loaded).`,
      loadedCount,
      totalCount: requiredPages.length,
      pendingPages,
      failedPages,
    };
  }

  return {
    blocked: false,
    approveVisible: true,
    reason: "",
    loadedCount,
    totalCount: requiredPages.length,
    pendingPages: [],
    failedPages: [],
  };
}
