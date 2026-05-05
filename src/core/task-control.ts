export const CONTROL_ACTIONS = [
  "cancel-queued",
  "cancel-current",
  "drain-worker",
  "stop-worker",
  "kill-browser",
  "force-kill-worker",
] as const;

export type ControlAction = (typeof CONTROL_ACTIONS)[number];

export interface ControlActionDescription {
  action: ControlAction;
  label: string;
  browserDisruption: boolean;
  workerDisruption: boolean;
}

export function describeControlAction(action: ControlAction): ControlActionDescription {
  switch (action) {
    case "cancel-queued":
      return { action, label: "Cancel queued item", browserDisruption: false, workerDisruption: false };
    case "cancel-current":
      return { action, label: "Cancel current item", browserDisruption: false, workerDisruption: false };
    case "drain-worker":
      return { action, label: "Drain worker", browserDisruption: false, workerDisruption: true };
    case "stop-worker":
      return { action, label: "Stop worker", browserDisruption: false, workerDisruption: true };
    case "kill-browser":
      return { action, label: "Kill browser", browserDisruption: true, workerDisruption: false };
    case "force-kill-worker":
      return { action, label: "Force kill worker", browserDisruption: true, workerDisruption: true };
  }
}
