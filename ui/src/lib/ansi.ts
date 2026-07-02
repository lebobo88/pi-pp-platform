/**
 * Minimal ANSI SGR parser for the LogPane. Supports the subset sub-CLIs
 * actually emit: reset, bold, dim, and the 16 standard foreground colors
 * (30–37, 90–97). Unknown codes are ignored (their text still renders). This
 * is deliberately not a full terminal emulator — no cursor movement, no
 * background 256/truecolor — just enough to keep log output readable.
 */

export interface AnsiSpan {
  text: string;
  /** Named color (maps to a CSS var in LogPane), or null for default ink. */
  color: AnsiColor | null;
  bold: boolean;
  dim: boolean;
}

export type AnsiColor =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white";

const FG: Record<number, AnsiColor> = {
  30: "black",
  31: "red",
  32: "green",
  33: "yellow",
  34: "blue",
  35: "magenta",
  36: "cyan",
  37: "white",
  90: "black",
  91: "red",
  92: "green",
  93: "yellow",
  94: "blue",
  95: "magenta",
  96: "cyan",
  97: "white",
};

// eslint-disable-next-line no-control-regex
const SGR_RE = /\x1b\[([0-9;]*)m/g;

/** Parse one line of possibly-ANSI text into styled spans. */
export function parseAnsi(line: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let color: AnsiColor | null = null;
  let bold = false;
  let dim = false;

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  SGR_RE.lastIndex = 0;

  const emit = (text: string) => {
    if (text.length === 0) return;
    spans.push({ text, color, bold, dim });
  };

  while ((match = SGR_RE.exec(line)) !== null) {
    emit(line.slice(lastIndex, match.index));
    lastIndex = SGR_RE.lastIndex;

    const codes = (match[1] ?? "").split(";").filter((c) => c !== "");
    if (codes.length === 0) {
      // Bare ESC[m === reset.
      color = null;
      bold = false;
      dim = false;
      continue;
    }
    for (const raw of codes) {
      const code = parseInt(raw, 10);
      if (code === 0) {
        color = null;
        bold = false;
        dim = false;
      } else if (code === 1) {
        bold = true;
      } else if (code === 2) {
        dim = true;
      } else if (code === 22) {
        bold = false;
        dim = false;
      } else if (code === 39) {
        color = null;
      } else if (FG[code]) {
        color = FG[code]!;
      }
      // Everything else (background, underline, 256/truecolor) is ignored.
    }
  }
  emit(line.slice(lastIndex));

  // A line with no styling still yields one span so callers can render simply.
  if (spans.length === 0) spans.push({ text: line, color: null, bold: false, dim: false });
  return spans;
}

/** Strip all SGR codes from a string (for copy-to-clipboard). */
export function stripAnsi(s: string): string {
  return s.replace(SGR_RE, "");
}
