import { createServer, type Server } from "http";
import {
  readEntries,
  readLogEntries,
  listWorkflows,
  listDatesForWorkflow,
  readEntriesForDate,
  readLogEntriesForDate,
} from "./jsonl.js";
import { log } from "../utils/log.js";

let server: Server | null = null;

/** Start the live monitoring dashboard. Call once at workflow start. */
export function startDashboard(workflow: string, port: number = 3838): void {
  if (server) return;

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (url.pathname === "/api/workflows") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(listWorkflows()));
      return;
    }

    if (url.pathname === "/api/dates") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(listDatesForWorkflow(wf)));
      return;
    }

    if (url.pathname === "/api/entries") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(readEntries(wf)));
      return;
    }

    if (url.pathname === "/api/logs") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      const id = url.searchParams.get("id") ?? "";
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(readLogEntries(wf, id || undefined)));
      return;
    }

    if (url.pathname === "/events/logs") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      const id = url.searchParams.get("id") ?? "";
      const date = url.searchParams.get("date") ?? "";
      const today = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      let lastCount = 0;
      const send = () => {
        const entries = (date && date !== today)
          ? readLogEntriesForDate(wf, id || undefined, date)
          : readLogEntries(wf, id || undefined);
        if (entries.length > lastCount) {
          res.write(`data: ${JSON.stringify(entries.slice(lastCount))}\n\n`);
          lastCount = entries.length;
        }
      };
      send();
      const interval = setInterval(send, 500);
      req.on("close", () => clearInterval(interval));
      return;
    }

    if (url.pathname === "/events") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      const date = url.searchParams.get("date") ?? "";
      const today = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      const send = () => {
        const entries = (date && date !== today)
          ? readEntriesForDate(wf, date)
          : readEntries(wf);
        const workflows = listWorkflows();
        res.write(`data: ${JSON.stringify({ entries, workflows })}\n\n`);
      };
      send();
      const interval = setInterval(send, 1_000);
      req.on("close", () => clearInterval(interval));
      return;
    }

    // Serve HTML dashboard
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(getDashboardHtml(workflow));
  });

  server.listen(port, () => {
    log.step(`Live dashboard: http://localhost:${port}`);
  });
}

/** Stop the dashboard server. Call at workflow end. */
export function stopDashboard(): void {
  if (server) {
    server.close();
    server = null;
  }
}

// ─── HTML ────────────────────────────────────────────────────────────
function getDashboardHtml(defaultWorkflow: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HR Automation Control</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,700;12..96,800&family=Instrument+Sans:wght@400;500;600;700&family=Azeret+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg-root: #07090f;
  --bg-surface: #0d1117;
  --bg-elevated: #151b25;
  --bg-hover: #1a2231;
  --bg-log: #0a0d13;
  --border: #1b2130;
  --border-accent: #262f40;
  --text-1: #e6edf3;
  --text-2: #8b949e;
  --text-3: #484f58;
  --success: #3fb950;
  --danger: #f85149;
  --info: #58a6ff;
  --warning: #d29922;
  --accent: #e8b341;
  --accent-dim: rgba(232, 179, 65, 0.12);
  --radius: 10px;
  --radius-sm: 6px;
  --font-display: 'Bricolage Grotesque', system-ui, sans-serif;
  --font-body: 'Instrument Sans', system-ui, sans-serif;
  --font-mono: 'Azeret Mono', 'Fira Code', monospace;
  --ease: cubic-bezier(0.25, 0.46, 0.45, 0.94);
}

html { font-size: 15px; }
body {
  font-family: var(--font-body);
  background: var(--bg-root);
  color: var(--text-1);
  min-height: 100vh;
  overflow-x: hidden;
}

body::before {
  content: '';
  position: fixed; inset: 0;
  background: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E");
  pointer-events: none;
  z-index: 0;
}

.shell { position: relative; z-index: 1; max-width: 1400px; margin: 0 auto; padding: 28px 32px; }

/* Header */
header {
  display: flex; align-items: center; justify-content: space-between;
  padding-bottom: 24px; border-bottom: 1px solid var(--border);
  margin-bottom: 24px;
}
.logo { display: flex; align-items: center; gap: 14px; }
.logo-text {
  font-family: var(--font-display); font-weight: 700;
  font-size: 1.25rem; letter-spacing: -0.02em;
}
.logo-text span { color: var(--text-3); font-weight: 400; margin-left: 6px; }
.header-right { display: flex; align-items: center; gap: 16px; }
.live-badge {
  display: flex; align-items: center; gap: 7px;
  font-family: var(--font-mono); font-size: 0.73rem; font-weight: 500;
  color: var(--success); text-transform: uppercase; letter-spacing: 0.08em;
}
.live-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--success);
  animation: pulse 2s ease-in-out infinite;
  box-shadow: 0 0 8px rgba(63, 185, 80, 0.5);
}
@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(0.85); }
}
.clock {
  font-family: var(--font-mono); font-size: 0.8rem;
  color: var(--text-3); letter-spacing: 0.04em;
}

