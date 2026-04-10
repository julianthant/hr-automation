import { cn } from "@/lib/utils";
import { Check, Play } from "lucide-react";
import { formatStepName } from "./types";

interface StepPipelineProps {
  steps: string[];
  currentStep: string | null;
  status: string;
}

export function StepPipeline({ steps, currentStep, status }: StepPipelineProps) {
  if (steps.length === 0) return null;

  const currentIdx = currentStep ? steps.indexOf(currentStep) : -1;
  const isDone = status === "done";
  const isFailed = status === "failed";

  return (
    <div className="flex items-center px-6 py-4 border-b border-border overflow-x-auto gap-0">
      {steps.map((step, i) => {
        const isComplete = isDone || i < currentIdx;
        const isActive = !isDone && !isFailed && i === currentIdx;
        const isPending = !isComplete && !isActive;

        return (
          <div key={step} className="flex items-center">
            {i > 0 && (
              <div className={cn(
                "w-8 h-0.5 mx-1.5 rounded-sm flex-shrink-0",
                isComplete ? "bg-[#4ade80]/30" : "bg-border",
              )} />
            )}
            <div className="flex items-center whitespace-nowrap">
              <div className={cn(
                "w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold flex-shrink-0",
                isComplete && "bg-[#4ade80]/15 text-[#4ade80]",
                isActive && "bg-primary/20 text-primary animate-pulse",
                isPending && "bg-secondary text-muted-foreground",
              )}>
                {isComplete ? <Check className="w-3 h-3" /> : isActive ? <Play className="w-3 h-3" /> : ""}
              </div>
              <div className="ml-1.5">
                <span className={cn(
                  "text-xs font-medium block",
                  isComplete && "text-[#4ade80]",
                  isActive && "text-primary font-semibold",
                  isPending && "text-muted-foreground",
                )}>
                  {formatStepName(step)}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
