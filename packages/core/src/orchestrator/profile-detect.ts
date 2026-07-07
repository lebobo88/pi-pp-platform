/**
 * Project profile detector. Sniffs <projectPath> for framework / packaging
 * signals and recommends one of the 16 built-in profiles, including the
 * game-dev family. Used by the profile-loader sub-agent when the target
 * project has no
 * `<project>/.harness/profile.yaml`, so the driver can bootstrap one
 * instead of silently degrading to generic mode.
 *
 * Pure: reads files only, never writes. The driver decides whether to
 * accept the recommendation; `writeProjectProfile` in profiles.ts persists.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ProfileName } from "./profiles.js";
import { classifyRequestText } from "./taxonomy.js";

export type Confidence = "high" | "medium" | "low" | "none";

export type GameEngine = "unity" | "unreal" | "godot" | "bevy" | "gamemaker" | "web" | "custom";

export type GameDetectionFlags = {
  engine?: GameEngine;
  platform_targets?: string[];           // ["ps5","xsx","switch","ios","android","web","desktop"]
  console_cert?: boolean;
  mobile_target?: boolean;
  web_target?: boolean;
  audio_middleware?: "wwise" | "fmod";
  anti_cheat?: "eac" | "battleye" | "vac" | "ricochet";
  network_middleware?: string[];         // ["photon","mirror","netcode-for-gameobjects","fishnet","coherence"]
};

export type ProfileDetection = {
  recommendation: ProfileName | null;
  confidence: Confidence;
  signals: string[];
  alternatives: ProfileName[];
  flags?: GameDetectionFlags;
};

type PackageJson = {
  name?: string;
  bin?: string | Record<string, string>;
  main?: string;
  types?: string;
  typings?: string;
  exports?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

// Web-game engine deps come BEFORE web UI deps so a project with both Three and
// React is classified as game-dev-web, not web-ui. (Many web games ship with
// React for menu UI on top of a canvas-based engine.)
const WEB_GAME_DEPS = [
  "babylonjs", "@babylonjs/core", "@babylonjs/materials", "@babylonjs/loaders",
  "three", "@react-three/fiber", "@react-three/drei",
  "playcanvas",
  "phaser",
  "pixi.js", "@pixi/core",
  "excalibur",
  "kaboom",
];

const WEB_UI_DEPS = [
  "next", "vite", "remix", "@remix-run/react",
  "astro", "nuxt", "@nuxt/kit",
  "vue", "svelte", "@sveltejs/kit",
  "react", "react-dom",
  "@angular/core",
];

// Network middleware that signals an online / multiplayer title.
const GAME_NET_DEPS = [
  "photon", "@exitgames/photon",
  "mirror", "mirror-networking",
  "netcode-for-gameobjects",
  "fishnet",
  "coherence", "@coherence-mono/sdk",
  "colyseus", "@colyseus/core",
  "geckos.io",
];

// Audio middleware that triggers licensing checks.
const GAME_AUDIO_MIDDLEWARE_FILES = [
  "Wwise", "Audiokinetic",
  "fmod", "FMOD", "FMODStudio",
];

const MOBILE_DEPS = [
  "react-native", "expo", "@expo/cli", "@react-native-community/cli",
];

const API_DEPS = [
  "express", "fastify", "hono", "koa", "@nestjs/core", "@nestjs/common",
  "restify", "polka",
];

const AI_DEPS = [
  "langchain", "@langchain/core", "@langchain/anthropic", "@langchain/openai",
  "@anthropic-ai/sdk", "openai", "llamaindex", "crewai", "ai",
  "@modelcontextprotocol/sdk", "@modelcontextprotocol/server",
];

const DATA_FILES = [
  "dbt_project.yml", "airflow.cfg", "dagster.yaml", "prefect.yaml",
  "sqlmesh.yaml", "great_expectations.yml",
];

const EMBEDDED_FILES = [
  "platformio.ini", "Kconfig", "prj.conf", "zephyr.conf",
];

const API_CONTRACT_FILES = [
  "openapi.yaml", "openapi.yml", "openapi.json",
  "asyncapi.yaml", "asyncapi.yml", "asyncapi.json",
];

function safeReadJson(path: string): PackageJson | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

// ─── pnpm / npm workspace member resolution ─────────────────────────────────
// No YAML dependency: the pnpm-workspace.yaml `packages:` block is a trivial
// list of quoted globs, parsed directly. Bounds keep a pathological workspace
// from walking the whole tree.
const MAX_WORKSPACE_MEMBERS = 20;
const MAX_WORKSPACE_GLOB_DEPTH = 3;

/** Parse the `packages:` list from pnpm-workspace.yaml + package.json workspaces. */
function parseWorkspacePatterns(projectPath: string): string[] {
  const patterns: string[] = [];
  const wsPath = join(projectPath, "pnpm-workspace.yaml");
  if (existsSync(wsPath)) {
    try {
      let inPackages = false;
      for (const raw of readFileSync(wsPath, "utf8").split(/\r?\n/)) {
        const line = raw.replace(/\s+$/, "");
        if (/^packages:\s*(#.*)?$/.test(line)) { inPackages = true; continue; }
        if (!inPackages) continue;
        const m = line.match(/^\s+-\s+['"]?([^'"#]+?)['"]?\s*(#.*)?$/);
        if (m) { patterns.push(m[1]!.trim()); continue; }
        if (/^\S/.test(line)) inPackages = false; // dedent to a new top-level key
      }
    } catch { /* ignore */ }
  }
  const pkg = safeReadJson(join(projectPath, "package.json"));
  const ws = (pkg as { workspaces?: unknown } | null)?.workspaces;
  if (Array.isArray(ws)) patterns.push(...ws.filter((p): p is string => typeof p === "string"));
  else if (ws && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages)) {
    patterns.push(...(ws as { packages: unknown[] }).packages.filter((p): p is string => typeof p === "string"));
  }
  return patterns.filter((p) => p && !p.startsWith("!")); // drop negations
}

function isRealDir(projectPath: string, rel: string): boolean {
  try { return statSync(join(projectPath, rel)).isDirectory(); } catch { return false; }
}

/**
 * Resolve real pnpm/npm workspace member directories (those carrying a
 * package.json) from the workspace glob list. Handles the three shapes that
 * actually occur: `packages/*` (direct children), `packages/**` (recurse,
 * bounded depth, skipping node_modules), and bare entries like `ui`/`apps/web`.
 */
export function resolveWorkspaceMembers(projectPath: string): string[] {
  const members = new Set<string>();
  const add = (rel: string) => {
    if (members.size >= MAX_WORKSPACE_MEMBERS) return;
    if (existsSync(join(projectPath, rel, "package.json"))) members.add(rel.replace(/\\/g, "/"));
  };
  const childrenOf = (base: string): string[] =>
    listSafe(join(projectPath, base)).filter(
      (c) => c !== "node_modules" && !c.startsWith(".") && isRealDir(projectPath, base ? `${base}/${c}` : c),
    );
  const recurse = (base: string, depth: number) => {
    if (depth < 0 || members.size >= MAX_WORKSPACE_MEMBERS) return;
    add(base);
    for (const c of childrenOf(base)) recurse(base ? `${base}/${c}` : c, depth - 1);
  };

  for (const pattern of parseWorkspacePatterns(projectPath)) {
    if (members.size >= MAX_WORKSPACE_MEMBERS) break;
    const p = pattern.replace(/\/+$/, "");
    if (p.endsWith("/**")) recurse(p.slice(0, -3).replace(/\/+$/, ""), MAX_WORKSPACE_GLOB_DEPTH);
    else if (p.endsWith("/*")) {
      const base = p.slice(0, -2).replace(/\/+$/, "");
      for (const c of childrenOf(base)) add(base ? `${base}/${c}` : c);
    } else if (!p.includes("*")) add(p); // bare directory entry
    // mid-pattern globs ("packages/foo-*") are rare — skipped (bounded, dep-free)
  }
  return [...members];
}

// Per-member classification precedence — mirrors the root classifier's check
// order (web-game → mobile → ai → web → api → cli → sdk). Also the tie-break
// order the combiner falls back to when member counts are equal.
const MEMBER_PROFILE_PRECEDENCE: readonly ProfileName[] = [
  "game-dev-web", "mobile", "ai-agentic", "web-ui", "api-platform", "non-ui-cli", "sdk",
];

/** Classify a single workspace member's package.json into one profile. */
function classifyMemberPkg(pkg: PackageJson): ProfileName | null {
  if (hasDep(pkg, WEB_GAME_DEPS)) return "game-dev-web";
  if (hasDep(pkg, MOBILE_DEPS)) return "mobile";
  if (hasDep(pkg, AI_DEPS)) return "ai-agentic";
  if (hasDep(pkg, WEB_UI_DEPS)) return "web-ui";
  if (hasDep(pkg, API_DEPS)) return "api-platform";
  if (pkg.bin !== undefined) return "non-ui-cli";
  if (pkg.main !== undefined && (pkg.types !== undefined || pkg.typings !== undefined) && pkg.exports !== undefined) {
    return "sdk";
  }
  return null;
}

export type MemberClassification = { member: string; profile: ProfileName };
export type CombinedClassification = {
  recommendation: ProfileName | null;
  confidence: Confidence;
  method: "majority" | "plurality" | "precedence-tie" | "none";
  trace: string[];
};

/**
 * Combine per-member classifications into one project recommendation:
 *   1. strict majority (> half of typed members) wins;
 *   2. otherwise the plurality (single highest count) wins;
 *   3. only on a count tie fall back to the classifier precedence order.
 * A per-member trace is always recorded regardless of which rule fires.
 */
export function combineMemberClassifications(members: MemberClassification[]): CombinedClassification {
  const trace = members.map((m) => `${m.member} → ${m.profile}`);
  if (members.length === 0) return { recommendation: null, confidence: "none", method: "none", trace };

  const counts = new Map<ProfileName, number>();
  for (const m of members) counts.set(m.profile, (counts.get(m.profile) ?? 0) + 1);
  const total = members.length;
  const top = Math.max(...counts.values());
  const leaders = [...counts.entries()].filter(([, n]) => n === top).map(([p]) => p);

  if (leaders.length === 1 && top > total / 2) {
    trace.push(`strict majority: ${leaders[0]} (${top}/${total})`);
    return { recommendation: leaders[0]!, confidence: "medium", method: "majority", trace };
  }
  if (leaders.length === 1) {
    trace.push(`plurality: ${leaders[0]} (${top}/${total})`);
    return { recommendation: leaders[0]!, confidence: "medium", method: "plurality", trace };
  }
  const picked = MEMBER_PROFILE_PRECEDENCE.find((p) => leaders.includes(p)) ?? leaders[0]!;
  trace.push(`count tie among [${leaders.join(", ")}] → precedence picks ${picked}`);
  return { recommendation: picked, confidence: "low", method: "precedence-tie", trace };
}

/** Monorepo path: classify each workspace member, combine into a recommendation. */
function detectMonorepoProfile(projectPath: string): ProfileDetection | null {
  const memberDirs = resolveWorkspaceMembers(projectPath);
  if (memberDirs.length === 0) return null;
  const classified: MemberClassification[] = [];
  for (const dir of memberDirs) {
    const pkg = safeReadJson(join(projectPath, dir, "package.json"));
    const profile = pkg ? classifyMemberPkg(pkg) : null;
    if (profile) classified.push({ member: dir, profile });
  }
  const combined = combineMemberClassifications(classified);
  if (!combined.recommendation) return null;
  return {
    recommendation: combined.recommendation,
    confidence: combined.confidence,
    signals: [`workspace members: ${classified.length}/${memberDirs.length} typed`, ...combined.trace],
    alternatives: [],
  };
}

/** True when the project directory is empty or only contains a README. */
export function isProjectNearEmpty(projectPath: string): boolean {
  return isNearEmpty(projectPath);
}

function hasDep(pkg: PackageJson, names: readonly string[]): string | null {
  const all = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
  };
  for (const n of names) {
    if (all[n] !== undefined) return n;
  }
  return null;
}

function hasFile(projectPath: string, files: readonly string[]): string | null {
  for (const f of files) {
    if (existsSync(join(projectPath, f))) return f;
  }
  return null;
}

function listSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function hasArduinoSketch(projectPath: string): boolean {
  for (const entry of listSafe(projectPath)) {
    const full = join(projectPath, entry);
    if (entry.endsWith(".ino")) return true;
    try {
      if (statSync(full).isDirectory()) {
        for (const sub of listSafe(full)) {
          if (sub.endsWith(".ino")) return true;
        }
      }
    } catch { /* ignore */ }
  }
  return false;
}

function isNearEmpty(projectPath: string): boolean {
  const entries = listSafe(projectPath).filter((e) =>
    e !== ".git" && e !== ".harness" && !e.startsWith(".")
  );
  if (entries.length === 0) return true;
  if (entries.length <= 2 && entries.every((e) => /^readme(\.|$)/i.test(e))) {
    return true;
  }
  return false;
}

// Find a *.uproject file at root or one level deep.
function findUproject(projectPath: string): string | null {
  for (const entry of listSafe(projectPath)) {
    if (entry.endsWith(".uproject")) return entry;
    const sub = join(projectPath, entry);
    try {
      if (statSync(sub).isDirectory()) {
        for (const subEntry of listSafe(sub)) {
          if (subEntry.endsWith(".uproject")) return `${entry}/${subEntry}`;
        }
      }
    } catch { /* ignore */ }
  }
  return null;
}

// Find a `bevy` dep in Cargo.toml.
function hasBevyInCargo(projectPath: string): boolean {
  const cargoPath = join(projectPath, "Cargo.toml");
  if (!existsSync(cargoPath)) return false;
  try {
    const text = readFileSync(cargoPath, "utf8");
    return /^\s*bevy\s*=\s*/m.test(text);
  } catch {
    return false;
  }
}

// Detect audio-middleware presence by directory marker.
function detectAudioMiddleware(projectPath: string): "wwise" | "fmod" | undefined {
  for (const entry of listSafe(projectPath)) {
    if (/wwise|audiokinetic/i.test(entry)) return "wwise";
    if (/^fmod/i.test(entry)) return "fmod";
  }
  return undefined;
}

// Detect anti-cheat SDK presence.
function detectAntiCheat(projectPath: string): "eac" | "battleye" | "vac" | "ricochet" | undefined {
  for (const entry of listSafe(projectPath)) {
    if (/easy[ -]?anti[ -]?cheat|^EAC/i.test(entry)) return "eac";
    if (/battleye/i.test(entry)) return "battleye";
  }
  return undefined;
}

// Parse an Unreal DefaultEngine.ini for platform targets. Best-effort.
function unrealPlatformTargets(projectPath: string, uprojectRel: string): string[] {
  const targets: string[] = [];
  const uprojectDir = join(projectPath, uprojectRel.includes("/") ? uprojectRel.split("/")[0]! : "");
  const ini = join(uprojectDir, "Config", "DefaultEngine.ini");
  if (existsSync(ini)) {
    try {
      const text = readFileSync(ini, "utf8");
      // Heuristic — look for explicit platform mentions and packaged-platforms list.
      if (/PS5|PlayStation5/i.test(text)) targets.push("ps5");
      if (/XboxSeriesX|XSX|GDK/i.test(text)) targets.push("xsx");
      if (/Switch/i.test(text)) targets.push("switch");
      if (/iOS/i.test(text)) targets.push("ios");
      if (/Android/i.test(text)) targets.push("android");
    } catch { /* ignore */ }
  }
  // Platforms/<X> directory presence is also a target signal.
  const platDir = join(uprojectDir, "Platforms");
  if (existsSync(platDir)) {
    for (const p of listSafe(platDir)) {
      const lower = p.toLowerCase();
      if (lower.includes("ps5")) targets.push("ps5");
      if (lower.includes("xsx") || lower.includes("xboxseries")) targets.push("xsx");
      if (lower.includes("switch")) targets.push("switch");
      if (lower === "ios") targets.push("ios");
      if (lower === "android") targets.push("android");
    }
  }
  return Array.from(new Set(targets));
}

// Parse a Unity ProjectVersion + EditorBuildSettings for platform targets. Best-effort.
function unityPlatformTargets(projectPath: string): string[] {
  const targets: string[] = [];
  const editorSettings = join(projectPath, "ProjectSettings", "EditorBuildSettings.asset");
  if (existsSync(editorSettings)) {
    try {
      const text = readFileSync(editorSettings, "utf8");
      if (/PS5|PlayStation5/i.test(text)) targets.push("ps5");
      if (/GameCoreXboxSeries|XboxSeriesX/i.test(text)) targets.push("xsx");
      if (/Switch/i.test(text)) targets.push("switch");
      if (/iPhone|iOS/i.test(text)) targets.push("ios");
      if (/Android/i.test(text)) targets.push("android");
      if (/WebGL/i.test(text)) targets.push("web");
    } catch { /* ignore */ }
  }
  return Array.from(new Set(targets));
}

// Parse Godot export_presets.cfg for platform targets. Best-effort.
function godotPlatformTargets(projectPath: string): string[] {
  const targets: string[] = [];
  const path = join(projectPath, "export_presets.cfg");
  if (existsSync(path)) {
    try {
      const text = readFileSync(path, "utf8");
      const matches = text.matchAll(/platform\s*=\s*"([^"]+)"/g);
      for (const m of matches) {
        const p = m[1]!.toLowerCase();
        if (p.includes("ios")) targets.push("ios");
        else if (p.includes("android")) targets.push("android");
        else if (p.includes("web")) targets.push("web");
        else if (p.includes("windows") || p.includes("linux") || p.includes("mac")) targets.push("desktop");
      }
    } catch { /* ignore */ }
  }
  return Array.from(new Set(targets));
}

function classifyTargets(targets: string[]): { console_cert: boolean; mobile_target: boolean; web_target: boolean } {
  const tset = new Set(targets);
  return {
    console_cert: tset.has("ps5") || tset.has("xsx") || tset.has("switch"),
    mobile_target: tset.has("ios") || tset.has("android"),
    web_target: tset.has("web"),
  };
}

export type DetectProfileOptions = {
  /**
   * The user's request text. Consulted ONLY when filesystem detection lands in
   * the null/low-confidence tail — a manifest-based detection always wins.
   * Lets a "create a tauri calculator with snake" request on an empty project
   * bootstrap a game-dev profile instead of running in generic mode.
   */
  requestText?: string;
};

/** True when the project carries a Tauri shell manifest. */
function hasTauriManifest(projectPath: string): boolean {
  return (
    existsSync(join(projectPath, "src-tauri", "tauri.conf.json")) ||
    existsSync(join(projectPath, "src-tauri", "tauri.conf.json5")) ||
    existsSync(join(projectPath, "tauri.conf.json"))
  );
}

export function detectProfile(projectPath: string, opts: DetectProfileOptions = {}): ProfileDetection {
  const fs = detectProfileFromFilesystem(projectPath);
  // A HIGH-confidence filesystem signal is authoritative — request text may
  // NEVER override it (a React app stays web-ui even if the prose says "game").
  if (fs.confidence === "high") return fs;

  const tauri = hasTauriManifest(projectPath);
  const cls = opts.requestText ? classifyRequestText(opts.requestText) : null;

  // Request-text blending: a game-shaped request may TIP a medium/low/none
  // filesystem recommendation to the game-dev family. A desktop webview shell
  // (tauri/electron — Tauri renders via a webview, so the web-engines gotcha
  // pack applies) or explicit web delivery picks game-dev-web; otherwise
  // game-dev-custom. Medium confidence = the auto-bootstrap threshold, so
  // profile.yaml gets written and the engineer prompt picks up the gotchas.
  if (cls?.game) {
    const webish = cls.desktopShell !== null || cls.web || tauri;
    const shellNote = cls.desktopShell ? ` (${cls.desktopShell} desktop shell)` : tauri ? " (tauri manifest)" : "";
    const alternatives = new Set<ProfileName>(fs.alternatives);
    if (fs.recommendation) alternatives.add(fs.recommendation);
    const signals = [...fs.signals, `request text: game-shaped${shellNote}`];
    if (fs.confidence === "medium") {
      // Trace the tip: the filesystem gave a medium recommendation and the
      // request text moved it. (A high recommendation returned above.)
      signals.push(`blended over medium filesystem recommendation (${fs.recommendation ?? "generic"})`);
    }
    return {
      recommendation: webish ? "game-dev-web" : "game-dev-custom",
      confidence: "medium",
      signals,
      alternatives: Array.from(alternatives),
      flags: { engine: webish ? "web" : "custom" },
    };
  }

  // No game-shaped request text — a medium filesystem recommendation stands.
  if (fs.confidence === "medium") return fs;

  // Filesystem Tauri signal without a game-shaped request: a Tauri app is a
  // webview UI — web-ui is the closest profile (there is no desktop profile).
  if (tauri) {
    const alternatives = new Set<ProfileName>(fs.alternatives);
    if (fs.recommendation) alternatives.add(fs.recommendation);
    return {
      recommendation: "web-ui",
      confidence: "medium",
      signals: [...fs.signals, "src-tauri/tauri.conf.json present (Tauri desktop shell — webview UI)"],
      alternatives: Array.from(alternatives),
    };
  }

  return fs;
}

function detectProfileFromFilesystem(projectPath: string): ProfileDetection {
  const signals: string[] = [];
  const alternatives = new Set<ProfileName>();

  // ─── Game-engine detection (highest priority) ─────────────────────
  // Check for native game-engine manifests BEFORE any other detection so a
  // Unity/Unreal/Godot/Bevy project that also has a package.json (e.g., for
  // tooling) doesn't fall through to web-ui or non-ui-cli classification.

  const uproject = findUproject(projectPath);
  if (uproject) {
    signals.push(`Unreal project: ${uproject}`);
    const targets = unrealPlatformTargets(projectPath, uproject);
    if (targets.length > 0) signals.push(`platform targets: ${targets.join(", ")}`);
    const audio_middleware = detectAudioMiddleware(projectPath);
    if (audio_middleware) signals.push(`audio middleware: ${audio_middleware}`);
    const anti_cheat = detectAntiCheat(projectPath);
    if (anti_cheat) signals.push(`anti-cheat: ${anti_cheat}`);
    return {
      recommendation: "game-dev-unreal",
      confidence: "high",
      signals,
      alternatives: [],
      flags: {
        engine: "unreal",
        platform_targets: targets.length > 0 ? targets : undefined,
        ...classifyTargets(targets),
        audio_middleware,
        anti_cheat,
      },
    };
  }

  if (existsSync(join(projectPath, "ProjectSettings", "ProjectVersion.txt"))) {
    signals.push("Unity project: ProjectSettings/ProjectVersion.txt present");
    const targets = unityPlatformTargets(projectPath);
    if (targets.length > 0) signals.push(`platform targets: ${targets.join(", ")}`);
    const audio_middleware = detectAudioMiddleware(projectPath);
    if (audio_middleware) signals.push(`audio middleware: ${audio_middleware}`);
    const anti_cheat = detectAntiCheat(projectPath);
    if (anti_cheat) signals.push(`anti-cheat: ${anti_cheat}`);
    return {
      recommendation: "game-dev-unity",
      confidence: "high",
      signals,
      alternatives: [],
      flags: {
        engine: "unity",
        platform_targets: targets.length > 0 ? targets : undefined,
        ...classifyTargets(targets),
        audio_middleware,
        anti_cheat,
      },
    };
  }

  if (existsSync(join(projectPath, "project.godot"))) {
    signals.push("Godot project: project.godot present");
    const targets = godotPlatformTargets(projectPath);
    if (targets.length > 0) signals.push(`export targets: ${targets.join(", ")}`);
    return {
      recommendation: "game-dev-godot",
      confidence: "high",
      signals,
      alternatives: [],
      flags: {
        engine: "godot",
        platform_targets: targets.length > 0 ? targets : undefined,
        ...classifyTargets(targets),
      },
    };
  }

  if (hasBevyInCargo(projectPath)) {
    signals.push("Bevy project: Cargo.toml has bevy dep");
    return {
      recommendation: "game-dev-custom",
      confidence: "high",
      signals,
      alternatives: [],
      flags: { engine: "bevy" },
    };
  }

  // GameMaker (.yyp) detection.
  const yypFile = listSafe(projectPath).find((e) => e.endsWith(".yyp"));
  if (yypFile) {
    signals.push(`GameMaker project: ${yypFile}`);
    return {
      recommendation: "game-dev-custom",
      confidence: "high",
      signals,
      alternatives: [],
      flags: { engine: "gamemaker" },
    };
  }

  const podfile = existsSync(join(projectPath, "ios", "Podfile"));
  const androidGradle = existsSync(join(projectPath, "android", "build.gradle")) ||
    existsSync(join(projectPath, "android", "build.gradle.kts"));
  const xcodeProj = listSafe(projectPath).some((e) => e.endsWith(".xcodeproj"));

  const embeddedFile = hasFile(projectPath, EMBEDDED_FILES);
  const arduino = hasArduinoSketch(projectPath);

  const contractFile = hasFile(projectPath, API_CONTRACT_FILES);
  const dataFile = hasFile(projectPath, DATA_FILES);

  const pkg = safeReadJson(join(projectPath, "package.json"));
  let webDep: string | null = null;
  let mobileDep: string | null = null;
  let apiDep: string | null = null;
  let aiDep: string | null = null;
  let webGameDep: string | null = null;
  let netDep: string | null = null;
  let hasBin = false;
  let hasLibraryShape = false;
  if (pkg) {
    webDep = hasDep(pkg, WEB_UI_DEPS);
    mobileDep = hasDep(pkg, MOBILE_DEPS);
    apiDep = hasDep(pkg, API_DEPS);
    aiDep = hasDep(pkg, AI_DEPS);
    webGameDep = hasDep(pkg, WEB_GAME_DEPS);
    netDep = hasDep(pkg, GAME_NET_DEPS);
    hasBin = pkg.bin !== undefined;
    hasLibraryShape =
      pkg.main !== undefined &&
      (pkg.types !== undefined || pkg.typings !== undefined) &&
      pkg.exports !== undefined &&
      !hasBin;
  }

  // Web-game engine detection — must come BEFORE the mobile / web-ui branches
  // so a Babylon.js or three.js project gets game-dev-web rather than web-ui.
  if (webGameDep) {
    signals.push(`package.json deps include "${webGameDep}"`);
    const network_middleware: string[] = [];
    if (netDep) {
      signals.push(`network middleware: ${netDep}`);
      network_middleware.push(netDep);
    }
    return {
      recommendation: "game-dev-web",
      confidence: "high",
      signals,
      alternatives: [],
      flags: {
        engine: "web",
        platform_targets: ["web"],
        web_target: true,
        network_middleware: network_middleware.length > 0 ? network_middleware : undefined,
      },
    };
  }

  const cargoToml = existsSync(join(projectPath, "Cargo.toml"));
  const pyprojectToml = existsSync(join(projectPath, "pyproject.toml"));
  const goMod = existsSync(join(projectPath, "go.mod"));

  if (!pkg && !cargoToml && !pyprojectToml && !goMod && isNearEmpty(projectPath)) {
    return {
      recommendation: null,
      confidence: "none",
      signals: ["empty or README-only project — no detectable signals"],
      alternatives: [],
    };
  }

  if (mobileDep) {
    signals.push(`package.json deps include "${mobileDep}"`);
    if (podfile) signals.push("ios/Podfile present");
    if (androidGradle) signals.push("android/build.gradle present");
    return {
      recommendation: "mobile",
      confidence: "high",
      signals,
      alternatives: webDep ? ["web-ui"] : [],
    };
  }
  if (podfile && androidGradle) {
    signals.push("ios/Podfile + android/build.gradle present");
    return { recommendation: "mobile", confidence: "high", signals, alternatives: [] };
  }
  if (xcodeProj) {
    signals.push(".xcodeproj present");
    return { recommendation: "mobile", confidence: "medium", signals, alternatives: [] };
  }

  if (embeddedFile) {
    signals.push(`${embeddedFile} present`);
    return { recommendation: "embedded", confidence: "high", signals, alternatives: [] };
  }
  if (arduino) {
    signals.push(".ino sketch file present");
    return { recommendation: "embedded", confidence: "high", signals, alternatives: [] };
  }

  if (dataFile) {
    signals.push(`${dataFile} present`);
    return { recommendation: "data-product", confidence: "high", signals, alternatives: [] };
  }

  if (aiDep) {
    signals.push(`package.json deps include "${aiDep}"`);
    if (webDep) {
      signals.push(`also has UI framework "${webDep}" — alternative: web-ui`);
      alternatives.add("web-ui");
    }
    if (apiDep) {
      signals.push(`also has API framework "${apiDep}" — alternative: api-platform`);
      alternatives.add("api-platform");
    }
    return {
      recommendation: "ai-agentic",
      confidence: "high",
      signals,
      alternatives: Array.from(alternatives),
    };
  }

  if (webDep) {
    signals.push(`package.json deps include "${webDep}"`);
    if (apiDep) {
      signals.push(`also has API framework "${apiDep}" — alternative: api-platform`);
      alternatives.add("api-platform");
    }
    return {
      recommendation: "web-ui",
      confidence: "high",
      signals,
      alternatives: Array.from(alternatives),
    };
  }

  if (apiDep) {
    signals.push(`package.json deps include "${apiDep}"`);
    return { recommendation: "api-platform", confidence: "high", signals, alternatives: [] };
  }
  if (contractFile) {
    signals.push(`${contractFile} present at repo root`);
    return { recommendation: "api-platform", confidence: "medium", signals, alternatives: [] };
  }

  if (pkg && hasBin) {
    signals.push("package.json has \"bin\" field (CLI shape)");
    return { recommendation: "non-ui-cli", confidence: "high", signals, alternatives: ["sdk"] };
  }
  if (pkg && hasLibraryShape) {
    signals.push("package.json has main + types + exports, no bin (library shape)");
    return { recommendation: "sdk", confidence: "high", signals, alternatives: ["non-ui-cli"] };
  }

  // Monorepo: the root package.json carried no framework signal, but workspace
  // members might. Classify each member and combine (majority → plurality →
  // precedence tie-break). Comes after the root high-confidence checks so a
  // root with real deps still wins.
  const mono = detectMonorepoProfile(projectPath);
  if (mono) {
    return { ...mono, signals: [...signals, ...mono.signals] };
  }

  if (cargoToml || pyprojectToml || goMod) {
    const which = cargoToml ? "Cargo.toml" : pyprojectToml ? "pyproject.toml" : "go.mod";
    signals.push(`${which} present, no web/api/data/ai signals detected`);
    return {
      recommendation: "non-ui-cli",
      confidence: "low",
      signals,
      alternatives: ["sdk", "internal-tool"],
    };
  }

  if (pkg) {
    signals.push("package.json present but no framework / library / cli signals");
    return {
      recommendation: null,
      confidence: "low",
      signals,
      alternatives: ["non-ui-cli", "sdk", "internal-tool"],
    };
  }

  return {
    recommendation: null,
    confidence: "none",
    signals: ["no detectable signals"],
    alternatives: [],
  };
}
