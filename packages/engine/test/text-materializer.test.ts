import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pathFromFenceInfo,
  extractFileBlocks,
  materializeFiles,
  textMaterializeFallbackEnabled,
} from "../src/text-materializer.js";

describe("pathFromFenceInfo", () => {
  it("extracts the path from lang:path headers", () => {
    expect(pathFromFenceInfo("json:package.json")).toBe("package.json");
    expect(pathFromFenceInfo("tsx:src/App.tsx")).toBe("src/App.tsx");
    expect(pathFromFenceInfo("rust:src-tauri/src/main.rs")).toBe("src-tauri/src/main.rs");
  });

  it("accepts bare relative paths", () => {
    expect(pathFromFenceInfo("src-tauri/build.rs")).toBe("src-tauri/build.rs");
    expect(pathFromFenceInfo("package.json")).toBe("package.json");
  });

  it("rejects plain language tags and narration", () => {
    expect(pathFromFenceInfo("bash")).toBeNull();
    expect(pathFromFenceInfo("ts")).toBeNull();
    expect(pathFromFenceInfo("json")).toBeNull();
    expect(pathFromFenceInfo("")).toBeNull();
    expect(pathFromFenceInfo("two words")).toBeNull();
    expect(pathFromFenceInfo(".gitignore-style-hidden")).toBeNull();
  });
});

describe("extractFileBlocks", () => {
  it("parses the deepseek lang:path narration format (the run_pIgGjPhWo59e shape)", () => {
    const text = [
      "I'll create the app. Below I write all necessary files.",
      "",
      "```json:package.json",
      '{ "name": "snake-calc" }',
      "```",
      "",
      "```tsx:src/App.tsx",
      "export default function App() { return null; }",
      "```",
      "",
      "Now I commit all files.",
      "",
      "```bash",
      "git add -A && git commit -m nope",
      "```",
    ].join("\n");
    const blocks = extractFileBlocks(text);
    expect(blocks.map((b) => b.path)).toEqual(["package.json", "src/App.tsx"]);
    expect(blocks[0]!.content).toBe('{ "name": "snake-calc" }\n');
  });

  it("later duplicate paths win", () => {
    const text = "```ts:a.ts\nold\n```\n\n```ts:a.ts\nnew\n```\n";
    const blocks = extractFileBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.content).toBe("new\n");
  });

  it("returns empty for pure prose", () => {
    expect(extractFileBlocks("no code here")).toEqual([]);
  });
});

describe("materializeFiles", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pp-materialize-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("writes files under cwd, creating directories", () => {
    const res = materializeFiles(cwd, [
      { path: "src/deep/nested.txt", content: "hello\n" },
      { path: "top.md", content: "# hi\n" },
    ]);
    expect(res.written).toEqual(["src/deep/nested.txt", "top.md"]);
    expect(res.rejected).toEqual([]);
    expect(readFileSync(join(cwd, "src/deep/nested.txt"), "utf8")).toBe("hello\n");
  });

  it("rejects paths escaping the sandbox without throwing", () => {
    const res = materializeFiles(cwd, [
      { path: "../escape.txt", content: "nope\n" },
      { path: "ok.txt", content: "fine\n" },
    ]);
    expect(res.written).toEqual(["ok.txt"]);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0]!.path).toBe("../escape.txt");
    expect(existsSync(join(cwd, "..", "escape.txt"))).toBe(false);
  });
});

describe("textMaterializeFallbackEnabled", () => {
  const prev = process.env.PP_TEXT_MATERIALIZE_FALLBACK;
  afterEach(() => {
    if (prev === undefined) delete process.env.PP_TEXT_MATERIALIZE_FALLBACK;
    else process.env.PP_TEXT_MATERIALIZE_FALLBACK = prev;
  });

  it("defaults on, disabled only by '0'", () => {
    delete process.env.PP_TEXT_MATERIALIZE_FALLBACK;
    expect(textMaterializeFallbackEnabled()).toBe(true);
    process.env.PP_TEXT_MATERIALIZE_FALLBACK = "0";
    expect(textMaterializeFallbackEnabled()).toBe(false);
    process.env.PP_TEXT_MATERIALIZE_FALLBACK = "1";
    expect(textMaterializeFallbackEnabled()).toBe(true);
  });
});
