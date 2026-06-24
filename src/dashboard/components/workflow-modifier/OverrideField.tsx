import { CircleDot, RotateCcw } from "lucide-react";

interface OverrideFieldProps {
  label: string;
  htmlFor?: string;
  modified: boolean;
  defaultHint?: string;
  onReset?: () => void;
  children: React.ReactNode;
}

export function OverrideField({
  label,
  htmlFor,
  modified,
  defaultHint,
  onReset,
  children,
}: OverrideFieldProps): JSX.Element {
  return (
    <div
      className={[
        "rounded-md transition-colors",
        modified ? "border-l-2 border-primary/40 pl-3" : "",
      ].join(" ")}
    >
      {/* Label row */}
      <div className="flex items-center gap-1.5 mb-1">
        {htmlFor ? (
          <label
            htmlFor={htmlFor}
            className="block text-xs uppercase tracking-wide text-muted-foreground"
          >
            {label}
          </label>
        ) : (
          <span className="block text-xs uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
        )}

        {modified && (
          <>
            <CircleDot
              aria-hidden
              className="h-3.5 w-3.5 shrink-0 text-primary"
            />
            <span className="text-xs font-medium text-primary">Modified</span>
            {onReset && (
              <button
                type="button"
                aria-label={`Reset ${label} to default`}
                onClick={onReset}
                className="ml-1 inline-flex items-center justify-center rounded p-0.5 text-muted-foreground hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
              >
                <RotateCcw aria-hidden className="h-3.5 w-3.5 shrink-0" />
              </button>
            )}
          </>
        )}
      </div>

      {/* Control */}
      {children}

      {/* Default hint */}
      {modified && defaultHint && (
        <p className="mt-1 text-xs text-muted-foreground">
          Default: {defaultHint}
        </p>
      )}
    </div>
  );
}
