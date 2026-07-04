/**
 * Text-materializer fallback — last resort for coding sessions whose model
 * returned the implementation as prose instead of tool calls.
 *
 * Some openai-compat models (deepseek reasoning mode in particular) ignore the
 * advertised tools and emit the entire change set as fenced code blocks. When a
 * session ends with zero mutating tool calls, the pipeline may parse those
 * blocks and write the files itself — through the SAME guards the write tool
 * enforces (path sandbox + secret scan). Controlled by
 * PP_TEXT_MATERIALIZE_FALLBACK (default on; set "0" to disable).
 *
 * Recognized fence header forms (the `info` string after ```):
 *   ```ts:src/App.tsx          → lang:path (deepseek's habitual format)
 *   ```json:package.json
 *   ```src-tauri/build.rs      → bare relative path (has a "/" or a "." + no spaces)
 * Blocks whose info is a plain language tag ("bash", "ts", …) are ignored —
 * they are narration, not files. Paths are validated against the session cwd.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { assertWriteAllowed } from "./tool-guards.js";

export interface FileBlock {
  /** Path exactly as written in the fence header (relative or absolute). */
  path: string;
  content: string;
}

/** True when the fallback is enabled (default on). */
export function textMaterializeFallbackEnabled(): boolean {
  return process.env.PP_TEXT_MATERIALIZE_FALLBACK !== "0";
}

/** Plain language tags that must never be mistaken for a file path. */
const LANG_ONLY = new Set([
  "bash", "sh", "shell", "zsh", "powershell", "console", "text", "txt", "md",
  "markdown", "diff", "patch", "output", "json", "yaml", "yml", "toml", "xml",
  "html", "css", "js", "jsx", "ts", "tsx", "rust", "rs", "python", "py", "go",
  "java", "c", "cpp", "h", "hpp", "sql", "ini", "env", "dockerfile", "makefile",
]);

/**
 * Extract a candidate file path from a fence info string, or null when the
 * block is narration. `lang:path` wins; a bare token qualifies only when it
 * looks like a path (contains "/" or an extension dot) and is not a known
 * language tag.
 */
export function pathFromFenceInfo(info: string): string | null {
  const trimmed = info.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const colon = trimmed.indexOf(":");
  if (colon > 0) {
    const candidate = trimmed.slice(colon + 1).trim();
    // Reject drive-letter false positives like "C" in "C:\..." being the lang:
    // a real lang:path header has a non-empty lang and a non-empty path.
    return candidate.length > 0 ? candidate : null;
  }
  const lower = trimmed.toLowerCase();
  if (LANG_ONLY.has(lower)) return null;
  if (trimmed.includes("/") || trimmed.includes("\\")) return trimmed;
  // A bare "package.json"-style token: needs a dot that isn't leading.
  if (/^[\w.-]+\.[A-Za-z0-9]+$/.test(trimmed) && !trimmed.startsWith(".")) return trimmed;
  return null;
}

/**
 * Parse fenced code blocks whose info string names a file. Handles ``` and
 * ```` fences; ignores blocks with no recognizable path. Later blocks for the
 * same path win (models sometimes emit a corrected version).
 */
export function extractFileBlocks(text: string): FileBlock[] {
  const byPath = new Map<string, string>();
  const fenceRe = /^(`{3,})([^\n`]*)\n([\s\S]*?)^\1[ \t]*$/gm;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    const path = pathFromFenceInfo(m[2] ?? "");
    if (!path) continue;
    // Normalize trailing newline: file bodies keep exactly one.
    const body = m[3]!.replace(/\n?$/, "\n");
    byPath.set(path, body);
  }
  return Array.from(byPath, ([path, content]) => ({ path, content }));
}

export interface MaterializeResult {
  written: string[];
  /** path → reason for every rejected block (sandbox escape, secrets, io error). */
  rejected: Array<{ path: string; reason: string }>;
}

/**
 * Write extracted blocks to disk under `cwd`, enforcing the same guards as the
 * write tool (path sandbox + secret scan). Never throws — per-file failures are
 * reported so a partial materialization still yields a judgeable diff.
 */
export function materializeFiles(cwd: string, blocks: FileBlock[]): MaterializeResult {
  const written: string[] = [];
  const rejected: MaterializeResult["rejected"] = [];
  for (const block of blocks) {
    const abs = isAbsolute(block.path) ? resolve(block.path) : resolve(join(cwd, block.path));
    try {
      assertWriteAllowed(abs, block.content, cwd);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, block.content, "utf8");
      written.push(block.path);
    } catch (err) {
      rejected.push({ path: block.path, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { written, rejected };
}
