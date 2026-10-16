#!/usr/bin/env bun
/**
 * Harness CLI.
 *
 *   bun run harness --list
 *   bun run harness --tasks <ids> --arms A,B,C --runs N --driver mock|opencode
 *
 * Optional flags: `--max-turns N`, `--seed N`, `--out <dir>`, `--keep-scratch`, `--help`.
 * `--driver mock` is fully offline (no network, no API key) and is the default.
 *
 * OWNER: worker D1.
 */

import type { ArmID } from "./types.ts";
import { ARM_IDS, evaluateGate } from "./metrics/index.ts";
import { isMockDriver } from "./report.ts";
import { runHarness } from "./runner/orchestrate.ts";
import { loadSources } from "./runner/sources.ts";

export interface CliOptions {
  list: boolean;
  help: boolean;
  tasks: string[];
  arms: ArmID[];
  runs: number;
  driver: string;
  maxTurns?: number;
  seed?: number;
  out?: string;
  keepScratch: boolean;
}

const USAGE = `Usage: bun run harness [options]

  --list                    list tasks (id, kind, title) and exit
  --tasks <id[,id...]>      task ids to run (required unless --list)
  --arms <A,B,C>            arms to run (default: A,B,C)
  --runs <n>                runs per task/arm (default: 1)
  --driver mock|opencode    model driver (default: mock; mock is fully offline)
  --max-turns <n>           arm A turn budget (default: 24)
  --seed <n>                mock driver seed (default: 1)
  --out <dir>               report base directory (default: out)
  --keep-scratch            keep the per-run scratch directories
  --help                    show this message`;

