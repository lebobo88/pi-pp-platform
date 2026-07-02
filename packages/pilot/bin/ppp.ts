#!/usr/bin/env node
/**
 * ppp — minimal CLI for the pilot.
 *
 *   ppp run <projectPath> "<request>" [--mode single|team|best_of|review]
 *                                     [--team <name>] [--n <k>]
 *                                     [--tier-cap opus|sonnet|haiku]
 *                                     [--tier-floor opus|sonnet|haiku]
 *                                     [--no-tier-policy] [--fake]
 *
 * Prints live lifecycle events to stdout and a final status line. `--fake`
 * wires the deterministic engine (createEngine({mode:"fake"})); omit it to use
 * the real pi runtime.
 */

import { createEngine } from "@pp/engine";
import { RunPilot, EventBus, parseTierFlag } from "../src/index.js";
import type { RunMode } from "../src/index.js";

type Parsed = {
  cmd?: string;
  projectPath?: string;
  request?: string;
  mode: RunMode;
  team?: string;
  n?: number;
  tierCap?: ReturnType<typeof parseTierFlag>;
  tierFloor?: ReturnType<typeof parseTierFlag>;
  noTierPolicy: boolean;
  fake: boolean;
};

function parseArgs(argv: string[]): Parsed {
  const p: Parsed = { mode: "single", noTierPolicy: false, fake: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--mode":
        p.mode = argv[++i] as RunMode;
        break;
      case "--team":
        p.team = argv[++i];
        break;
      case "--n":
        p.n = Number(argv[++i]);
        break;
      case "--tier-cap":
        p.tierCap = parseTierFlag(argv[++i] ?? "");
        break;
      case "--tier-floor":
        p.tierFloor = parseTierFlag(argv[++i] ?? "");
        break;
      case "--no-tier-policy":
        p.noTierPolicy = true;
        break;
      case "--fake":
        p.fake = true;
        break;
      default:
        positional.push(a);
    }
  }
  p.cmd = positional[0];
  p.projectPath = positional[1];
  p.request = positional[2];
  return p;
}

function usage(): void {
  process.stderr.write(
    `Usage: ppp run <projectPath> "<request>" ` +
      `[--mode single|team|best_of|review] [--team <name>] [--n <k>] ` +
      `[--tier-cap opus|sonnet|haiku] [--tier-floor opus|sonnet|haiku] ` +
      `[--no-tier-policy] [--fake]\n`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.cmd !== "run" || !args.projectPath || !args.request) {
    usage();
    process.exitCode = 2;
    return;
  }

  const engine = createEngine({ mode: args.fake ? "fake" : "pi" });
  const bus = new EventBus();
  bus.subscribe((e) => {
    const tag = e.stage_id ? ` [${e.stage_id}]` : "";
    process.stdout.write(`#${e.seq} ${e.type}${tag} ${JSON.stringify(e.data)}\n`);
  });

  const pilot = new RunPilot({
    projectPath: args.projectPath,
    requestText: args.request,
    mode: args.mode,
    team: args.team,
    n: args.n,
    tierCap: args.tierCap,
    tierFloor: args.tierFloor,
    noTierPolicy: args.noTierPolicy,
    engine,
    bus,
  });

  const result = await pilot.execute();
  process.stdout.write(
    `\nrun ${result.run_id} → ${result.status}` +
      (result.abort_reason ? ` (${result.abort_reason})` : "") +
      `\nstages: ${result.stages.map((s) => `${s.kind}=${s.outcome}`).join(", ") || "(none)"}\n`,
  );
  process.exitCode = result.status === "complete" ? 0 : 1;
}

main().catch((err) => {
  process.stderr.write(`ppp: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
