import { useRef } from "react";
import { Hash } from "lucide-react";
import { cn } from "@/lib/utils";
import { TOKEN_PALETTE } from "./blueprint-helpers.js";

interface TokenTemplateInputProps {
  id: string;
  value: string;
  placeholder?: string;
  ariaLabel: string;
  onChange: (next: string) => void;
}

/**
 * Monospace template editor for the `custom-template` scheme. Below the field, a
 * palette of `{token}` chips inserts at the caret (or appends, falling back when
 * the field isn't focused), so an operator never has to remember the vocabulary.
 */
export function TokenTemplateInput({
  id,
  value,
  placeholder,
  ariaLabel,
  onChange,
}: TokenTemplateInputProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);

  const insertToken = (token: string) => {
    const snippet = `{${token}}`;
    const el = inputRef.current;
    if (!el) {
      onChange(`${value}${snippet}`);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = `${value.slice(0, start)}${snippet}${value.slice(end)}`;
    onChange(next);
    // Restore caret just after the inserted token on the next tick.
    requestAnimationFrame(() => {
      const caret = start + snippet.length;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  return (
    <div className="space-y-2">
      <input
        id={id}
        ref={inputRef}
        type="text"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "w-full rounded-md border border-border bg-background px-2.5 py-1.5",
          "font-mono text-sm text-foreground",
          "outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        )}
      />
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-0.5 inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          <Hash aria-hidden className="h-3 w-3 shrink-0" />
          Insert
        </span>
        {TOKEN_PALETTE.map((token) => (
          <button
            key={token}
            type="button"
            onClick={() => insertToken(token)}
            className={cn(
              "rounded border border-border bg-secondary/50 px-1.5 py-0.5",
              "font-mono text-[11px] text-muted-foreground",
              "cursor-pointer transition-colors hover:bg-accent hover:text-foreground",
              "outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            {`{${token}}`}
          </button>
        ))}
      </div>
    </div>
  );
}
