import { afterAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { makeStamp, renderMarkdown, serialiseReport, writeReport } from "./report.ts";
import { summariseByArm } from "./metrics/index.ts";
import type { ArmResult, RunReport } from "./types.ts";

const roots: string[] = [];

async function tmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-harness-report-"));
  roots.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of roots) await fs.rm(dir, { recursive: true, force: true });
});

function result(arm: "A" | "B" | "C", runIndex = 0): ArmResult {
  return {
    arm,
    taskId: "sample-task",
    runIndex,
    ok: true,
    turns: arm === "A" ? 5 : 1,
    usage: { fresh: 100, cacheWrite: 10, cacheRead: arm === "A" ? 4000 : 500, output: 40, costUsd: 0.001 },
    wallMs: 123,
    toolCalls: ["read", "edit"],
    toolFailures: 0,
    correctness: { passed: true },
    transcript: arm === "A" ? "done" : "return 1",
    logs: ["hello"],
    decideCalls: [],
    decideLatencyMs: 0,
    escalated: false,
    escalations: 0,
    scriptFailures: 0,
    notes: [],
  };
}

function report(driver: string): RunReport {
  const results = [result("A", 0), result("B", 0), result("C", 0)];
  return {
    startedAt: "2026-10-16T00:00:00.000Z",
    finishedAt: "2026-10-16T00:00:01.000Z",
    driver,
    runs: 1,
    results,
    summary: summariseByArm(results),
  };
}

describe("report", () => {
  test("makeStamp is filesystem-safe", () => {
    expect(makeStamp(new Date("2026-10-16T12:30:00.000Z"))).toBe("2026-10-16T12-30-00-000Z");
    expect(makeStamp()).not.toContain(":");
  });

  test("markdown contains the arm summary, gate and run detail", () => {
    const md = renderMarkdown(report("mock"));
    expect(md).toContain("# Code Mode harness report");
    expect(md).toMatch(/\| Arm \| Runs \|/);
    expect(md).toMatch(/\| A \|/);
    expect(md).toContain("## Gate");
    expect(md).toContain("**pass: yes**");
    expect(md).toContain("sample-task");
    expect(md).toContain("| 5 |"); // arm A turns
  });

  test("mock runs are labelled as synthetic, real drivers are not", () => {
    expect(renderMarkdown(report("mock"))).toContain("Synthetic usage");
    expect(renderMarkdown(report("opencode"))).not.toContain("Synthetic usage");
  });

  test("the gate caveat travels with the verdict in the markdown gate section", () => {
    const sections = (md: string) => md.slice(md.indexOf("## Gate"), md.indexOf("## Runs"));
    expect(sections(renderMarkdown(report("mock")))).toContain("SYNTHETIC NUMBERS");
    expect(sections(renderMarkdown(report("opencode")))).not.toContain("SYNTHETIC NUMBERS");
  });

  test("serialiseReport round-trips through JSON", () => {
    const original = report("mock");
    const parsed = JSON.parse(serialiseReport(original)) as RunReport;
    expect(parsed).toEqual(original);
    expect(serialiseReport(original).endsWith("\n")).toBe(true);
  });

  test("writeReport creates both files under <outBase>/<stamp>", async () => {
    const base = await tmp();
    const paths = await writeReport({ report: report("mock"), outBase: base, stamp: "STAMP" });
    expect(paths.dir).toBe(path.join(base, "STAMP"));
    expect(paths.json).toBe(path.join(base, "STAMP", "report.json"));
    expect(paths.markdown).toBe(path.join(base, "STAMP", "report.md"));

    const json = JSON.parse(await fs.readFile(paths.json, "utf8")) as RunReport;
    expect(json.driver).toBe("mock");
    const md = await fs.readFile(paths.markdown, "utf8");
    expect(md).toContain("Synthetic usage");
  });
});
