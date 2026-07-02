/**
 * Tool guards — wrap pi's built-in tool definitions with the platform's safety
 * checks before delegating to the real implementation:
 *
 *  - bash  → @pp/core evaluateShellSafety (blocks destructive commands unless
 *            PP_ALLOW_DESTRUCTIVE=1),
 *  - write → path-sandbox (refuse writes outside cwd) + @pp/core scanForSecrets,
 *  - edit  → path-sandbox + scanForSecrets over every replacement's newText.
 *
 * read/grep/find/ls are read-only and pass through unguarded. The `coding`
 * policy returns guarded mutators + read-only tools; the `readonly` policy
 * returns only read-only tools.
 */
import { isAbsolute, resolve, sep } from "node:path";
import {
  createBashToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createGrepToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { evaluateShellSafety, scanForSecrets, SecretsFoundError } from "@pp/core";

export type ToolPolicy = "coding" | "readonly";

/** Error thrown when a shell command is judged destructive. */
export class DestructiveCommandError extends Error {
  constructor(
    public readonly command: string,
    public readonly pattern: string | undefined,
    reason: string | undefined,
  ) {
    super(`blocked destructive shell command${pattern ? ` (${pattern})` : ""}: ${reason ?? command}`);
    this.name = "DestructiveCommandError";
  }
}

/** Error thrown when a tool targets a path outside the session sandbox. */
export class PathSandboxError extends Error {
  constructor(public readonly path: string, cwd: string) {
    super(`path "${path}" escapes the session sandbox root "${cwd}"`);
    this.name = "PathSandboxError";
  }
}

// ─── Pure guard checks (exported for tests) ──────────────────────────────────

/**
 * Throw {@link DestructiveCommandError} if the command is destructive.
 * Honors PP_ALLOW_DESTRUCTIVE=1 as an escape hatch.
 */
export function assertBashAllowed(command: string, cwd: string): void {
  if (process.env.PP_ALLOW_DESTRUCTIVE === "1") return;
  const verdict = evaluateShellSafety(command, cwd);
  if (verdict.decision === "block") {
    throw new DestructiveCommandError(command, verdict.pattern, verdict.reason);
  }
}

/** Case-fold on Windows so drive-letter/casing differences don't defeat the prefix check. */
function fold(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/** True when `target` is inside (or equal to) `root`. */
export function isInsideCwd(target: string, cwd: string): boolean {
  const root = fold(resolve(cwd));
  const resolved = fold(isAbsolute(target) ? resolve(target) : resolve(cwd, target));
  if (resolved === root) return true;
  return resolved.startsWith(root + sep) || resolved.startsWith(root + "/");
}

/** Throw {@link PathSandboxError} if `path` resolves outside `cwd`. */
export function assertPathInsideCwd(path: string, cwd: string): void {
  if (!isInsideCwd(path, cwd)) throw new PathSandboxError(path, cwd);
}

/** Throw {@link SecretsFoundError} if `text` contains a recognized secret. */
export function assertNoSecrets(text: string): void {
  const matches = scanForSecrets(text);
  if (matches.length > 0) throw new SecretsFoundError(matches);
}

/** Full write guard: path-sandbox then secret-scan. */
export function assertWriteAllowed(path: string, content: string, cwd: string): void {
  assertPathInsideCwd(path, cwd);
  assertNoSecrets(content);
}

/** Full edit guard: path-sandbox then secret-scan over replacement text. */
export function assertEditAllowed(
  path: string,
  edits: ReadonlyArray<{ newText: string }>,
  cwd: string,
): void {
  assertPathInsideCwd(path, cwd);
  assertNoSecrets(edits.map((e) => e.newText).join("\n"));
}

// ─── Guarded tool definitions ────────────────────────────────────────────────

/**
 * Wrap a ToolDefinition's execute with a pre-check that runs on the validated
 * params. Preserves every other field (schema, rendering, metadata).
 */
function withPreCheck<T extends ToolDefinition<any, any, any>>(
  base: T,
  check: (params: any) => void,
): T {
  const wrapped: ToolDefinition<any, any, any> = {
    ...base,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      check(params);
      return base.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
  return wrapped as T;
}

export function guardedBashTool(cwd: string): ToolDefinition<any, any, any> {
  return withPreCheck(createBashToolDefinition(cwd), (p: { command: string }) =>
    assertBashAllowed(p.command, cwd),
  );
}

export function guardedWriteTool(cwd: string): ToolDefinition<any, any, any> {
  return withPreCheck(createWriteToolDefinition(cwd), (p: { path: string; content: string }) =>
    assertWriteAllowed(p.path, p.content, cwd),
  );
}

export function guardedEditTool(cwd: string): ToolDefinition<any, any, any> {
  return withPreCheck(
    createEditToolDefinition(cwd),
    (p: { path: string; edits: Array<{ oldText: string; newText: string }> }) =>
      assertEditAllowed(p.path, p.edits, cwd),
  );
}

/**
 * Build the tool set for a coding/readonly session as ToolDefinition[] suitable
 * for `createAgentSession({ noTools: "all", customTools })`.
 */
export function buildToolDefinitions(cwd: string, policy: ToolPolicy): ToolDefinition<any, any, any>[] {
  if (policy === "readonly") {
    // Root pi export ships no `createReadOnlyToolDefinitions`, so compose the
    // read-only tool set from the individual definition factories.
    return [
      createReadToolDefinition(cwd),
      createGrepToolDefinition(cwd),
      createFindToolDefinition(cwd),
      createLsToolDefinition(cwd),
    ];
  }
  return [
    guardedBashTool(cwd),
    guardedWriteTool(cwd),
    guardedEditTool(cwd),
    createReadToolDefinition(cwd),
    createGrepToolDefinition(cwd),
    createFindToolDefinition(cwd),
    createLsToolDefinition(cwd),
  ];
}
