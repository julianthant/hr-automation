import type { ReactNode } from "react";

export interface PrepReviewPageLayoutProps {
  pdfPreview: ReactNode;
  sticky?: boolean;
  formCards: ReactNode | ReactNode[];
  title?: ReactNode;
  /** Full-width block (e.g. lookup screenshots) between the title and the columns. */
  screenshotStrip?: ReactNode;
}

function normalizeFormCards(formCards: ReactNode | ReactNode[]): ReactNode[] {
  return Array.isArray(formCards) ? formCards : [formCards];
}

/**
 * Shared two-column prep review layout: PDF page on the left, form card(s)
 * on the right. Multi-record pages pass `sticky` so the PDF stays in view
 * while the operator scrolls the row stack.
 */
export function PrepReviewPageLayout({
  pdfPreview,
  sticky = false,
  formCards,
  title,
  screenshotStrip,
}: PrepReviewPageLayoutProps) {
  const cards = normalizeFormCards(formCards);
  const pdfColumnClass = sticky ? "sticky top-4 self-start" : "self-start";
  const stackForm = sticky || cards.length > 1;

  return (
    <div className="p-4">
      {title ? (
        <div className="mb-3 rounded-lg border border-border bg-card px-4 py-3">
          {title}
        </div>
      ) : null}
      {screenshotStrip ? (
        <div className="mb-3 rounded-lg border border-border bg-card px-4 py-3">
          {screenshotStrip}
        </div>
      ) : null}
      <div className="grid grid-cols-[minmax(420px,1.15fr)_minmax(360px,0.85fr)] gap-4">
        <div className={pdfColumnClass}>{pdfPreview}</div>
        <div className={stackForm ? "flex flex-col gap-3" : undefined}>
          {cards.map((card, i) => (
            <div key={i}>{card}</div>
          ))}
        </div>
      </div>
    </div>
  );
}
