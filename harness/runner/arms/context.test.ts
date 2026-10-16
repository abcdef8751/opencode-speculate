import { describe, expect, test } from "bun:test";
import { EXECUTE_TOOL, armSystemMessage, parseArmMarker, toolsForArm } from "./context.ts";
import { scriptPrompt } from "./arm-script.ts";
import { testTask, testToolbox } from "../testing.ts";

describe("arm marker (informational)", () => {
  test("round-trips through the system message for every arm", () => {
    const task = testTask({ id: "demo" });
    for (const arm of ["A", "B", "C"] as const) {
      const message = armSystemMessage(arm, task, 4);
      expect(message.startsWith(`harness:arm=${arm};task=demo;run=4`)).toBe(true);
      expect(parseArmMarker(message)).toEqual({ arm, taskId: "demo", runIndex: 4 });
    }
  });

  test("absent or unrelated text yields no marker", () => {
    expect(parseArmMarker("no marker here")).toBeUndefined();
    expect(parseArmMarker(undefined)).toBeUndefined();
    expect(parseArmMarker("harness:arm=Z;task=x;run=1")).toBeUndefined();
  });

  test("the arm-C prompt names the decide path (the signal a driver can detect arm C by)", () => {
    const task = testTask({ id: "demo", escalationPrompt: "escalate on low confidence" });
    const ctx = { task } as Parameters<typeof scriptPrompt>[1];
    expect(scriptPrompt("C", ctx)).toContain("tools.typesafe.decide");
    expect(scriptPrompt("B", ctx)).not.toContain("decide");
    expect(armSystemMessage("A", task, 0)).toContain("direct tool loop");
    expect(armSystemMessage("C", task, 0)).toContain("Code Mode program");
  });
});

describe("tools per arm", () => {
  test("arm A sees the toolbox descriptors, arms B/C see the single execute tool", async () => {
    const toolbox = await testToolbox();
    const ctx = { toolbox } as Parameters<typeof toolsForArm>[1];
    expect(toolsForArm("A", ctx).map((tool) => tool.name)).toEqual(["read", "grep", "glob", "shell", "edit", "write"]);
    expect(toolsForArm("B", ctx)).toEqual([EXECUTE_TOOL]);
    expect(toolsForArm("C", ctx)).toEqual([EXECUTE_TOOL]);
    expect(EXECUTE_TOOL.name).toBe("execute");
  });
});
