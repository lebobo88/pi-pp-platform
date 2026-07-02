import { describe, it, expect } from "vitest";
import { parseUnifiedDiff, diffStats } from "./diff";

const SAMPLE = `diff --git a/src/order.ts b/src/order.ts
index 3a1f0c2..8b4e9d1 100644
--- a/src/order.ts
+++ b/src/order.ts
@@ -12,6 +12,7 @@ export interface OrderTotals {
   subtotal: number;
   tax: number;
+  discount: number;
   total: number;
 }
@@ -34,3 +35,4 @@ export function computeTotals(order: Order): OrderTotals {
   const tax = round(subtotal * order.taxRate);
-  const total = subtotal + tax;
+  const discount = order.coupon ? 5 : 0;
+  const total = subtotal + tax - discount;
`;

describe("parseUnifiedDiff", () => {
  it("parses a single-file, multi-hunk diff", () => {
    const parsed = parseUnifiedDiff(SAMPLE);
    expect(parsed.files).toHaveLength(1);
    const file = parsed.files[0]!;
    expect(file.oldPath).toBe("src/order.ts");
    expect(file.newPath).toBe("src/order.ts");
    expect(file.hunks).toHaveLength(2);
  });

  it("captures the git index/extended headers as meta", () => {
    const file = parseUnifiedDiff(SAMPLE).files[0]!;
    expect(file.meta.some((m) => m.startsWith("index "))).toBe(true);
  });

  it("assigns correct old/new line numbers", () => {
    const hunk = parseUnifiedDiff(SAMPLE).files[0]!.hunks[0]!;
    const added = hunk.lines.find((l) => l.type === "add");
    expect(added?.content).toBe("  discount: number;");
    expect(added?.oldLine).toBeNull();
    expect(added?.newLine).toBe(14);

    const context = hunk.lines.find((l) => l.type === "context");
    expect(context?.oldLine).toBe(12);
    expect(context?.newLine).toBe(12);
  });

  it("preserves hunk header parameters", () => {
    const hunk = parseUnifiedDiff(SAMPLE).files[0]!.hunks[0]!;
    expect(hunk.oldStart).toBe(12);
    expect(hunk.oldLines).toBe(6);
    expect(hunk.newStart).toBe(12);
    expect(hunk.newLines).toBe(7);
  });

  it("counts added and removed lines", () => {
    const stats = diffStats(parseUnifiedDiff(SAMPLE));
    // hunk 1: +discount field. hunk 2: +discount decl, +new total; −old total.
    expect(stats.added).toBe(3);
    expect(stats.removed).toBe(1);
  });

  it("handles CRLF input", () => {
    const parsed = parseUnifiedDiff(SAMPLE.replace(/\n/g, "\r\n"));
    expect(parsed.files[0]!.hunks).toHaveLength(2);
  });

  it("marks binary files", () => {
    const bin = `diff --git a/logo.png b/logo.png
index 111..222 100644
Binary files a/logo.png and b/logo.png differ
`;
    const file = parseUnifiedDiff(bin).files[0]!;
    expect(file.binary).toBe(true);
  });

  it("parses multiple files", () => {
    const multi = `${SAMPLE}diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,1 +1,2 @@
 # Title
+A new line.
`;
    const parsed = parseUnifiedDiff(multi);
    expect(parsed.files).toHaveLength(2);
    expect(parsed.files[1]!.newPath).toBe("README.md");
  });

  it("degrades non-diff input to one meta file", () => {
    const parsed = parseUnifiedDiff("just some plain text\nnot a diff");
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]!.hunks).toHaveLength(0);
    expect(parsed.files[0]!.meta.length).toBeGreaterThan(0);
  });

  it("returns no files for empty input", () => {
    expect(parseUnifiedDiff("").files).toHaveLength(0);
  });

  it("handles /dev/null (new file) paths", () => {
    const created = `diff --git a/new.ts b/new.ts
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+export const x = 1;
+export const y = 2;
`;
    const file = parseUnifiedDiff(created).files[0]!;
    expect(file.oldPath).toBe("/dev/null");
    expect(file.newPath).toBe("new.ts");
    const adds = file.hunks[0]!.lines.filter((l) => l.type === "add");
    expect(adds).toHaveLength(2);
    expect(adds[0]!.newLine).toBe(1);
  });
});
