function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface TelegramNotificationInput {
  title: string;
  subject?: string;
  workflow?: string;
  systemLabel?: string;
  detail?: string;
  runId?: string;
  includeDebugIds?: boolean;
}

export function renderTelegramNotification(input: TelegramNotificationInput): string {
  const lines: string[] = [];
  lines.push(`<b>${escapeHtml(input.title)}</b>`);
  if (input.subject) lines.push(escapeHtml(input.subject));
  if (input.systemLabel) lines.push(`System: ${escapeHtml(input.systemLabel)}`);
  if (input.workflow) lines.push(`Workflow: <code>${escapeHtml(input.workflow)}</code>`);
  if (input.detail) lines.push(escapeHtml(input.detail));
  if (input.includeDebugIds && input.runId) lines.push(`Run: <code>${escapeHtml(input.runId)}</code>`);
  return lines.join("\n");
}
