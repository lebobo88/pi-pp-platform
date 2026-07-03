/**
 * Flat `--- yaml ---` frontmatter parser, ported from @pp/pilot's
 * prompts/loader.ts so core modules (agents library) can read agent prompt
 * files without depending on the pilot. Deliberately line-based: the agent
 * frontmatter is flat scalar key/value pairs (name/description/model/tools/
 * maxTurns/color), so this avoids pulling a YAML dependency into a hot path
 * and sidesteps multi-line description quoting quirks. Nested values (e.g. a
 * `skills:` list) parse as an empty string — callers that need them should
 * reach for a real YAML parser instead.
 */

export type FlatFrontmatter = Record<string, string>;

/** Parse `--- yaml --- body`. Returns empty frontmatter when absent. */
export function parseFrontmatter(md: string): { frontmatter: FlatFrontmatter; body: string } {
  // Normalize a possible UTF-8 BOM and CRLF line endings so the frontmatter
  // fence matches regardless of how the asset file was saved on disk. Locate
  // the fences with indexOf rather than a backtracking `[\s\S]*?` regex — the
  // latter is O(n^2) on prompts that have no closing fence (some executive
  // agents), which made loading the full library pathologically slow.
  const normalized = md.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { frontmatter: {}, body: md };
  const close = normalized.indexOf("\n---", 4);
  if (close < 0) return { frontmatter: {}, body: md };
  const yamlBlock = normalized.slice(4, close);
  // Body starts after the closing fence line (skip to the next newline).
  const afterFence = normalized.indexOf("\n", close + 1);
  const body = afterFence < 0 ? "" : normalized.slice(afterFence + 1);
  const frontmatter: FlatFrontmatter = {};
  for (const line of yamlBlock.split("\n")) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    frontmatter[kv[1]!] = unquote(kv[2]!.trim());
  }
  return { frontmatter, body };
}

/**
 * Strip one pair of matching surrounding quotes. The executive prompts quote
 * their descriptions (`description: "Chief Executive Officer — ..."`); a real
 * YAML parser would unwrap them, so the flat parser does too.
 */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value.endsWith(first)) {
      return value.slice(1, -1);
    }
  }
  return value;
}
