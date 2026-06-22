import { describe, expect, it } from "vitest";
import type { ToolContext } from "../../../src/application/tool/tool.js";
import { utilityTools } from "../../../src/tools/utility/index.js";
import getFastFlag from "../../../src/tools/utility/get-fast-flag.js";
import setFpsCap from "../../../src/tools/utility/set-fps-cap.js";
import messageBox from "../../../src/tools/utility/message-box.js";

interface Captured {
  source: string;
  options?: { threadContext?: number; timeoutMs?: number };
}

function stubContext(canned: unknown): { ctx: ToolContext; calls: Captured[] } {
  const calls: Captured[] = [];
  const ctx = {
    runLuau: async (source: string, options?: Captured["options"]) => {
      calls.push({ source, options });
      return canned;
    },
  } as unknown as ToolContext;
  return { ctx, calls };
}

describe("utility tools", () => {
  it("exports 10 tools, all in the Utility category, with unique names", () => {
    expect(utilityTools).toHaveLength(10);
    expect(new Set(utilityTools.map((t) => t.name)).size).toBe(10);
    for (const tool of utilityTools) {
      expect(tool.category).toBe("Utility");
    }
  });

  it("get-fast-flag is read-only and reads getfflag by name", async () => {
    expect(getFastFlag.mutatesState).toBe(false);
    const { ctx, calls } = stubContext({ name: "FFlagX", value: "true" });
    const input = getFastFlag.input.parse({ name: "FFlagX" });
    const result = await getFastFlag.execute(input, ctx);

    expect(result.data).toEqual({ name: "FFlagX", value: "true" });
    const src = calls[0]?.source ?? "";
    expect(src).toContain('type(getfflag) ~= "function"');
    expect(src).toContain('pcall(getfflag, "FFlagX")');
  });

  it("set-fps-cap mutates state and inlines the numeric cap", async () => {
    expect(setFpsCap.mutatesState).toBe(true);
    const { ctx, calls } = stubContext({ cap: 0, ok: true });
    const input = setFpsCap.input.parse({ cap: 0 });
    const result = await setFpsCap.execute(input, ctx);

    expect(result.data).toEqual({ cap: 0, ok: true });
    const src = calls[0]?.source ?? "";
    expect(src).toContain('type(setfpscap) ~= "function"');
    expect(src).toContain("pcall(setfpscap, 0)");
  });

  it("message-box mutates state and passes text/caption/flags to messagebox", async () => {
    expect(messageBox.mutatesState).toBe(true);
    const { ctx, calls } = stubContext({ result: 1 });
    const input = messageBox.input.parse({ text: "hi", caption: "Title", flags: 4 });
    const result = await messageBox.execute(input, ctx);

    expect(result.data).toEqual({ result: 1 });
    const src = calls[0]?.source ?? "";
    expect(src).toContain('type(messagebox) ~= "function"');
    expect(src).toContain('pcall(messagebox, "hi", "Title", 4)');
  });
});
