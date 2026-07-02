/**
 * Minimal className joiner. Filters falsy values so conditional classes read
 * cleanly: cn("base", active && "active", disabled ? "muted" : null).
 */
export type ClassValue = string | number | false | null | undefined;

export function cn(...parts: ClassValue[]): string {
  let out = "";
  for (const p of parts) {
    if (!p && p !== 0) continue;
    out += (out ? " " : "") + p;
  }
  return out;
}
