#!/usr/bin/env node
/**
 * Regenerate the bundled provider catalog from pi's builtin model catalog.
 *
 *   node scripts/generate-catalog-providers.mjs [--date YYYY-MM-DD]
 *
 * Merges every provider pi ships (getProviders(), ~35) into
 * packages/core/catalog.json as an enabled, empty-model-map entry
 * ({display_name, enabled, env_key_hint, pi_provider, models: {}}) — models and
 * pricing for these come dynamically from pi's catalog at runtime. Existing
 * catalog entries (the curated openai/google/anthropic blocks, ladders,
 * judge_pool, pricing notes) are preserved verbatim. Then rewrites
 * assets/catalog.json identically and regenerates BOTH prices.json files as
 * exact mirrors of the catalog's per-provider pricing (pricesFromCatalog
 * logic — see packages/core/src/catalog/config.ts).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dateIdx = args.indexOf("--date");
const date = dateIdx >= 0 ? args[dateIdx + 1] : new Date().toISOString().slice(0, 10);
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error("usage: node scripts/generate-catalog-providers.mjs [--date YYYY-MM-DD]");
  process.exit(1);
}

// ── pi builtin catalog (resolved through packages/engine, the only pi consumer) ──
const piAllUrl = pathToFileURL(
  join(root, "packages", "engine", "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "all.js"),
).href;
const { builtinModels } = await import(piAllUrl);
const piProviders = builtinModels().getProviders();
console.log(`[catalog] pi ships ${piProviders.length} providers`);

// Mirror of PI_ENV_HINTS in packages/engine/src/models.ts (display-only hints;
// pi resolves the real key ladder). Providers absent here get null — e.g.
// aggregators and regional variants without one well-known env var.
const PI_ENV_HINTS = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  "google-vertex": "GOOGLE_APPLICATION_CREDENTIALS",
  deepseek: "DEEPSEEK_API_KEY",
  xai: "XAI_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  together: "TOGETHER_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  moonshotai: "MOONSHOT_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  "azure-openai": "AZURE_OPENAI_API_KEY",
  "amazon-bedrock": "AWS_ACCESS_KEY_ID",
  huggingface: "HF_TOKEN",
  minimax: "MINIMAX_API_KEY",
  zai: "ZAI_API_KEY",
  "github-copilot": "COPILOT_GITHUB_TOKEN",
};

// ── merge into the bundled catalog (curated entries win untouched) ───────────
const catalogPath = join(root, "packages", "core", "catalog.json");
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));

let added = 0;
for (const p of [...piProviders].sort((a, b) => a.id.localeCompare(b.id))) {
  if (catalog.providers[p.id]) continue; // preserve curated blocks verbatim
  catalog.providers[p.id] = {
    display_name: p.name ?? p.id,
    enabled: true,
    env_key_hint: PI_ENV_HINTS[p.id] ?? null,
    pi_provider: p.id,
    models: {},
  };
  added++;
}
catalog._updated = date;
console.log(`[catalog] added ${added} provider(s); total ${Object.keys(catalog.providers).length}`);

const catalogText = JSON.stringify(catalog, null, 2) + "\n";
writeFileSync(catalogPath, catalogText, "utf8");
writeFileSync(join(root, "assets", "catalog.json"), catalogText, "utf8");

// ── regenerate both prices.json files as exact catalog mirrors ───────────────
// (pricesFromCatalog logic: provider → model → { input, output })
const prices = {
  _comment:
    "generated from packages/core/catalog.json — edit the catalog, then re-run scripts/generate-catalog-providers.mjs",
  _updated: date,
};
for (const [id, p] of Object.entries(catalog.providers)) {
  const models = {};
  for (const [modelId, m] of Object.entries(p.models)) {
    models[modelId] = { input: m.input_per_1m, output: m.output_per_1m };
  }
  prices[id] = models;
}

const pricesText = JSON.stringify(prices, null, 2) + "\n";
writeFileSync(join(root, "packages", "core", "prices.json"), pricesText, "utf8");
writeFileSync(join(root, "assets", "prices.json"), pricesText, "utf8");

console.log(`[catalog] wrote packages/core + assets catalog.json and prices.json (_updated ${date})`);
