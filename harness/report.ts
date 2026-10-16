/**
 * Report serialisation: `out/<stamp>/report.json` + `out/<stamp>/report.md`.
 *
 * OWNER: worker D1.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { ARM_IDS, evaluateGate } from "./metrics/index.ts";
import type { ArmID, ArmResult, ArmSummary, RunReport } from "./types.ts";

export interface ReportPaths {
  dir: string;
  json: string;
  markdown: string;
}

/** Filesystem-safe stamp for one harness run, e.g. `2026-10-16T12-30-00-000Z`. */
export function makeStamp(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/** True when token accounting came from the mock driver and must be labelled as synthetic. */
export function isMockDriver(driver: string): boolean {
  return driver.toLowerCase().includes("mock");
}

export function serialiseReport(report: RunReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function number(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "n/a";
  return value.toFixed(digits);
}

function money(value: number | undefined): string {
  return value === undefined ? "n/a" : `$${value.toFixed(6)}`;
}

function summaryRow(arm: ArmID, summary: ArmSummary): string {
  return [
    arm,
    String(summary.runs),
    String(summary.ok),
    `${summary.correctnessPassed}/${summary.runs}`,
    number(summary.turnsMean),
    number(summary.cacheReadTokensMean),
    number(summary.freshTokensMean),
    number(summary.outputTokensMean),
    money(summary.costUsdMean),
    number(summary.wallMsMean, 0),
    number(summary.toolCallsMean),
    number(summary.escalationRate, 2),
    number(summary.scriptFailureRate, 2),
    number(summary.decideCallsMean),
  ].join(" | ");
}

function detailRow(result: ArmResult): string {
  const notes = [result.error, ...result.notes].filter(Boolean).join("; ");
  return [
    escapeCell(result.taskId),
    result.arm,
    String(result.runIndex),
    result.ok ? "yes" : "no",
    result.correctness.passed ? "yes" : "no",
    String(result.turns),
    String(result.usage.cacheRead),
    String(result.usage.fresh),
    String(result.usage.output),
    money(result.usage.costUsd),
    number(result.wallMs, 0),
    String(result.toolCalls.length),
    String(result.toolFailures),
    result.escalated ? `${result.escalations}` : "0",
    String(result.scriptFailures),
    String(result.decideCalls.length),
    number(result.decideLatencyMs, 0),
    escapeCell(notes),
  ].join(" | ");
}

export function renderMarkdown(report: RunReport): string {
  const mock = isMockDriver(report.driver);
  const gate = evaluateGate(report.summary);
  const tasks = [...new Set(report.results.map((result) => result.taskId))].sort();
  const lines: string[] = [];

  lines.push("# Code Mode harness report");
  lines.push("");
  lines.push(`- started: ${report.startedAt}`);
  lines.push(`- finished: ${report.finishedAt}`);
  lines.push(`- driver: \`${report.driver}\``);
  lines.push(`- runs per task/arm: ${report.runs}`);
  lines.push(`- tasks: ${tasks.map((id) => `\`${id}\``).join(", ") || "(none)"}`);
  lines.push("");

  if (mock) {
    lines.push(
      "> **Synthetic usage.** `--driver mock` reports token counts from a canned usage model, not from a real model. Treat the cache-read column as illustrative plumbing, not as evidence.",
    );
    lines.push("");
  }

  lines.push("## Per-arm summary");
  lines.push("");
  lines.push(
    "| Arm | Runs | ok | correct | turns | cacheRead | fresh | output | cost | wallMs | tools | escalation | scriptFail | decide |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const arm of ARM_IDS) {
    lines.push(`| ${summaryRow(arm, report.summary[arm])} |`);
  }
  lines.push("");
  lines.push(
    "_means per run; `cacheRead`/`fresh`/`output` are tokens; `escalation`/`scriptFail` are rates over runs._",
  );
  lines.push("");

  lines.push("## Gate");
  lines.push("");
  lines.push(`**pass: ${gate.pass ? "yes" : "no"}**`);
  lines.push("");
  lines.push(`- cache-read tokens down vs A: ${gate.cacheReadDownVsA ? "yes" : "no"}`);
  lines.push(`- cache-read tokens down vs B (informational): ${gate.cacheReadDownVsB ? "yes" : "no"}`);
  lines.push(`- correctness equal-or-better: ${gate.correctnessEqualOrBetter ? "yes" : "no"}`);
  lines.push(`- escalation rate low: ${gate.escalationLow ? "yes" : "no"}`);
  lines.push("");
  for (const note of gate.notes) lines.push(`- ${note}`);
  lines.push("");

  lines.push("## Runs");
  lines.push("");
  lines.push(
    "| Task | Arm | Run | ok | pass | turns | cacheRead | fresh | output | cost | wallMs | tools | toolFail | escalations | scriptFail | decide | decideMs | notes |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const result of report.results) {
    lines.push(`| ${detailRow(result)} |`);
  }
  lines.push("");
  return lines.join("\n");
}

export interface WriteReportOptions {
  report: RunReport;
  /** Base directory; the stamp directory is created inside it. */
  outBase?: string;
  stamp?: string;
}

/** Writes `report.json` and `report.md` into `<outBase>/<stamp>/` and returns their paths. */
export async function writeReport(opts: WriteReportOptions): Promise<ReportPaths> {
  const outBase = opts.outBase ?? "out";
  const stamp = opts.stamp ?? makeStamp();
  const dir = path.resolve(outBase, stamp);
  await fs.mkdir(dir, { recursive: true });
  const json = path.join(dir, "report.json");
  const markdown = path.join(dir, "report.md");
  await fs.writeFile(json, serialiseReport(opts.report), "utf8");
  await fs.writeFile(markdown, renderMarkdown(opts.report), "utf8");
  return { dir, json, markdown };
}
