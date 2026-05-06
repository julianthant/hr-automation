import { cn } from "@/lib/utils";

export interface CtaButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant: "primary" | "outline";
  children: React.ReactNode;
}

export function CtaButton({ variant, className, children, style, ...rest }: CtaButtonProps) {
  const isPrimary = variant === "primary";
  const base = cn(
    "inline-flex items-center justify-center gap-1.5 rounded-[7px] px-3.5 py-2.5 font-sans text-[12.5px] font-medium",
    "border transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
    "disabled:cursor-not-allowed",
    "cursor-pointer",
    className,
  );
  const variantStyle = isPrimary
    ? {
        backgroundColor: "transparent",
        color: "var(--capture-fg-primary)",
        borderColor: "var(--capture-border-cta)",
      }
    : {
        backgroundColor: "transparent",
        color: "var(--capture-fg-muted)",
        borderColor: "var(--capture-border-subtle)",
      };
  const disabledStyle = rest.disabled
    ? {
        color: "var(--capture-fg-faint)",
        borderColor: "var(--capture-border-subtle)",
        cursor: "not-allowed" as const,
      }
    : {};
  return (
    <button
      {...rest}
      className={base}
      style={{
        ...variantStyle,
        ...disabledStyle,
        ["--tw-ring-color" as string]: "var(--capture-focus-ring)",
        ["--tw-ring-offset-color" as string]: "var(--capture-bg-modal)",
        ...style,
      }}
      onMouseOver={(e) => {
        if (!rest.disabled) {
          (e.currentTarget as HTMLButtonElement).style.borderColor = isPrimary
            ? "var(--capture-border-cta-strong)"
            : "var(--capture-border-cta)";
        }
        rest.onMouseOver?.(e);
      }}
      onMouseOut={(e) => {
        if (!rest.disabled) {
          (e.currentTarget as HTMLButtonElement).style.borderColor = isPrimary
            ? "var(--capture-border-cta)"
            : "var(--capture-border-subtle)";
        }
        rest.onMouseOut?.(e);
      }}
    >
      {children}
    </button>
  );
}
