# pi 0.80.3 API contract (verified against installed packages, 2026-07-02)

> **Internal notes** — maintainer/migration reference, not user documentation.

Verified by installing `@earendil-works/pi-{coding-agent,ai,agent-core}@0.80.3` and probing the real exports.
The local RLMpi checkout (`@mariozechner/*@0.67.68`) is an OLDER API — differences below are authoritative for 0.80.3.

## Engines
All three packages require `node >= 22.19.0`. Pin exact `0.80.3` (no `^`).

## pi-ai

### Entry points
- **Root** (`@earendil-works/pi-ai`): `createModels`, `createProvider`, `calculateCost`, `clampThinkingLevel`,
  `InMemoryCredentialStore`, TypeBox re-exports (`Type`, `StringEnum`), JSON repair utils (`parseJsonWithRepair`, `repairJson`),
  `validateToolCall/validateToolArguments`, and **faux test doubles**: `createFauxCore`, `fauxProvider`, `fauxAssistantMessage`,
  `fauxText`, `fauxThinking`, `fauxToolCall`.
  ⚠️ Root does NOT export `getModel`/`complete` (SDK doc examples are stale).
- **`/compat`**: the full convenience surface — `getModel(provider, id)`, `getModels`, `getProviders`,
  `complete(model, ctx, opts)`, `completeSimple(model, ctx, opts)`, `stream`, `streamSimple`, `registerFauxProvider`,
  per-provider `stream*` fns, `Model`/`Context` types.
- **`/providers/all`**: `builtinModels()` → `MutableModels` (`{providers, credentials, authContext}` object implementing the
  `Models` interface: `.getModel`, `.getModels`, `.getProvider`, `.getAuth(model)`, `.complete`, `.stream`, `.refresh`),
  plus `getBuiltinModel(provider, id)`, `builtinProviders`.

### Model catalog (builtin, verified present with pricing $in/$out per MTok)
| provider/id | cost |
|---|---|
| anthropic/claude-fable-5 | **10 / 50** ← IN THE CATALOG — no custom models.json needed |
| anthropic/claude-opus-4-7 | 5 / 25 |
| anthropic/claude-sonnet-4-6 | 3 / 15 |
| anthropic/claude-haiku-4-5-20251001 | 1 / 5 |
| openai/gpt-5.4 | 2.5 / 15 |
| openai/gpt-5.5 | 5 / 30 |
| google/gemini-3.1-pro-preview | 2 / 12 |

Consequence: plan risk "fable absent from builtins" is **eliminated**. Keep `assets/prices.json` only as a
cross-check/fallback for budget reconciliation.

### Usage/cost
`AssistantMessage.usage`: `{input, output, cacheRead, cacheWrite, totalTokens, cost: {input, output, cacheRead, cacheWrite, total}}`.
`calculateCost(model, usage)` exists at root and in compat.

## pi-coding-agent

### Root exports (140 symbols; all load-bearing ones confirmed)
`createAgentSession`, `createAgentSessionRuntime`, `createAgentSessionFromServices`, `createAgentSessionServices`,
`AgentSession`, `AgentSessionRuntime`, `AuthStorage`, `FileAuthStorageBackend`, `InMemoryAuthStorageBackend`,
`ModelRegistry`, `SessionManager`, `SettingsManager`, `DefaultResourceLoader`, `ProjectTrustStore`,
`defineTool`, `createCodingTools`, `createReadOnlyTools`, `createReadTool/BashTool/EditTool/WriteTool/GrepTool/FindTool/LsTool`,
`withFileMutationQueue`, `wrapRegisteredTool(s)`, `runPrintMode`, `runRpcMode`, `RpcClient`, `getLastAssistantUsage`,
`getAgentDir`, `CONFIG_DIR_NAME`, `loadSkills`, `parseFrontmatter`, `generateUnifiedPatch`, `createEventBus`.

### CreateAgentSessionOptions (dist/core/sdk.d.ts, verbatim semantics)
```ts
{
  cwd?: string;                    // project dir (worktree for candidates)
  agentDir?: string;               // default ~/.pi/agent — WE OVERRIDE to %USERPROFILE%\.pi-pp-platform
  authStorage?: AuthStorage;       // AuthStorage.create(path) | InMemoryAuthStorageBackend
  modelRegistry?: ModelRegistry;   // ModelRegistry.create(authStorage, modelsJsonPath) | .inMemory(authStorage)
  model?: Model<any>;
  thinkingLevel?: ThinkingLevel;
  scopedModels?: {model, thinkingLevel?}[];
  noTools?: "all" | "builtin";
  tools?: string[];                // allowlist of tool names (read, bash, edit, write)
  excludeTools?: string[];
  customTools?: ToolDefinition[];  // defineTool(...) results — our guarded tools go here
  resourceLoader?: ResourceLoader; // DefaultResourceLoader — system prompt/AGENTS.md/skills discovery
  sessionManager?: SessionManager; // SessionManager.create(cwd) | .inMemory() — we pass explicit session dir
  settingsManager?: SettingsManager;
}
// → { session: AgentSession, extensionsResult, modelFallbackMessage? }
```
System-prompt injection path: custom `ResourceLoader` (DefaultResourceLoader takes {cwd, agentDir, settingsManager} and
loads SYSTEM.md / AGENTS.md / skills) — engine should construct one per role, or write the role prompt to the worktree's
`.pi/SYSTEM.md`. Verify which is cleaner during M2 implementation; both are supported.

### Tool guarding strategy
`tools: []` + `customTools: [guardedRead, guardedBash, guardedEdit, guardedWrite]` where guarded variants wrap
`create*Tool(cwd)` results with bash-safety / sandbox-path / secret-scan checks (`wrapRegisteredTool` may help).

### ModelRegistry
`ModelRegistry.create(authStorage, modelsJsonPath?)` — builtin + custom merge (custom wins by provider+id), `refresh()`,
`getError()`. `ModelRegistry.inMemory(authStorage)` for tests.

## Fake engine (tests, zero tokens)
pi-ai ships first-class test doubles: `registerFauxProvider` + `fauxAssistantMessage/fauxText/fauxToolCall` (compat),
`createFauxCore` (root). Prefer these over hand-rolled mocks for FakeLlm; FakeCodegenSession still hand-rolled
(writes fixture files + git commits).

## RPC fallback (if SDK path hits a wall)
`runRpcMode`, `RpcClient` exported; package also exposes `./rpc-entry` subpath. CLI: `pi --mode rpc --no-session`.