/* Filter Bar */
.filter-bar {
  display: flex; align-items: stretch;
  background: rgba(13, 17, 23, 0.8);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 28px;
  position: relative;
}
.filter-section {
  display: flex; align-items: center; gap: 8px;
  padding: 0;
  position: relative;
}
.filter-section + .filter-section {
  border-left: 1px solid var(--border);
}
.filter-section.workflow {
  min-width: 180px; cursor: pointer;
  padding: 12px 20px;
  transition: background 0.15s;
  border-radius: var(--radius) 0 0 var(--radius);
}
.filter-section.workflow:hover { background: var(--bg-hover); }
.filter-section.search {
  flex: 1;
}
.filter-section.search input {
  width: 100%; background: transparent; border: none; outline: none;
  font-family: var(--font-body); font-size: 0.87rem;
  color: var(--text-1); padding: 12px 16px;
}
.filter-section.search input::placeholder { color: var(--text-3); }
.filter-section.date {
  min-width: 160px; cursor: pointer;
  padding: 12px 20px;
  transition: background 0.15s;
  border-radius: 0 var(--radius) var(--radius) 0;
}
.filter-section.date:hover { background: var(--bg-hover); }

.filter-label {
  font-family: var(--font-body); font-size: 0.87rem; font-weight: 600;
  color: var(--text-1);
}
.filter-chevron {
  color: var(--text-3); font-size: 0.7rem; margin-left: auto;
}
.filter-date-label {
  font-family: var(--font-mono); font-size: 0.8rem; font-weight: 500;
  color: var(--text-2);
}
.filter-icon {
  color: var(--text-3); flex-shrink: 0;
  display: flex; align-items: center;
}
.filter-section.search .filter-icon { padding-left: 16px; }

/* Dropdown menus */
.filter-dropdown {
  position: absolute; top: 100%; left: -1px; right: -1px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-accent);
  border-radius: 0 0 var(--radius-sm) var(--radius-sm);
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
  max-height: 300px; overflow-y: auto;
  z-index: 100;
  margin-top: -1px;
}
.filter-dropdown-item {
  padding: 10px 20px;
  font-family: var(--font-body); font-size: 0.85rem;
  color: var(--text-2); cursor: pointer;
  transition: background 0.1s, color 0.1s;
  display: flex; align-items: center; justify-content: space-between;
}
.filter-dropdown-item:hover {
  background: var(--bg-hover); color: var(--text-1);
}
.filter-dropdown-item.active {
  color: var(--accent);
}
.filter-dropdown-item .today-badge {
  font-family: var(--font-mono); font-size: 0.65rem;
  color: var(--success); background: rgba(63,185,80,0.1);
  padding: 2px 6px; border-radius: 4px;
  text-transform: uppercase; letter-spacing: 0.05em;
}

/* Stats */
.stats {
  display: grid; grid-template-columns: repeat(5, 1fr); gap: 14px;
  margin-bottom: 10px;
}
.stat-card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 18px 20px; position: relative; overflow: hidden;
  transition: border-color 0.2s;
}
.stat-card:hover { border-color: var(--border-accent); }
.stat-card::after {
  content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px;
}
.stat-card.total::after { background: var(--text-2); }
.stat-card.done::after { background: var(--success); }
.stat-card.failed::after { background: var(--danger); }
.stat-card.running::after { background: var(--info); }
.stat-card.pending::after { background: var(--warning); }
.stat-value {
  font-family: var(--font-display); font-weight: 800;
  font-size: 2rem; line-height: 1; letter-spacing: -0.03em;
  margin-bottom: 6px;
}
.stat-card.done .stat-value { color: var(--success); }
.stat-card.failed .stat-value { color: var(--danger); }
.stat-card.running .stat-value { color: var(--info); }
.stat-card.pending .stat-value { color: var(--warning); }
.stat-card.total .stat-value { color: var(--text-1); }
.stat-label {
  font-family: var(--font-mono); font-size: 0.67rem; font-weight: 500;
  color: var(--text-3); text-transform: uppercase; letter-spacing: 0.1em;
}

