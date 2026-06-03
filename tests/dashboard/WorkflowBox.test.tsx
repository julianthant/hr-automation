import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../_utils/render-with-providers";
import type { WorkflowInstanceState, AuthState } from "@/components/shared/types";

// WorkflowBox resolves its icon + step pipeline from the WorkflowsContext via
// `useWorkflow`. The context object isn't exported (so no provider can wrap it),
// and the real provider fetches `/api/workflow-definitions` async. Mock the
// hook to return a small, stable metadata record instead.
vi.mock("@/lib/workflows-context", () => ({
  useWorkflow: (name: string) => ({
    name,
    label: name,
    iconName: "Workflow",
    // Two steps so the micro step pipeline renders; "fill-award" is the
    // current step in the in-flight fixture.
    steps: ["auth", "fill-award", "submit"],
    systems: ["ucpath"],
    detailFields: [],
  }),
}));

import { WorkflowBox } from "@/components/terminal-drawer/WorkflowBox";

function browser(system: string, authState: AuthState) {
  return { browserId: `${system}-1`, system, authState };
}

function session(
  partial: Partial<WorkflowInstanceState> & { instance: string; workflow: string },
): WorkflowInstanceState {
  return {
    active: true,
    pidAlive: true,
    currentItemId: null,
    currentTraceId: null,
    itemInFlight: false,
    currentStep: null,
    finalStatus: null,
    sessions: [],
    ...partial,
  } as WorkflowInstanceState;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WorkflowBox subtitle resolution", () => {
  it("shows the current trace id as the subtitle when one is set", () => {
    renderWithProviders(
      <WorkflowBox
        workflow={session({
          instance: "Onboarding 1",
          workflow: "onboarding",
          currentTraceId: "on-022400-9f1a",
          itemInFlight: true,
          currentItemId: "Maria Gonzalez",
          currentStep: "fill-award",
          sessions: [{ sessionId: "s1", browsers: [browser("ucpath", "authed")] }],
        })}
      />,
    );
    const card = screen.getByRole("article", { name: /Onboarding 1 session/i });
    expect(within(card).getByText("on-022400-9f1a")).toBeInTheDocument();
  });

  it("falls back to the phase subline when no trace id is set (authenticating N/M)", () => {
    renderWithProviders(
      <WorkflowBox
        workflow={session({
          instance: "Separation 1",
          workflow: "separations",
          currentTraceId: null,
          currentStep: "auth",
          // 1 of 2 browsers authed → "Authenticating 1/2".
          sessions: [
            {
              sessionId: "s2",
              browsers: [browser("ucpath", "authed"), browser("kuali", "authenticating")],
            },
          ],
        })}
      />,
    );
    const card = screen.getByRole("article", { name: /Separation 1 session/i });
    expect(within(card).getByText("Authenticating 1/2")).toBeInTheDocument();
  });

  it("keeps the last run's trace id as the subtitle on an idle daemon", () => {
    renderWithProviders(
      <WorkflowBox
        workflow={session({
          instance: "Person Lookup 1",
          workflow: "person-lookup",
          currentTraceId: "pl-093100-bb02",
          daemonPhase: "idle",
          sessions: [{ sessionId: "s5", browsers: [browser("crm", "authed")] }],
        })}
      />,
    );
    const card = screen.getByRole("article", { name: /Person Lookup 1 session/i });
    expect(within(card).getByText("pl-093100-bb02")).toBeInTheDocument();
  });
});

