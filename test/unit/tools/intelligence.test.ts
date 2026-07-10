import { describe, expect, it } from "vitest";

import { intelligenceTools } from "../../../src/tools/intelligence/index.js";

describe("Intelligence tool registration", () => {
  it("exports the complete, uniquely named intelligence surface", () => {
    expect(intelligenceTools.map((tool) => tool.name)).toEqual([
      "observe-world",
      "resolve-entity",
      "smart-task",
      "assert-state",
      "explain-failure",
      "state-transaction",
      "teach-mode",
      "world-delta",
    ]);
    expect(new Set(intelligenceTools.map((tool) => tool.name)).size).toBe(8);
    for (const tool of intelligenceTools) expect(tool.category).toBe("Intelligence");
  });

  it("labels observer lifecycle tools as stateful without claiming gameplay mutation", () => {
    expect(intelligenceTools.find((tool) => tool.name === "world-delta")?.mutatesState).toBe(true);
    expect(intelligenceTools.find((tool) => tool.name === "teach-mode")?.mutatesState).toBe(true);
    expect(intelligenceTools.find((tool) => tool.name === "observe-world")?.mutatesState).toBe(
      false,
    );
  });
});
