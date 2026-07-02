#!/usr/bin/env node
/**
 * Live end-to-end validation — the real answer to "does the product actually
 * work against real providers", not just the fake-engine plumbing tests.
 *
 * Runs a REAL generation with one provider/model and a REAL cross-provider
 * critique with another, then asserts on the actual output (non-empty text,
 * output tokens > 0, a parseable verdict). Non-zero exit on any failure.
 *
 * Defaults: generate with deepseek/deepseek-v4-flash, judge with openai/gpt-5.4.
 * Override via env:
 *   PP_VALIDATE_GEN_PROVIDER / PP_VALIDATE_GEN_MODEL
 *   PP_VALIDATE_JUDGE_PROVIDER / PP_VALIDATE_JUDGE_MODEL
 *
 * Requires the relevant provider keys configured (Providers UI or env). Run:
 *   pnpm validate:live
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const enginePath = pathToFileURL(join(root, "packages", "engine", "dist", "index.js")).href;

const {
  createPlatformAuthStorage,
  ModelCatalog,
  resolveProviderApiKey,
  runAuthoringCompletion,
  critique,
  listPiModels,
} = await import(enginePath);

const GEN_PROVIDER = process.env.PP_VALIDATE_GEN_PROVIDER ?? "deepseek";
const GEN_MODEL = process.env.PP_VALIDATE_GEN_MODEL ?? "deepseek-v4-flash";
const JUDGE_PROVIDER = process.env.PP_VALIDATE_JUDGE_PROVIDER ?? "openai";
const JUDGE_MODEL = process.env.PP_VALIDATE_JUDGE_MODEL ?? "gpt-5.4";

const fail = (msg) => { console.error(`\n❌ ${msg}`); process.exit(1); };
const ok = (msg) => console.log(`✅ ${msg}`);

console.log(`[validate:live] generate ${GEN_PROVIDER}/${GEN_MODEL} → judge ${JUDGE_PROVIDER}/${JUDGE_MODEL}\n`);

const storage = createPlatformAuthStorage();
const catalog = new ModelCatalog(storage);

// Preflight: keys present?
const genKey = await resolveProviderApiKey(storage, GEN_PROVIDER);
const judgeKey = await resolveProviderApiKey(storage, JUDGE_PROVIDER);
if (!genKey) fail(`no credential for generator provider "${GEN_PROVIDER}" — set a key in the Providers UI or env.`);
if (!judgeKey) fail(`no credential for judge provider "${JUDGE_PROVIDER}" — set a key in the Providers UI or env.`);
if (GEN_PROVIDER === JUDGE_PROVIDER) fail(`generator and judge must be different providers (cross-provider JUDGE-1).`);
ok(`credentials present for ${GEN_PROVIDER} and ${JUDGE_PROVIDER}`);

// Resolve models (must exist in pi's catalog).
const known = (p, id) => listPiModels(p).some((m) => m.id === id);
if (!known(GEN_PROVIDER, GEN_MODEL)) fail(`generator model ${GEN_PROVIDER}/${GEN_MODEL} not in pi's catalog.`);
if (!known(JUDGE_PROVIDER, JUDGE_MODEL)) fail(`judge model ${JUDGE_PROVIDER}/${JUDGE_MODEL} not in pi's catalog.`);
const genModel = catalog.resolve(GEN_PROVIDER, GEN_MODEL);
const judgeModel = catalog.resolve(JUDGE_PROVIDER, JUDGE_MODEL);
ok(`resolved both models via pi's ModelRegistry`);

// 1) Real generation.
console.log(`\n[1/2] generating with ${GEN_PROVIDER}/${GEN_MODEL} …`);
const gen = await runAuthoringCompletion({
  model: genModel,
  systemPrompt: "You are a senior TypeScript engineer. Output ONLY code, no prose.",
  userPrompt:
    "Write a well-typed TypeScript function `add(a: number, b: number): number` that returns the sum, " +
    "with a one-line JSDoc comment. Output only the code block.",
  apiKey: genKey,
  timeoutMs: 90_000,
});
if (!gen.text || gen.text.trim().length === 0) fail(`generation returned empty text (stop_reason=${gen.stop_reason}).`);
if (!(gen.tokens_out > 0)) fail(`generation reported tokens_out=${gen.tokens_out} (expected > 0).`);
ok(`generated ${gen.text.length} chars · ${gen.tokens_in}→${gen.tokens_out} tok · $${gen.cost_usd.toFixed(6)} · ${gen.wall_ms}ms · model=${gen.model} provider=${gen.provider}`);
console.log("  ─ output preview ─\n" + gen.text.split("\n").slice(0, 8).map((l) => "  | " + l).join("\n"));

// 2) Real cross-provider critique.
console.log(`\n[2/2] judging with ${JUDGE_PROVIDER}/${JUDGE_MODEL} …`);
const rubric =
  "# Rubric\nScore the artifact 0..1 on correctness and clarity.\n" +
  "Return outcome=pass when it correctly implements `add` and is clear; revise for minor issues; fail if wrong.";
const verdict = await critique({
  judgeModel,
  rubricMd: rubric,
  artifactText: gen.text,
  apiKey: judgeKey,
  timeoutMs: 90_000,
});
if (verdict.parsed === undefined || verdict.parsed === null) {
  fail(`judge did not return a parseable verdict (stop_reason=${verdict.stop_reason}). Raw: ${String(verdict.text).slice(0, 200)}`);
}
const outcome = verdict.parsed?.outcome ?? verdict.parsed?.verdict;
if (!outcome) fail(`verdict parsed but has no outcome field: ${JSON.stringify(verdict.parsed).slice(0, 200)}`);
ok(`verdict outcome="${outcome}" · ${verdict.tokens_in}→${verdict.tokens_out} tok · $${verdict.cost_usd.toFixed(6)} · ${verdict.wall_ms}ms · model=${verdict.model}`);

const totalCost = gen.cost_usd + verdict.cost_usd;
console.log(`\n🎉 live validation PASSED — real generation + real cross-provider judging.`);
console.log(`   total: ${gen.tokens_in + verdict.tokens_in}→${gen.tokens_out + verdict.tokens_out} tok · $${totalCost.toFixed(6)}`);
process.exit(0);
