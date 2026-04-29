import { toast } from "sonner";

/** Generic dispatcher signature — returns true on success. */
export type CommandDispatchResult = { ok: true } | { ok: false; reason: string };

export interface CommandRunCtx {
  workflows: string[];
  activeWorkflow: string;
  setWorkflow: (wf: string) => void;
  setDate: (date: string) => void;
  failedIds: () => string[]; // closure over current entries, returns failed IDs in active workflow
}

export interface CommandDef {
  /** Token used after the `>` prefix. */
  token: string;
  /** Render-text shown in the result list. */
  label: string;
  /** Tooltip / longer description. */
  description: string;
  /**
   * Match a query against this command. Receives the user's typed
   * arguments AFTER the `>`-stripped first word. Returns parsed args
   * or null if not a match. Match function should accept the bare
   * `> <token>` form too.
   */
  match: (rest: string) => Record<string, string> | null;
  /** Dispatch the command. */
  run: (args: Record<string, string>, ctx: CommandRunCtx) => Promise<CommandDispatchResult>;
}

export const COMMANDS: CommandDef[] = [
  {
    token: "spawn",
    label: "Spawn N daemons",
    description: "Spawn N daemons of <workflow>",
    match: (rest) => {
      const m = rest.match(/^(\d+)\s+(\S+)/);
      if (!m) return null;
      return { count: m[1], workflow: m[2] };
    },
    run: async ({ count, workflow }) => {
      try {
        const resp = await fetch("/api/daemons/spawn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workflow, count: Number(count) }),
        });
        if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };
        toast.success(`Spawning ${count} ${workflow} daemon${count === "1" ? "" : "s"}`);
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  },
  {
    token: "stop",
    label: "Stop daemons",
    description: "Stop daemons for a workflow (--force optional)",
    match: (rest) => {
      const m = rest.match(/^(\S+)(?:\s+(--force))?$/);
      if (!m) return null;
      return { workflow: m[1], force: m[2] === "--force" ? "1" : "" };
    },
    run: async ({ workflow, force }) => {
      try {
        const resp = await fetch("/api/daemons/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workflow, force: force === "1" }),
        });
        if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };
        toast.success(
          force === "1"
            ? `Force-stopping ${workflow} daemons`
            : `Stopping ${workflow} daemons`,
        );
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  },
  {
    token: "retry",
    label: "Retry failed",
    description: "Retry all failed entries in <workflow> (defaults to active)",
    match: (rest) => {
      // Accept "failed" (legacy) or "failed <workflow>"
      const m = rest.match(/^failed(?:\s+(\S+))?$/);
      if (!m) return null;
      return { workflow: m[1] || "" };
    },
    run: async ({ workflow }, ctx) => {
      const target = workflow || ctx.activeWorkflow;
      const ids = workflow && workflow !== ctx.activeWorkflow ? [] : ctx.failedIds();
      // If user typed a workflow other than active, we don't have its failed
      // ids in-process — this command only works on the active workflow today.
      if (workflow && workflow !== ctx.activeWorkflow) {
        return { ok: false, reason: `Switch to ${workflow} first to retry its failed entries` };
      }
      if (ids.length === 0) {
        return { ok: false, reason: "No failed entries to retry" };
      }
      try {
        const resp = await fetch("/api/retry-bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workflow: target, ids }),
        });
        if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };
        toast.success(`Retrying ${ids.length} failed ${target} entr${ids.length === 1 ? "y" : "ies"}`);
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  },
  {
    token: "goto",
    label: "Go to workflow",
    description: "Switch the active workflow",
    match: (rest) => {
      const m = rest.match(/^(\S+)$/);
      if (!m) return null;
      return { workflow: m[1] };
    },
    run: async ({ workflow }, ctx) => {
      if (!ctx.workflows.includes(workflow)) {
        return { ok: false, reason: `Unknown workflow: ${workflow}` };
      }
      ctx.setWorkflow(workflow);
      return { ok: true };
    },
  },
  {
    token: "jump",
    label: "Jump to date",
    description: "Set the date stepper (YYYY-MM-DD)",
    match: (rest) => {
      const m = rest.match(/^(\d{4}-\d{2}-\d{2})$/);
      if (!m) return null;
      return { date: m[1] };
    },
    run: async ({ date }, ctx) => {
      ctx.setDate(date);
      return { ok: true };
    },
  },
];

/** Find the first command whose `> <token> <args>` parse succeeds. */
export function parseCommand(query: string): { cmd: CommandDef; args: Record<string, string> } | null {
  if (!query.startsWith(">")) return null;
  const stripped = query.slice(1).trim();
  for (const cmd of COMMANDS) {
    if (!stripped.startsWith(cmd.token)) continue;
    const rest = stripped.slice(cmd.token.length).trim();
    const args = cmd.match(rest);
    if (args) return { cmd, args };
  }
  return null;
}
