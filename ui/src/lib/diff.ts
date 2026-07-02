/**
 * Hand-rolled unified-diff parser.
 *
 * Parses the `diff --git` / `@@` unified format into a structured model the
 * DiffView renderer walks. Intentionally dependency-free and forgiving: input
 * that isn't a recognizable diff degrades to a single meta block rather than
 * throwing, because the daemon occasionally hands us plain patches, raw git
 * output, or `git diff` with extended headers.
 */

export type DiffLineType = "add" | "del" | "context" | "meta" | "hunk";

export interface DiffLine {
  type: DiffLineType;
  /** Line text WITHOUT the leading +/-/space marker (raw for hunk/meta). */
  content: string;
  /** 1-based line number in the old file, or null (adds, hunk, meta). */
  oldLine: number | null;
  /** 1-based line number in the new file, or null (dels, hunk, meta). */
  newLine: number | null;
}

export interface DiffHunk {
  /** The full `@@ -a,b +c,d @@ section` header line. */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffFile {
  oldPath: string | null;
  newPath: string | null;
  /** Extended-header lines (rename, mode, index, binary marker). */
  meta: string[];
  hunks: DiffHunk[];
  binary: boolean;
}

export interface ParsedDiff {
  files: DiffFile[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function newFile(): DiffFile {
  return { oldPath: null, newPath: null, meta: [], hunks: [], binary: false };
}

/** Strip a `a/` or `b/` prefix git prepends to paths. */
function stripPrefix(path: string): string {
  if (path === "/dev/null") return path;
  return path.replace(/^[ab]\//, "");
}

export function parseUnifiedDiff(input: string): ParsedDiff {
  const files: DiffFile[] = [];
  if (!input) return { files };

  const rawLines = input.replace(/\r\n?/g, "\n").split("\n");
  let current: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLineNo = 0;
  let newLineNo = 0;

  const pushFile = (f: DiffFile | null) => {
    if (f) files.push(f);
  };

  for (const line of rawLines) {
    // New file boundary.
    if (line.startsWith("diff --git")) {
      pushFile(current);
      current = newFile();
      hunk = null;
      current.meta.push(line);
      const m = line.match(/^diff --git (\S+) (\S+)$/);
      if (m && m[1] && m[2]) {
        current.oldPath = stripPrefix(m[1]);
        current.newPath = stripPrefix(m[2]);
      }
      continue;
    }

    // A bare `--- ` without a preceding `diff --git` also opens a file.
    if (line.startsWith("--- ")) {
      if (!current) {
        current = newFile();
        hunk = null;
      }
      current.oldPath = stripPrefix(line.slice(4).trim());
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (!current) current = newFile();
      current.newPath = stripPrefix(line.slice(4).trim());
      continue;
    }

    // Hunk header.
    const hm = line.match(HUNK_RE);
    if (hm) {
      if (!current) {
        current = newFile();
      }
      oldLineNo = parseInt(hm[1] ?? "0", 10);
      newLineNo = parseInt(hm[3] ?? "0", 10);
      hunk = {
        header: line,
        oldStart: oldLineNo,
        oldLines: hm[2] ? parseInt(hm[2], 10) : 1,
        newStart: newLineNo,
        newLines: hm[4] ? parseInt(hm[4], 10) : 1,
        lines: [
          { type: "hunk", content: line, oldLine: null, newLine: null },
        ],
      };
      current.hunks.push(hunk);
      continue;
    }

    // Binary marker.
    if (/^Binary files? /.test(line) || /^GIT binary patch/.test(line)) {
      if (!current) current = newFile();
      current.binary = true;
      current.meta.push(line);
      continue;
    }

    // Inside a hunk: +/-/space content.
    if (hunk) {
      const marker = line[0];
      if (marker === "+") {
        hunk.lines.push({ type: "add", content: line.slice(1), oldLine: null, newLine: newLineNo++ });
        continue;
      }
      if (marker === "-") {
        hunk.lines.push({ type: "del", content: line.slice(1), oldLine: oldLineNo++, newLine: null });
        continue;
      }
      if (marker === " ") {
        hunk.lines.push({ type: "context", content: line.slice(1), oldLine: oldLineNo++, newLine: newLineNo++ });
        continue;
      }
      if (line.startsWith("\\")) {
        // "\ No newline at end of file" — attach as meta, no counter change.
        hunk.lines.push({ type: "meta", content: line, oldLine: null, newLine: null });
        continue;
      }
      // Empty trailing line within/after a hunk → treat as empty context.
      if (line === "") {
        hunk.lines.push({ type: "context", content: "", oldLine: oldLineNo++, newLine: newLineNo++ });
        continue;
      }
      // Anything else ends the hunk and is file-level meta.
      hunk = null;
    }

    // Extended git headers (index, mode, rename, similarity).
    if (current && line !== "") {
      current.meta.push(line);
    }
  }

  pushFile(current);

  // If we saw nothing diff-shaped, expose the raw input as one meta-only file.
  if (files.length === 0 && input.trim() !== "") {
    files.push({
      ...newFile(),
      meta: input.replace(/\r\n?/g, "\n").split("\n"),
    });
  }

  return { files };
}

/** Count added / removed lines across a parsed diff (for a summary chip). */
export function diffStats(parsed: ParsedDiff): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const file of parsed.files) {
    for (const h of file.hunks) {
      for (const l of h.lines) {
        if (l.type === "add") added++;
        else if (l.type === "del") removed++;
      }
    }
  }
  return { added, removed };
}
