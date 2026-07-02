#!/usr/bin/env node
// parity/audit.mjs — verify parity/matrix.yaml against the built platform.
//
// For each row: run its verify checks (asset-count / export / test; todo &
// endpoint are pending markers that skip). A status=done row FAILS the audit if
// any real check fails (or it has no verifiable checks). status=pending rows are
// reported but never fail the build. Prints a per-subsystem scoreboard and exits
// nonzero iff a done row failed.
//
// Usage: node parity/audit.mjs [--results <comma-separated-green-packages>]
//   --results is accepted for forward-compat (test rows currently verify by
//   file existence + substring, not by re-running suites).

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const matrix = parse(readFileSync(join(__dirname, "matrix.yaml"), "utf8"));
const rows = Array.isArray(matrix?.rows) ? matrix.rows : [];

// ── module loader (cached) ───────────────────────────────────────────────────
const modCache = new Map();
async function loadModule(rel) {
  if (modCache.has(rel)) return modCache.get(rel);
  const abs = join(ROOT, rel);
  let entry;
  if (!existsSync(abs)) {
    entry = { mod: null, err: `module not built: ${rel}` };
  } else {
    try {
      entry = { mod: await import(pathToFileURL(abs).href), err: null };
    } catch (e) {
      entry = { mod: null, err: e.message };
    }
  }
  modCache.set(rel, entry);
  return entry;
}

function countFiles(dir, ext) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return -1;
  let n = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (extname(e.name) === ext) n++;
    }
  };
  walk(abs);
  return n;
}

async function runCheck(c) {
  switch (c.type) {
    case "asset-count": {
      const got = countFiles(c.dir, c.ext);
      return got === c.expect
        ? { status: "pass", detail: `${c.dir}/**/*${c.ext} = ${got}` }
        : { status: "fail", detail: `${c.dir}/**/*${c.ext} = ${got}, expected ${c.expect}` };
    }
    case "export": {
      const { mod, err } = await loadModule(c.module);
      if (err) return { status: "fail", detail: `import ${c.module}: ${err}` };
      const sym = mod[c.symbol];
      if (c.op === "defined") {
        return sym !== undefined
          ? { status: "pass", detail: `${c.symbol} defined` }
          : { status: "fail", detail: `${c.symbol} undefined in ${c.module}` };
      }
      if (c.op === "len") {
        const got = sym?.length;
        return got === c.expect
          ? { status: "pass", detail: `${c.symbol}.length = ${got}` }
          : { status: "fail", detail: `${c.symbol}.length = ${got}, expected ${c.expect}` };
      }
      if (c.op === "keys-len") {
        const got = sym && typeof sym === "object" ? Object.keys(sym).length : undefined;
        return got === c.expect
          ? { status: "pass", detail: `Object.keys(${c.symbol}).length = ${got}` }
          : { status: "fail", detail: `Object.keys(${c.symbol}).length = ${got}, expected ${c.expect}` };
      }
      if (c.op === "call-len") {
        if (typeof sym !== "function") return { status: "fail", detail: `${c.symbol} is not callable` };
        let got;
        try { got = sym()?.length; } catch (e) { return { status: "fail", detail: `${c.symbol}() threw: ${e.message}` }; }
        return got === c.expect
          ? { status: "pass", detail: `${c.symbol}().length = ${got}` }
          : { status: "fail", detail: `${c.symbol}().length = ${got}, expected ${c.expect}` };
      }
      return { status: "fail", detail: `unknown export op "${c.op}"` };
    }
    case "test": {
      const abs = join(ROOT, c.file);
      if (!existsSync(abs)) return { status: "fail", detail: `missing test file ${c.file}` };
      if (c.contains) {
        const txt = readFileSync(abs, "utf8");
        if (!txt.includes(c.contains)) return { status: "fail", detail: `${c.file} missing "${c.contains}"` };
      }
      return { status: "pass", detail: `${c.file}${c.contains ? ` ⊇ "${c.contains}"` : ""}` };
    }
    case "todo":
      return { status: "skip", detail: c.note ?? "todo" };
    case "endpoint":
      return { status: "skip", detail: `endpoint ${c.path}: ${c.note ?? ""}` };
    default:
      return { status: "fail", detail: `unknown check type "${c.type}"` };
  }
}

async function main() {
  const failures = [];
  const scoreboard = new Map(); // subsystem -> {done, pending, donePass, doneFail}

  for (const row of rows) {
    const checks = Array.isArray(row.verify) ? row.verify : [];
    const results = [];
    for (const c of checks) results.push({ check: c, ...(await runCheck(c)) });
    const real = results.filter((r) => r.status !== "skip");

    let verdict;
    if (row.status === "done") {
      if (real.length === 0) verdict = "FAIL"; // a done row must be verifiable
      else verdict = real.every((r) => r.status === "pass") ? "PASS" : "FAIL";
    } else {
      verdict = real.some((r) => r.status === "fail") ? "PENDING*" : "PENDING";
    }

    const sub = row.subsystem ?? "unknown";
    if (!scoreboard.has(sub)) scoreboard.set(sub, { done: 0, pending: 0, donePass: 0, doneFail: 0 });
    const s = scoreboard.get(sub);
    if (row.status === "done") {
      s.done++;
      if (verdict === "PASS") s.donePass++;
      else { s.doneFail++; failures.push({ row, results }); }
    } else {
      s.pending++;
    }
  }

  // ── scoreboard ──
  console.log("\n══ pi-pp-platform parity scoreboard ═══════════════════════════════════════");
  const pad = (s, n) => String(s).padEnd(n);
  const padL = (s, n) => String(s).padStart(n);
  console.log(`${pad("subsystem", 30)} ${padL("done", 6)} ${padL("pass", 6)} ${padL("fail", 6)} ${padL("pend", 6)}`);
  console.log("─".repeat(78));
  let tDone = 0, tPass = 0, tFail = 0, tPend = 0;
  for (const [sub, s] of [...scoreboard.entries()].sort()) {
    console.log(`${pad(sub, 30)} ${padL(s.done, 6)} ${padL(s.donePass, 6)} ${padL(s.doneFail, 6)} ${padL(s.pending, 6)}`);
    tDone += s.done; tPass += s.donePass; tFail += s.doneFail; tPend += s.pending;
  }
  console.log("─".repeat(78));
  console.log(`${pad("TOTAL", 30)} ${padL(tDone, 6)} ${padL(tPass, 6)} ${padL(tFail, 6)} ${padL(tPend, 6)}`);
  console.log(`\nrows: ${rows.length} total | ${tDone} done (${tPass} verified, ${tFail} failing) | ${tPend} pending`);

  // ── failure detail ──
  if (failures.length) {
    console.log("\n✗ FAILING done rows:");
    for (const { row, results } of failures) {
      console.log(`  [${row.id}] ${row.subsystem} — ${row.capability}`);
      for (const r of results) {
        if (r.status === "fail") console.log(`      ✗ ${r.detail}`);
      }
      if (results.filter((r) => r.status !== "skip").length === 0) {
        console.log(`      ✗ status=done but no verifiable checks`);
      }
    }
    console.log(`\nPARITY AUDIT FAILED: ${failures.length} done row(s) failed verification.`);
    process.exit(1);
  }

  console.log("\n✓ parity audit passed: every done row verified.\n");
}

main().catch((err) => {
  console.error("parity audit crashed:", err);
  process.exit(1);
});