describe("WorkflowBox displayInstance ordinal stripping", () => {
  it("strips a trailing space-ordinal from the card title", () => {
    renderWithProviders(
      <WorkflowBox
        workflow={session({
          instance: "Oath Upload 2",
          workflow: "oath-upload",
          sessions: [{ sessionId: "s3", browsers: [browser("ucpath", "authed")] }],
        })}
      />,
    );
    const card = screen.getByRole("article", { name: /Oath Upload 2 session/i });
    // Title text drops the " 2"; the full numbered identity stays in the
    // hover title / aria-label.
    expect(within(card).getByText("Oath Upload")).toBeInTheDocument();
    expect(within(card).queryByText("Oath Upload 2")).not.toBeInTheDocument();
  });

  it("strips a lone trailing ' 1' as well (every instance, not just >1)", () => {
    renderWithProviders(
      <WorkflowBox
        workflow={session({
          instance: "Onboarding 1",
          workflow: "onboarding",
          sessions: [{ sessionId: "s1", browsers: [browser("ucpath", "authed")] }],
        })}
      />,
    );
    const card = screen.getByRole("article", { name: /Onboarding 1 session/i });
    expect(within(card).getByText("Onboarding")).toBeInTheDocument();
    expect(within(card).queryByText("Onboarding 1")).not.toBeInTheDocument();
  });
});

describe("WorkflowBox daemon-log section", () => {
  it("renders the daemon-log toggle even with zero entries", () => {
    renderWithProviders(
      <WorkflowBox
        workflow={session({
          instance: "Emergency Contact 1",
          workflow: "emergency-contact",
          currentStep: "auth",
          sessions: [{ sessionId: "s9", browsers: [browser("ucpath", "authenticating")] }],
          recentDaemonLogs: [],
        })}
      />,
    );
    expect(screen.getByText("Daemon log (0)")).toBeInTheDocument();
  });

  it("counts entries and reveals the empty/non-empty body on expand", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <WorkflowBox
        workflow={session({
          instance: "Onboarding 1",
          workflow: "onboarding",
          itemInFlight: true,
          currentStep: "fill-award",
          sessions: [{ sessionId: "s1", browsers: [browser("ucpath", "authed")] }],
          recentDaemonLogs: [
            { ts: "2026-05-19T12:50:00.000Z", level: "info", message: "Daemon ready" },
            { ts: "2026-05-19T12:53:00.000Z", level: "error", message: "Selector timeout" },
          ],
        })}
      />,
    );
    expect(screen.getByText("Daemon log (2)")).toBeInTheDocument();
    // Body is collapsed until the toggle is clicked.
    expect(screen.queryByText("Selector timeout")).not.toBeInTheDocument();
    await user.click(screen.getByText("Daemon log (2)"));
    expect(screen.getByText("Selector timeout")).toBeInTheDocument();
    expect(screen.getByText("Daemon ready")).toBeInTheDocument();
  });
});

describe("WorkflowBox auth-state tiles", () => {
  it("labels each browser tile by its auth state", () => {
    renderWithProviders(
      <WorkflowBox
        workflow={session({
          instance: "Oath Upload 1",
          workflow: "oath-upload",
          currentStep: "auth",
          sessions: [
            {
              sessionId: "s3",
              browsers: [browser("ucpath", "duo_waiting"), browser("crm", "authed")],
            },
          ],
        })}
      />,
    );
    // authLabel map: authed → "Ready", duo_waiting → "Duo".
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("Duo")).toBeInTheDocument();
  });

  it("applies a distinct color token per auth state (authed vs duo_waiting vs authenticating)", () => {
    const tints: Record<string, string> = {};
    for (const state of ["authed", "duo_waiting", "authenticating"] as const) {
      const { unmount } = renderWithProviders(
        <WorkflowBox
          workflow={session({
            instance: `Card ${state}`,
            workflow: "onboarding",
            currentStep: "auth",
            sessions: [{ sessionId: "x", browsers: [browser("ucpath", state)] }],
          })}
        />,
      );
      // The auth label text node carries the per-state color class.
      const label = screen.getByText(
        state === "authed" ? "Ready" : state === "duo_waiting" ? "Duo" : "Authing",
      );
      tints[state] = label.className;
      unmount();
    }
    // authColor map: authed=#4ade80, duo_waiting=#fbbf24, authenticating=#60a5fa.
    expect(tints.authed).toContain("#4ade80");
    expect(tints.duo_waiting).toContain("#fbbf24");
    expect(tints.authenticating).toContain("#60a5fa");
    expect(tints.authed).not.toBe(tints.duo_waiting);
    expect(tints.duo_waiting).not.toBe(tints.authenticating);
  });
});
