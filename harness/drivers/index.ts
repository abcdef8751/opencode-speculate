/**
 * Driver entry point. Worker D1 imports `createMockDriver`, `createOpenCodeCliDriver` and
 * `createFakeJudge` from here (see docs/CONTRACTS.md §4) — nothing else is required.
 */
export { createMockDriver, detectArm, synthesizeUsage } from "./mock.ts";
export type { MockDriverOptions } from "./mock.ts";
export { createOpenCodeCliDriver, parseOpenCodeRunOutput } from "./opencode-cli.ts";
export type { OpenCodeCliDriverOptions } from "./opencode-cli.ts";
export { createFakeJudge, FAKE_JUDGE_MODEL } from "./fake-judge.ts";
export type { FakeJudge, FakeJudgeScriptEntry } from "./fake-judge.ts";
