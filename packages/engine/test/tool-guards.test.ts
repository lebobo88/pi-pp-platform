import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertBashAllowed,
  assertWriteAllowed,
  assertPathInsideCwd,
  assertEditAllowed,
  isInsideCwd,
  DestructiveCommandError,
  PathSandboxError,
  buildToolDefinitions,
} from "../src/index.js";
import { SecretsFoundError } from "@pp/core";

const cwd = mkdtempSync(join(tmpdir(), "pp-guard-"));

afterEach(() => {
  delete process.env.PP_ALLOW_DESTRUCTIVE;
});

describe("bash guard", () => {
  it("rejects rm -rf /", () => {
    expect(() => assertBashAllowed("rm -rf /", cwd)).toThrow(DestructiveCommandError);
  });

  it("rejects git push --force to a protected ref", () => {
    expect(() => assertBashAllowed("git push --force origin main", cwd)).toThrow(DestructiveCommandError);
  });

  it("allows git status", () => {
    expect(() => assertBashAllowed("git status", cwd)).not.toThrow();
  });

  it("honors PP_ALLOW_DESTRUCTIVE=1", () => {
    process.env.PP_ALLOW_DESTRUCTIVE = "1";
    expect(() => assertBashAllowed("rm -rf /", cwd)).not.toThrow();
  });
});

describe("write guard", () => {
  it("rejects content containing an AWS access key", () => {
    expect(() =>
      assertWriteAllowed(join(cwd, "creds.txt"), "aws_key = AKIAIOSFODNN7EXAMPLE", cwd),
    ).toThrow(SecretsFoundError);
  });

  it("allows clean content inside cwd", () => {
    expect(() => assertWriteAllowed(join(cwd, "ok.txt"), "hello world", cwd)).not.toThrow();
  });

  it("rejects a path that escapes the sandbox", () => {
    expect(() => assertPathInsideCwd("../evil.txt", cwd)).toThrow(PathSandboxError);
    expect(() => assertWriteAllowed(join(cwd, "..", "evil.txt"), "x", cwd)).toThrow(PathSandboxError);
  });
});

describe("edit guard", () => {
  it("scans replacement text for secrets", () => {
    expect(() =>
      assertEditAllowed(join(cwd, "f.ts"), [{ newText: "AKIAIOSFODNN7EXAMPLE" }], cwd),
    ).toThrow(SecretsFoundError);
  });
});

describe("isInsideCwd", () => {
  it("accepts nested paths and rejects parents", () => {
    expect(isInsideCwd(join(cwd, "a", "b.txt"), cwd)).toBe(true);
    expect(isInsideCwd(join(cwd, "..", "x"), cwd)).toBe(false);
  });
});

describe("buildToolDefinitions", () => {
  it("coding policy yields guarded mutators + read-only tools", () => {
    const defs = buildToolDefinitions(cwd, "coding");
    const names = defs.map((d) => d.name);
    expect(names).toContain("bash");
    expect(names).toContain("write");
    expect(names).toContain("edit");
    expect(names).toContain("read");
  });

  it("readonly policy excludes mutators", () => {
    const defs = buildToolDefinitions(cwd, "readonly");
    const names = defs.map((d) => d.name);
    expect(names).not.toContain("bash");
    expect(names).not.toContain("write");
    expect(names).not.toContain("edit");
  });
});
