import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "default" | "ghost" | "danger";
type Size = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Optional leading glyph / icon. */
  icon?: ReactNode;
}

const base =
  "inline-flex items-center justify-center gap-1.5 rounded-sm font-medium " +
  "transition-colors select-none disabled:opacity-45 disabled:pointer-events-none " +
  "whitespace-nowrap border";

const variants: Record<Variant, string> = {
  primary:
    "bg-accent text-accent-ink border-accent hover:bg-[color-mix(in_srgb,var(--accent)_88%,white)] active:brightness-95",
  default:
    "bg-bg-2 text-ink-1 border-line-2 hover:bg-bg-3 hover:border-ink-3",
  ghost:
    "bg-transparent text-ink-2 border-transparent hover:bg-bg-2 hover:text-ink-1",
  danger:
    "bg-transparent text-fail border-[color-mix(in_srgb,var(--fail)_45%,transparent)] hover:bg-[color-mix(in_srgb,var(--fail)_14%,transparent)]",
};

const sizes: Record<Size, string> = {
  sm: "h-6 px-2 text-[12px]",
  md: "h-8 px-3 text-[13px]",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", size = "md", icon, className, children, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(base, variants[variant], sizes[size], className)}
      {...rest}
    >
      {icon != null && <span className="shrink-0 [&_svg]:size-3.5">{icon}</span>}
      {children}
    </button>
  );
});