/** Minimal, dependency-free argv parser: `--flag`, `--flag=value`, `--flag value`. */
export function parseCliArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {
    list: false,
    help: false,
    tasks: [],
    arms: [...ARM_IDS],
    runs: 1,
    driver: "mock",
    keepScratch: false,
  };

  const value = (flag: string, inline: string | undefined, next: () => string | undefined): string => {
    if (inline !== undefined) return inline;
    const value = next();
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) throw new Error(`unexpected argument "${arg}"`);
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const next = (): string | undefined => argv[++i];

    switch (flag) {
      case "--list":
        opts.list = true;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      case "--tasks":
        opts.tasks = value(flag, inline, next)
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id.length > 0);
        break;
      case "--arms": {
        const arms = value(flag, inline, next)
          .split(",")
          .map((arm) => arm.trim().toUpperCase())
          .filter((arm) => arm.length > 0);
        for (const arm of arms) {
          if (!ARM_IDS.includes(arm as ArmID)) throw new Error(`unknown arm "${arm}" (expected A, B or C)`);
        }
        opts.arms = arms as ArmID[];
        break;
      }
      case "--runs": {
        const runs = Number(value(flag, inline, next));
        if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs must be a positive integer`);
        opts.runs = runs;
        break;
      }
      case "--driver":
        opts.driver = value(flag, inline, next);
        if (opts.driver !== "mock" && opts.driver !== "opencode") {
          throw new Error(`unknown driver "${opts.driver}" (expected mock or opencode)`);
        }
        break;
      case "--max-turns": {
        const turns = Number(value(flag, inline, next));
        if (!Number.isInteger(turns) || turns < 1) throw new Error(`--max-turns must be a positive integer`);
        opts.maxTurns = turns;
        break;
      }
      case "--seed": {
        const seed = Number(value(flag, inline, next));
        if (!Number.isFinite(seed)) throw new Error(`--seed must be a number`);
        opts.seed = seed;
        break;
      }
      case "--out":
        opts.out = value(flag, inline, next);
        break;
      case "--keep-scratch":
        opts.keepScratch = true;
        break;
      default:
        throw new Error(`unknown flag "${flag}"`);
    }
  }
  return opts;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function printList(taskRows: readonly { id: string; kind: string; title: string }[]): void {
  const idWidth = Math.max(4, ...taskRows.map((row) => row.id.length));
  const kindWidth = Math.max(4, ...taskRows.map((row) => row.kind.length));
  console.log(`${pad("id", idWidth)}  ${pad("kind", kindWidth)}  title`);
  for (const row of taskRows) {
    console.log(`${pad(row.id, idWidth)}  ${pad(row.kind, kindWidth)}  ${row.title}`);
  }
}

async function main(): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseCliArgs(Bun.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    console.error(USAGE);
    return 2;
  }

  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  const sources = await loadSources();

  if (opts.list) {
    printList(sources.tasks.map((task) => ({ id: task.id, kind: task.kind, title: task.title })));
    for (const warning of sources.warnings) console.error(`warning: ${warning}`);
    return 0;
  }

  if (opts.tasks.length === 0) {
    console.error("error: --tasks is required (or use --list)");
    console.error(USAGE);
    return 2;
  }

  for (const warning of sources.warnings) console.error(`warning: ${warning}`);

  const outcome = await runHarness({
    taskIds: opts.tasks,
    arms: opts.arms,
    runs: opts.runs,
    driverName: opts.driver,
    sources,
    ...(opts.maxTurns === undefined ? {} : { maxTurns: opts.maxTurns }),
    ...(opts.seed === undefined ? {} : { seed: opts.seed }),
    ...(opts.out === undefined ? {} : { outBase: opts.out }),
    keepScratch: opts.keepScratch,
  });

  const { report, paths } = outcome;

  console.log("");
  console.log(`${pad("task", 28)} ${pad("arm", 3)} ${pad("run", 3)} ${pad("ok", 3)} ${pad("pass", 4)} ${pad("turns", 5)} ${pad("cacheRead", 9)} tools`);
  for (const result of report.results) {
    console.log(
      `${pad(result.taskId, 28)} ${pad(result.arm, 3)} ${pad(String(result.runIndex), 3)} ${pad(result.ok ? "yes" : "no", 3)} ${pad(result.correctness.passed ? "yes" : "no", 4)} ${pad(String(result.turns), 5)} ${pad(String(result.usage.cacheRead), 9)} ${result.toolCalls.length}`,
    );
    if (result.error !== undefined) console.log(`    error: ${result.error}`);
  }

  console.log("");
  console.log(`${pad("arm", 3)} ${pad("runs", 4)} ${pad("ok", 3)} ${pad("pass", 6)} ${pad("turns", 6)} ${pad("cacheRead", 9)} ${pad("fresh", 7)} ${pad("output", 7)} ${pad("escal", 5)} ${pad("scriptFail", 10)} ${pad("decide", 6)}`);
  for (const arm of ARM_IDS) {
    const summary = report.summary[arm];
    console.log(
      `${pad(arm, 3)} ${pad(String(summary.runs), 4)} ${pad(String(summary.ok), 3)} ${pad(`${summary.correctnessPassed}/${summary.runs}`, 6)} ${pad(summary.turnsMean.toFixed(1), 6)} ${pad(summary.cacheReadTokensMean.toFixed(1), 9)} ${pad(summary.freshTokensMean.toFixed(1), 7)} ${pad(summary.outputTokensMean.toFixed(1), 7)} ${pad(summary.escalationRate.toFixed(2), 5)} ${pad(summary.scriptFailureRate.toFixed(2), 10)} ${pad(summary.decideCallsMean.toFixed(1), 6)}`,
    );
  }

  const gate = evaluateGate(report.summary);
  console.log("");
  console.log(`gate: ${gate.pass ? "PASS" : "FAIL"}`);
  for (const note of gate.notes) console.log(`  - ${note}`);

  if (isMockDriver(report.driver)) {
    console.log("");
    console.log("note: --driver mock reports SYNTHETIC token usage (labelled in report.md)");
  }

  for (const warning of outcome.warnings) console.log(`note: ${warning}`);
  console.log("");
  console.log(`scratch: ${outcome.scratchBase}${opts.keepScratch ? "" : " (removed; --keep-scratch to keep)"}`);
  console.log(`wrote:   ${paths.json}`);
  console.log(`wrote:   ${paths.markdown}`);
  return 0;
}

if (import.meta.main) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`harness failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
