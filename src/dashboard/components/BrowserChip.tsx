import { cn } from "@/lib/utils";
import { Check, X, KeyRound, Loader2, Hourglass } from "lucide-react";
import type { AuthState } from "./types";

interface BrowserChipProps {
  system: string;
  authState: AuthState;
}

const chipStyles: Record<AuthState, string> = {
  idle: "bg-[#22222a] text-[#555] border-[#2a2a35]",
  authenticating: "bg-[#2563eb22] text-[#60a5fa] border-[#2563eb44]",
  authed: "bg-[#16a34a22] text-[#4ade80] border-[#16a34a33]",
  duo_waiting: "bg-[#eab30822] text-[#fbbf24] border-[#eab30833] animate-duo-glow",
  failed: "bg-[#ef444422] text-[#f87171] border-[#ef444444]",
};

const chipIcons: Record<AuthState, React.ReactNode> = {
  idle: <Hourglass className="w-3 h-3" />,
  authenticating: <Loader2 className="w-3 h-3 animate-spin" />,
  authed: <Check className="w-3 h-3" />,
  duo_waiting: <KeyRound className="w-3 h-3" />,
  failed: <X className="w-3 h-3" />,
};

export function BrowserChip({ system, authState }: BrowserChipProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium border",
        chipStyles[authState],
      )}
    >
      {chipIcons[authState]}
      {system}
    </span>
  );
}