/* Progress */
.progress-wrap {
  margin-bottom: 28px; display: flex; align-items: center; gap: 14px;
}
.progress-track {
  flex: 1; height: 6px; border-radius: 99px;
  background: var(--bg-elevated); overflow: hidden;
}
.progress-fill {
  height: 100%; border-radius: 99px;
  background: linear-gradient(90deg, var(--success), #2dd4bf);
  transition: width 0.6s var(--ease);
  position: relative;
}
.progress-fill::after {
  content: ''; position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.15) 50%, transparent 100%);
  animation: shimmer 2s ease-in-out infinite;
}
@keyframes shimmer {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}
.progress-pct {
  font-family: var(--font-mono); font-size: 0.8rem; font-weight: 600;
  color: var(--text-2); min-width: 48px; text-align: right;
}

/* Table */
.table-wrap {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
table { width: 100%; border-collapse: collapse; }
thead th {
  font-family: var(--font-mono); font-size: 0.67rem; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.1em;
  color: var(--text-3); padding: 14px 16px;
  text-align: left; background: var(--bg-elevated);
  border-bottom: 1px solid var(--border);
  position: sticky; top: 0; z-index: 2;
  white-space: nowrap;
}
tbody tr {
  border-bottom: 1px solid var(--border);
  transition: background 0.15s;
  cursor: pointer;
}
tbody tr:last-child { border-bottom: none; }
tbody tr:hover { background: var(--bg-hover); }
tbody tr.expanded { background: var(--bg-elevated); }
td {
  padding: 12px 16px; font-size: 0.87rem; vertical-align: middle;
}
.cell-id {
  font-family: var(--font-mono); font-size: 0.8rem; font-weight: 500;
  color: var(--text-1); max-width: 260px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cell-name { font-weight: 500; color: var(--text-1); }
.badge {
  display: inline-flex; align-items: center; gap: 6px;
  font-family: var(--font-mono); font-size: 0.73rem; font-weight: 600;
  padding: 4px 10px; border-radius: 99px;
  text-transform: uppercase; letter-spacing: 0.04em;
}
.badge::before {
  content: ''; width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
}
.badge-done { color: var(--success); background: rgba(63,185,80,0.1); }
.badge-done::before { background: var(--success); }
.badge-failed { color: var(--danger); background: rgba(248,81,73,0.1); }
.badge-failed::before { background: var(--danger); }
.badge-running { color: var(--info); background: rgba(88,166,255,0.1); }
.badge-running::before { background: var(--info); animation: pulse 1.5s ease-in-out infinite; }
.badge-pending { color: var(--warning); background: rgba(210,153,34,0.1); }
.badge-pending::before { background: var(--warning); }
.badge-skipped { color: var(--text-3); background: rgba(72,79,88,0.15); }
.badge-skipped::before { background: var(--text-3); }
.cell-step {
  font-family: var(--font-mono); font-size: 0.76rem;
  color: var(--text-2);
}
.cell-error {
  font-family: var(--font-mono); font-size: 0.73rem;
  color: var(--danger); max-width: 300px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cell-error:hover { white-space: normal; word-break: break-word; }
.cell-time {
  font-family: var(--font-mono); font-size: 0.76rem;
  color: var(--text-3); white-space: nowrap;
}

/* Empty state */
.empty {
  text-align: center; padding: 80px 20px;
  color: var(--text-3);
}
.empty-icon { font-size: 3rem; margin-bottom: 16px; opacity: 0.3; }
.empty-text {
  font-family: var(--font-display); font-size: 1.1rem; font-weight: 600;
  margin-bottom: 8px; color: var(--text-2);
}
.empty-sub { font-size: 0.85rem; }

/* Log panel */
.log-panel {
  background: var(--bg-log);
  border-top: 1px solid var(--border-accent);
  max-height: 0; overflow: hidden;
  transition: max-height 0.3s var(--ease), padding 0.3s var(--ease);
}
.log-panel.open {
  max-height: 420px;
  padding: 0;
}
.log-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  position: sticky; top: 0;
  background: var(--bg-log);
  z-index: 1;
}
.log-header-title {
  font-family: var(--font-mono); font-size: 0.73rem; font-weight: 600;
  color: var(--text-3); text-transform: uppercase; letter-spacing: 0.08em;
}
.log-close {
  background: none; border: none; color: var(--text-3); cursor: pointer;
  font-size: 1rem; padding: 2px 6px; border-radius: 4px;
  transition: color 0.15s, background 0.15s;
}
.log-close:hover { color: var(--text-1); background: var(--bg-elevated); }
.log-body {
  overflow-y: auto; max-height: 370px; padding: 8px 0;
}
.log-line {
  display: flex; align-items: flex-start; gap: 10px;
  padding: 3px 16px; font-size: 0.8rem; line-height: 1.5;
}
.log-line:hover { background: rgba(255,255,255,0.02); }
.log-ts {
  font-family: var(--font-mono); font-size: 0.7rem;
  color: var(--text-3); white-space: nowrap; min-width: 72px;
  padding-top: 1px;
}
.log-icon { flex-shrink: 0; width: 16px; text-align: center; padding-top: 1px; }
.log-icon.step { color: var(--info); }
.log-icon.success { color: var(--success); }
.log-icon.error { color: var(--danger); }
.log-icon.waiting { color: var(--warning); }
.log-icon.fill { color: #22d3ee; }
.log-icon.navigate { color: #94a3b8; }
.log-icon.extract { color: #e8b341; }
.log-icon.search { color: #58a6ff; }
.log-icon.select { color: #2dd4bf; }
.log-icon.auth { color: #c084fc; }
.log-icon.download { color: #3fb950; }
.log-msg {
  font-family: var(--font-mono); font-size: 0.76rem;
  color: var(--text-2); word-break: break-word;
}

/* Responsive */
@media (max-width: 900px) {
  .stats { grid-template-columns: repeat(3, 1fr); }
  .shell { padding: 16px; }
}
@media (max-width: 600px) {
  .stats { grid-template-columns: repeat(2, 1fr); }
}

/* Search clear button */
.search-clear {
  background: none; border: none; color: var(--text-3); cursor: pointer;
  padding: 4px 12px; font-size: 0.9rem; transition: color 0.15s;
}
.search-clear:hover { color: var(--text-1); }

/* Skeleton loaders */
.skeleton {
  background: linear-gradient(90deg, var(--bg-elevated) 25%, var(--bg-hover) 50%, var(--bg-elevated) 75%);
  background-size: 200% 100%;
  animation: skeletonShimmer 1.5s ease-in-out infinite;
  border-radius: 4px;
}
@keyframes skeletonShimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.skeleton-text { height: 14px; display: inline-block; }
.skeleton-number { height: 28px; width: 48px; margin-bottom: 8px; }
.skeleton-label { height: 10px; width: 64px; }
</style>
</head>
<body>
<div id="root"></div>
<script type="module">
import React, { useState, useEffect, useRef, useCallback } from 'https://esm.sh/react@19';
import { createRoot } from 'https://esm.sh/react-dom@19/client';
import htm from 'https://esm.sh/htm@3';
const html = htm.bind(React.createElement);

const DEFAULT_WF = "${defaultWorkflow}";
const TAB_ORDER = ['onboarding', 'separations', 'kronos-reports', 'eid-lookup', 'work-study'];

const WF_CONFIG = {
  'onboarding': {
    label: 'Onboarding',
    columns: ['id:Email', '_name:Employee', 'status:Status', 'step:Step', 'error:Error', 'timestamp:Time'],
    getName: r => [r.data?.firstName, r.data?.lastName].filter(Boolean).join(' '),
  },
  'eid-lookup': {
    label: 'EID Lookup',
    columns: ['id:Search Name', '_emplId:Empl ID', '_name:Name', 'status:Status', 'timestamp:Time'],
    getName: r => r.data?.name || '',
    getExtra: r => ({ emplId: r.data?.emplId || '' }),
  },
  'kronos-reports': {
    label: 'Kronos Reports',
    columns: ['id:Employee ID', '_name:Name', 'status:Status', '_saved:Saved', 'error:Notes', 'timestamp:Time'],
    getName: r => r.data?.name || '',
    getExtra: r => ({ saved: r.data?.saved || '' }),
  },
  'work-study': {
    label: 'Work Study',
    columns: ['id:Empl ID', '_name:Employee', 'status:Status', 'error:Error', 'timestamp:Time'],
    getName: r => r.data?.name || '',
  },
  'separations': {
    label: 'Separations',
    columns: ['id:Doc ID', '_name:Employee', 'status:Status', 'step:Step', 'error:Error', 'timestamp:Time'],
    getName: r => r.data?.name || r.data?.employeeName || '',
  },
};

function getConfig(wf) {
  if (WF_CONFIG[wf]) return WF_CONFIG[wf];
  return {
    label: wf.replace(/-/g, ' ').replace(/\\b\\w/g, c => c.toUpperCase()),
    columns: ['id:ID', 'status:Status', 'step:Step', 'error:Error', 'timestamp:Time'],
    getName: () => '',
  };
}

function parseColumns(cols) {
  return cols.map(c => {
    const [key, label] = c.split(':');
    return { key, label };
  });
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const STATUS_ORDER = { running: 0, pending: 1, failed: 2, skipped: 3, done: 4 };

const LOG_ICONS = {
  step: { cls: 'step', icon: '\\u2192' },
  success: { cls: 'success', icon: '\\u2713' },
  error: { cls: 'error', icon: '\\u2717' },
  waiting: { cls: 'waiting', icon: '\\u23F3' },
};

function getLogAction(level, message) {
  if (level === 'success') return { icon: '\\u2713', cls: 'success' };
  if (level === 'error') return { icon: '\\u2717', cls: 'error' };
  if (level === 'waiting') return { icon: '\\u23F3', cls: 'waiting' };
  const msg = (message || '').toLowerCase();
  if (msg.includes('fill') || msg.includes('comp rate') || msg.includes('compensation'))
    return { icon: '\\u270E', cls: 'fill' };
  if (msg.includes('click') || msg.includes('navigat'))
    return { icon: '\\u25CE', cls: 'navigate' };
  if (msg.includes('crm field') || msg.includes('extract') || msg.includes('matched label'))
    return { icon: '\\u21E3', cls: 'extract' };
  if (msg.includes('search') || msg.includes('found') || msg.includes('result') || msg.includes('person search'))
    return { icon: '\\u2315', cls: 'search' };
  if (msg.includes('select') || msg.includes('dropdown') || msg.includes('template') || msg.includes('reason'))
    return { icon: '\\u2630', cls: 'select' };
  if (msg.includes('sso') || msg.includes('duo') || msg.includes('auth') || msg.includes('credential') || msg.includes('login'))
    return { icon: '\\u26BF', cls: 'auth' };
  if (msg.includes('download') || msg.includes('pdf') || msg.includes('report'))
    return { icon: '\\u2913', cls: 'download' };
  return { icon: '\\u2192', cls: 'step' };
}

// ── Skeleton Components ──
function StatsSkeleton() {
  return html\`
    <div className="stats">
      \${Array(5).fill(0).map((_, i) => html\`
        <div key=\${i} className="stat-card">
          <div className="skeleton skeleton-number" style=\${{ animationDelay: i * 0.08 + 's' }} />
          <div className="skeleton skeleton-label" style=\${{ animationDelay: i * 0.08 + 's' }} />
        </div>
      \`)}
    </div>
  \`;
}

function TableSkeleton() {
  return html\`
    <div className="table-wrap">
      <table>
        <thead><tr>\${Array(5).fill(0).map((_, i) => html\`<th key=\${i}><div className="skeleton skeleton-text" style=\${{ width: (60 + i * 15) + 'px' }} /></th>\`)}</tr></thead>
        <tbody>
          \${Array(6).fill(0).map((_, i) => html\`
            <tr key=\${i}>
              \${Array(5).fill(0).map((_, j) => html\`
                <td key=\${j}><div className="skeleton skeleton-text" style=\${{ width: (50 + ((i + j) * 13) % 80) + 'px', animationDelay: (i * 0.05 + j * 0.02) + 's' }} /></td>
              \`)}
            </tr>
          \`)}
        </tbody>
      </table>
    </div>
  \`;
}

function LogSkeleton() {
  return html\`
    \${Array(4).fill(0).map((_, i) => html\`
      <div key=\${i} className="log-line">
        <div className="skeleton skeleton-text" style=\${{ width: '60px', animationDelay: i * 0.1 + 's' }} />
        <div className="skeleton skeleton-text" style=\${{ width: '14px', animationDelay: i * 0.1 + 's' }} />
        <div className="skeleton skeleton-text" style=\${{ width: (120 + i * 40) + 'px', animationDelay: i * 0.1 + 's' }} />
      </div>
    \`)}
  \`;
}

// ── Clock Hook ──
function useClock() {
  const [time, setTime] = useState(() => new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  useEffect(() => {
    const id = setInterval(() => {
      setTime(new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    }, 1000);
    return () => clearInterval(id);
  }, []);
  return time;
}

// ── Header ──
function Header() {
  const clock = useClock();
  return html\`
    <header>
      <div className="logo">
        <div className="logo-text">HR Automation<span>Control</span></div>
      </div>
      <div className="header-right">
        <div className="live-badge"><div className="live-dot" /><span>Live</span></div>
        <div className="clock">\${clock}</div>
      </div>
    </header>
  \`;
}

// ── FilterBar ──
function FilterBar({ activeWf, workflows, onSwitch, searchQuery, setSearchQuery, selectedDate, setSelectedDate, availableDates }) {
  const [wfOpen, setWfOpen] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const barRef = useRef(null);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e) => {
      if (barRef.current && !barRef.current.contains(e.target)) {
        setWfOpen(false);
        setDateOpen(false);
      }
    };
    document.addEventListener('click', handler, true);
    return () => document.removeEventListener('click', handler, true);
  }, []);

  const allWfs = TAB_ORDER.filter(wf => wf === activeWf || workflows.includes(wf));
  workflows.forEach(wf => { if (!allWfs.includes(wf)) allWfs.push(wf); });
  if (!allWfs.includes(activeWf)) allWfs.unshift(activeWf);

  const cfg = getConfig(activeWf);
  const today = new Date().toISOString().slice(0, 10);

  function formatDateLabel(d) {
    const parts = d.split('-');
    const dt = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function formatDateDropdown(d) {
    const parts = d.split('-');
    const dt = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }

  const searchIcon = html\`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>\`;
  const calendarIcon = html\`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>\`;

  return html\`
    <div className="filter-bar" ref=\${barRef}>
      <div className="filter-section workflow" onClick=\${() => { setWfOpen(!wfOpen); setDateOpen(false); }}>
        <span className="filter-label">\${cfg.label}</span>
        <span className="filter-chevron">\${wfOpen ? '\\u25B4' : '\\u25BE'}</span>
        \${wfOpen ? html\`
          <div className="filter-dropdown" onClick=\${(e) => e.stopPropagation()}>
            \${allWfs.map(wf => html\`
              <div key=\${wf}
                className=\${'filter-dropdown-item' + (wf === activeWf ? ' active' : '')}
                onClick=\${() => { onSwitch(wf); setWfOpen(false); }}>
                \${getConfig(wf).label}
              </div>
            \`)}
          </div>
        \` : null}
      </div>
      <div className="filter-section search">
        <span className="filter-icon">\${searchIcon}</span>
        <input type="text" placeholder="Search by ID or name..."
          value=\${searchQuery}
          onInput=\${(e) => setSearchQuery(e.target.value)}
          onClick=\${(e) => e.stopPropagation()} />
        \${searchQuery ? html\`<button className="search-clear" onClick=\${(e) => { e.stopPropagation(); setSearchQuery(''); }}>\\u2715</button>\` : null}
      </div>
      <div className="filter-section date" onClick=\${() => { setDateOpen(!dateOpen); setWfOpen(false); }}>
        <span className="filter-icon">\${calendarIcon}</span>
        <span className="filter-date-label">\${formatDateLabel(selectedDate)}</span>
        <span className="filter-chevron">\${dateOpen ? '\\u25B4' : '\\u25BE'}</span>
        \${dateOpen ? html\`
          <div className="filter-dropdown" onClick=\${(e) => e.stopPropagation()}>
            \${availableDates.length === 0 ? html\`
              <div className="filter-dropdown-item" style=\${{ color: 'var(--text-3)', cursor: 'default' }}>No dates available</div>
            \` : availableDates.map(d => html\`
              <div key=\${d}
                className=\${'filter-dropdown-item' + (d === selectedDate ? ' active' : '')}
                onClick=\${() => { setSelectedDate(d); setDateOpen(false); }}>
                <span>\${formatDateDropdown(d)}</span>
                \${d === today ? html\`<span className="today-badge">Today</span>\` : null}
              </div>
            \`)}
          </div>
        \` : null}
      </div>
    </div>
  \`;
}

// ── StatsRow ──
function StatsRow({ rows }) {
  const done = rows.filter(r => r.status === 'done').length;
  const failed = rows.filter(r => r.status === 'failed').length;
  const running = rows.filter(r => r.status === 'running').length;
  const pending = rows.filter(r => r.status === 'pending' || r.status === 'skipped').length;
  const total = rows.length;
  const cards = [
    { cls: 'total', val: total, label: 'Total' },
    { cls: 'done', val: done, label: 'Completed' },
    { cls: 'failed', val: failed, label: 'Failed' },
    { cls: 'running', val: running, label: 'Running' },
    { cls: 'pending', val: pending, label: 'Pending' },
  ];
  return html\`
    <div className="stats">
      \${cards.map(s => html\`
        <div key=\${s.cls} className=\${'stat-card ' + s.cls}>
          <div className="stat-value">\${s.val}</div>
          <div className="stat-label">\${s.label}</div>
        </div>
      \`)}
    </div>
  \`;
}

// ── ProgressBar ──
function ProgressBar({ rows }) {
  const total = rows.length;
  const done = rows.filter(r => r.status === 'done').length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return html\`
    <div className="progress-wrap">
      <div className="progress-track">
        <div className="progress-fill" style=\${{ width: pct + '%' }} />
      </div>
      <div className="progress-pct">\${pct}%</div>
    </div>
  \`;
}

// ── LogPanel ──
function LogPanel({ workflow, itemId, selectedDate, onClose }) {
  const [logs, setLogs] = useState([]);
  const bodyRef = useRef(null);
  const prevLenRef = useRef(0);

  useEffect(() => {
    if (!itemId) return;
    setLogs([]);
    prevLenRef.current = 0;
    let sseUrl = '/events/logs?workflow=' + encodeURIComponent(workflow) + '&id=' + encodeURIComponent(itemId);
    if (selectedDate) sseUrl += '&date=' + encodeURIComponent(selectedDate);
    const es = new EventSource(sseUrl);
    es.onmessage = (e) => {
      const newEntries = JSON.parse(e.data);
      setLogs(prev => [...prev, ...newEntries]);
    };
    es.onerror = () => {};
    return () => es.close();
  }, [workflow, itemId, selectedDate]);

  useEffect(() => {
    if (bodyRef.current && logs.length > prevLenRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
    prevLenRef.current = logs.length;
  }, [logs]);

  if (!itemId) return null;

  return html\`
    <tr>
      <td colSpan="99" style=\${{ padding: 0 }}>
        <div className="log-panel open">
          <div className="log-header">
            <div className="log-header-title">Logs: \${itemId}</div>
            <button className="log-close" onClick=\${onClose}>\\u2715</button>
          </div>
          <div className="log-body" ref=\${bodyRef}>
            \${logs.length === 0 ? html\`<\${LogSkeleton} />\`
            : logs.map((entry, i) => {
              const action = getLogAction(entry.level, entry.message);
              const ts = entry.ts ? new Date(entry.ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
              return html\`
                <div key=\${i} className="log-line">
                  <span className="log-ts">\${ts}</span>
                  <span className=\${'log-icon ' + action.cls}>\${action.icon}</span>
                  <span className="log-msg">\${entry.message}</span>
                </div>
              \`;
            })}
          </div>
        </div>
      </td>
    </tr>
  \`;
}

// ── Cell renderer ──
function Cell({ colKey, row, cfg }) {
  switch (colKey) {
    case 'id':
      return html\`<td className="cell-id">\${row.id}</td>\`;
    case '_name':
      return html\`<td className="cell-name">\${cfg.getName(row) || '\\u2014'}</td>\`;
    case '_emplId':
      return html\`<td className="cell-id">\${cfg.getExtra?.(row)?.emplId || '\\u2014'}</td>\`;
    case '_saved': {
      const saved = cfg.getExtra?.(row)?.saved;
      return html\`<td>\${saved ? html\`<span style=\${{ color: 'var(--success)' }}>\\u2713</span>\` : '\\u2014'}</td>\`;
    }
    case 'status':
      return html\`<td><span className=\${'badge badge-' + row.status}>\${row.status}</span></td>\`;
    case 'step':
      return html\`<td className="cell-step">\${row.step || '\\u2014'}</td>\`;
    case 'error':
      return html\`<td className="cell-error" title=\${row.error || ''}>\${row.error || ''}</td>\`;
    case 'timestamp': {
      const t = row.timestamp ? new Date(row.timestamp).toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      }) : '';
      return html\`<td className="cell-time">\${t}</td>\`;
    }
    default:
      return html\`<td>\${row[colKey] || ''}</td>\`;
  }
}

// ── DataTable ──
function DataTable({ rows, activeWf, selectedDate }) {
  const [expandedId, setExpandedId] = useState(null);
  const cfg = getConfig(activeWf);
  const columns = parseColumns(cfg.columns);

  // Reset expanded row when workflow changes
  useEffect(() => {
    setExpandedId(null);
  }, [activeWf]);

  const handleRowClick = useCallback((id) => {
    setExpandedId(prev => prev === id ? null : id);
  }, []);

  if (rows.length === 0) {
    return html\`
      <div className="table-wrap">
        <div className="empty">
          <div className="empty-icon">\\u25CE</div>
          <div className="empty-text">No entries yet</div>
          <div className="empty-sub">Data will appear here as the workflow runs</div>
        </div>
      </div>
    \`;
  }

  return html\`
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            \${columns.map(c => html\`<th key=\${c.key}>\${c.label}</th>\`)}
          </tr>
        </thead>
        <tbody>
          \${rows.map(r => html\`
            <\${React.Fragment} key=\${r.id}>
              <tr className=\${expandedId === r.id ? 'expanded' : ''}
                  onClick=\${() => handleRowClick(r.id)}>
                \${columns.map(c => html\`<\${Cell} key=\${c.key} colKey=\${c.key} row=\${r} cfg=\${cfg} />\`)}
              </tr>
              \${expandedId === r.id ? html\`
                <\${LogPanel} workflow=\${activeWf} itemId=\${r.id} selectedDate=\${selectedDate} onClose=\${(e) => { e && e.stopPropagation && e.stopPropagation(); setExpandedId(null); }} />
              \` : null}
            </\${React.Fragment}>
          \`)}
        </tbody>
      </table>
    </div>
  \`;
}

// ── App ──
function App() {
  const [activeWf, setActiveWf] = useState(DEFAULT_WF);
  const [rows, setRows] = useState([]);
  const [workflows, setWorkflows] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [availableDates, setAvailableDates] = useState([]);
  const [loading, setLoading] = useState(true);

  // Fetch available dates when workflow changes
  useEffect(() => {
    fetch('/api/dates?workflow=' + encodeURIComponent(activeWf))
      .then(r => r.json())
      .then(dates => {
        setAvailableDates(dates);
        const today = new Date().toISOString().slice(0, 10);
        if (!dates.includes(selectedDate)) setSelectedDate(dates[0] || today);
      })
      .catch(() => {});
  }, [activeWf]);

  // SSE connection includes date
  useEffect(() => {
    setLoading(true);
    const today = new Date().toISOString().slice(0, 10);
    let sseUrl = '/events?workflow=' + encodeURIComponent(activeWf);
    if (selectedDate && selectedDate !== today) sseUrl += '&date=' + encodeURIComponent(selectedDate);
    const es = new EventSource(sseUrl);
    es.onmessage = (e) => {
      const { entries, workflows: wfs } = JSON.parse(e.data);
      // Dedupe by ID, keep latest
      const latest = new Map();
      entries.forEach(en => latest.set(en.id, en));
      const deduped = [...latest.values()];
      // Sort: running first, then pending, then failed, then done
      deduped.sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9));
      setRows(deduped);
      setWorkflows(wfs || []);
      setLoading(false);
    };
    es.onerror = () => {};
    return () => es.close();
  }, [activeWf, selectedDate]);

  useEffect(() => {
    const cfg = getConfig(activeWf);
    document.title = cfg.label + ' \\u2014 HR Automation';
  }, [activeWf]);

  // Clear search when switching workflows
  const handleWorkflowChange = useCallback((wf) => {
    setActiveWf(wf);
    setSearchQuery('');
  }, []);

  // Filter rows by search query
  const cfg = getConfig(activeWf);
  const filteredRows = searchQuery
    ? rows.filter(r => {
        const q = searchQuery.toLowerCase();
        const name = (cfg.getName(r) || '').toLowerCase();
        return r.id.toLowerCase().includes(q) || name.includes(q);
      })
    : rows;

  return html\`
    <div className="shell">
      <\${Header} />
      <\${FilterBar}
        activeWf=\${activeWf}
        workflows=\${workflows}
        onSwitch=\${handleWorkflowChange}
        searchQuery=\${searchQuery}
        setSearchQuery=\${setSearchQuery}
        selectedDate=\${selectedDate}
        setSelectedDate=\${setSelectedDate}
        availableDates=\${availableDates} />
      \${loading ? html\`
        <\${StatsSkeleton} />
        <div className="progress-wrap"><div className="progress-track"><div className="progress-fill" style=\${{ width: '0%' }} /></div><div className="progress-pct">0%</div></div>
        <\${TableSkeleton} />
      \` : html\`
        <\${StatsRow} rows=\${filteredRows} />
        <\${ProgressBar} rows=\${filteredRows} />
        <\${DataTable} rows=\${filteredRows} activeWf=\${activeWf} selectedDate=\${selectedDate} />
      \`}
    </div>
  \`;
}

createRoot(document.getElementById('root')).render(html\`<\${App} />\`);
</script>
</body>
</html>`;
}
