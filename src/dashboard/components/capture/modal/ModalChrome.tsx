import { X } from "lucide-react";
import {
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { CaptureState } from "../capture-types.js";

export interface ModalChromeProps {
  state: CaptureState;
  workflow: string;
  workflowLabel?: string;
  contextHint?: string;
  onClose: () => void;
}

export function ModalChrome({ state, workflow, workflowLabel, contextHint, onClose }: ModalChromeProps) {
  void state; // accent rail removed — state-driven color is gone in C system
  void workflow;
  void workflowLabel;
  void contextHint;
  return (
    <DialogHeader className="relative grid gap-3 px-[38px] pt-[36px] pb-0 space-y-0 border-b-0">
      <div className="flex flex-col gap-1.5" style={{ maxWidth: 360 }}>
        <DialogTitle
          className="text-[15px] font-normal tracking-[-0.005em]"
          style={{ color: "var(--capture-fg-primary)" }}
        >
          Capture session
        </DialogTitle>
        <DialogDescription
          className="text-[12px] leading-[1.55]"
          style={{ color: "var(--capture-fg-muted)" }}
        >
          Scan the QR with your phone, capture pages, then tap Done.
        </DialogDescription>
      </div>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute right-[14px] top-[14px] inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2"
        style={{
          backgroundColor: "transparent",
          color: "var(--capture-fg-muted)",
          border: "1px solid transparent",
          ["--tw-ring-color" as string]: "var(--capture-focus-ring)",
        }}
        onMouseOver={(e) => {
          e.currentTarget.style.borderColor = "var(--capture-border-strong)";
          e.currentTarget.style.color = "var(--capture-fg-secondary)";
        }}
        onMouseOut={(e) => {
          e.currentTarget.style.borderColor = "transparent";
          e.currentTarget.style.color = "var(--capture-fg-muted)";
        }}
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
      <hr
        aria-hidden
        className="m-0 border-0"
        style={{ borderTop: "1px solid var(--capture-border-subtle)" }}
      />
    </DialogHeader>
  );
}
