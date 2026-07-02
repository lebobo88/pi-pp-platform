import { readFileSync, existsSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PRICES_PATH, ensureDirs } from "./paths.js";
import { log } from "./logger.js";
import { pricesFromCatalog } from "../catalog/config.js";

type PriceEntry = { input: number; output: number };
type PriceTable = Record<string, Record<string, PriceEntry>>;

let _cached: PriceTable | null = null;

const __dirname = dirname(fileURLToPath(import.meta.url));
// Bundled defaults at the package root (packages/core/prices.json), two levels
// above {dist,src}/util/. Seeds ~/.pair-programmer/prices.json on first read.
const BUNDLED_PATH = join(__dirname, "..", "..", "prices.json");

/** Merge provider→model price maps; `over` wins per model id. */
function mergePrices(base: PriceTable, over: PriceTable): PriceTable {
  const out: PriceTable = {};
  for (const vendor of new Set([...Object.keys(base), ...Object.keys(over)])) {
    out[vendor] = { ...(base[vendor] ?? {}), ...(over[vendor] ?? {}) };
  }
  return out;
}

export function prices(): PriceTable {
  if (_cached) return _cached;
  ensureDirs();
  if (!existsSync(PRICES_PATH)) {
    if (existsSync(BUNDLED_PATH)) {
      try { copyFileSync(BUNDLED_PATH, PRICES_PATH); }
      catch (err) { log.warn({ err }, "failed to seed prices.json from bundle"); }
    }
  }
  let fromFile: PriceTable = {};
  try {
    const text = existsSync(PRICES_PATH) ? readFileSync(PRICES_PATH, "utf8") : "{}";
    fromFile = JSON.parse(text) as PriceTable;
  } catch (err) {
    log.warn({ err }, "prices.json unreadable; using empty table");
    fromFile = {};
  }
  // The catalog is the authoring source for provider pricing; prices.json is
  // overlaid on top so hand edits there still win (and any provider absent from
  // the catalog keeps working).
  _cached = mergePrices(pricesFromCatalog(), fromFile);
  return _cached;
}

/** Compute USD cost for tokens against a model id. Falls back to 0 silently. */
export function computeCost(modelId: string, tokensIn: number, tokensOut: number): number {
  const table = prices();
  for (const vendor of Object.keys(table)) {
    const vendorTable = table[vendor];
    if (!vendorTable) continue;
    const entry = vendorTable[modelId];
    if (entry) {
      return (tokensIn * entry.input + tokensOut * entry.output) / 1_000_000;
    }
  }
  return 0;
}
