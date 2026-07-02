/**
 * Session file naming helpers.
 *
 * Coding sessions are named `<role>-<attempt>.jsonl` under a caller-provided
 * session directory. The session id (used by pi's SessionManager and reflected
 * in the filename) must satisfy pi's validator:
 *   /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/
 */
import { join } from "node:path";

/** Sanitize an arbitrary role label into a valid session-id token. */
export function sanitizeRole(role: string): string {
  const cleaned = role.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  return cleaned.length > 0 ? cleaned : "role";
}

export interface SessionRef {
  /** pi session id, e.g. "author-0". */
  id: string;
  /** File basename, e.g. "author-0.jsonl". */
  basename: string;
  /** Absolute path within the session dir. */
  path: string;
}

export function makeSessionRef(sessionDir: string, role: string, attempt: number): SessionRef {
  const id = `${sanitizeRole(role)}-${attempt}`;
  const basename = `${id}.jsonl`;
  return { id, basename, path: join(sessionDir, basename) };
}
