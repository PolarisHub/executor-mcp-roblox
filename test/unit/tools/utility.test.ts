import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ToolContext } from "../../../src/application/tool/tool.js";
import type {
  ToolDirectory,
  ToolDescriptor,
} from "../../../src/application/ports/tool-directory.js";
import { utilityTools } from "../../../src/tools/utility/index.js";
import getFastFlag from "../../../src/tools/utility/get-fast-flag.js";
import setFpsCap from "../../../src/tools/utility/set-fps-cap.js";
import messageBox from "../../../src/tools/utility/message-box.js";
import toolSchema from "../../../src/tools/utility/tool-schema.js";
import toolPlan from "../../../src/tools/utility/tool-plan.js";
import agentContext from "../../../src/tools/utility/agent-context.js";

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

function plannerContext(): ToolContext {
  const tools: ToolDescriptor[] = [
    {
      name: "get-players",
      title: "Get connected players",
      description: "Returns the players currently in the game.",
      category: "Inspection",
      mutatesState: false,
      requiresClient: true,
      input: z.object({ limit: z.number().int().optional().describe("Max players to return.") }),
    },
    {
      name: "set-instance-property",
      title: "Set a property on an instance",
      description: "Writes a property by path.",
      category: "Actions",
      mutatesState: true,
      requiresClient: true,
      input: z.object({ path: z.string(), property: z.string(), value: z.unknown() }),
    },
  ];
  return {
    tools: {
      list: () => tools,
      find: (name: string) => tools.find((tool) => tool.name === name) ?? null,
    },
  } as unknown as ToolContext;
}

describe("utility tools", () => {
  it("exports 15 tools, all in the Utility category, with unique names", () => {
    expect(utilityTools).toHaveLength(15);
    expect(new Set(utilityTools.map((t) => t.name)).size).toBe(15);
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

  describe("tool-schema", () => {
    function fakeDirectory(): ToolDirectory {
      const tools: ToolDescriptor[] = [
        {
          name: "get-players",
          title: "Get connected players",
          description: "Returns the players currently in the game.",
          category: "Inspection",
          mutatesState: false,
          requiresClient: true,
          input: z.object({
            limit: z.number().int().optional().describe("Max players to return."),
            includeBots: z.boolean().optional().describe("Include AI/bot players."),
          }),
        },
        {
          name: "set-instance-property",
          title: "Set a property on an instance",
          description: "Writes a property by path.",
          category: "Actions",
          mutatesState: true,
          requiresClient: true,
          input: z.object({
            path: z.string().describe("Dotted path."),
            property: z.string(),
            value: z.unknown(),
          }),
        },
      ];
      return {
        list: () => tools,
        find: (name) => tools.find((t) => t.name === name) ?? null,
      };
    }
    function ctxWithDirectory(): ToolContext {
      return { tools: fakeDirectory() } as unknown as ToolContext;
    }

    it("returns the signature, args list, and example for a named tool", async () => {
      const ctx = ctxWithDirectory();
      const result = await toolSchema.execute({ name: "get-players" }, ctx);
      const data = result.data as {
        name: string;
        camelCase: string;
        signature: string;
        args: Array<{ name: string; type: string; optional: boolean; description: string | null }>;
        example: string;
      };
      expect(data.name).toBe("get-players");
      expect(data.camelCase).toBe("getPlayers");
      expect(data.signature).toBe("{ limit: number?, includeBots: boolean? }");
      expect(data.args).toHaveLength(2);
      expect(data.args[0]).toMatchObject({
        name: "limit",
        type: "number?",
        optional: true,
        description: "Max players to return.",
      });
      // Every field is optional → example has no positional args.
      expect(data.example).toBe("mcp.getPlayers()");
    });

    it("includes required fields in the example invocation", async () => {
      const ctx = ctxWithDirectory();
      const result = await toolSchema.execute({ name: "set-instance-property" }, ctx);
      const data = result.data as { example: string };
      expect(data.example).toContain("mcp.setInstanceProperty(");
      expect(data.example).toContain('path = "..."');
      expect(data.example).toContain('property = "..."');
    });

    it("returns near-miss suggestions with signatures when the name is unknown", async () => {
      const ctx = ctxWithDirectory();
      const result = await toolSchema.execute({ name: "get-player" }, ctx);
      expect(result.isError).toBe(true);
      const data = result.data as {
        didYouMean: Array<{ name: string; signature: string }>;
      };
      const names = data.didYouMean.map((d) => d.name);
      expect(names).toContain("get-players");
      const suggestion = data.didYouMean.find((d) => d.name === "get-players");
      expect(suggestion?.signature).toBe("{ limit: number?, includeBots: boolean? }");
    });

    it("listing mode returns every tool's signature", async () => {
      const ctx = ctxWithDirectory();
      const result = await toolSchema.execute({}, ctx);
      const data = result.data as {
        count: number;
        tools: Array<{ name: string; signature: string }>;
      };
      expect(data.count).toBe(2);
      expect(data.tools.map((t) => t.name)).toEqual(["get-players", "set-instance-property"]);
    });

    it("search mode filters by keyword across name/title/description", async () => {
      const ctx = ctxWithDirectory();
      const result = await toolSchema.execute({ search: "property" }, ctx);
      const data = result.data as { tools: Array<{ name: string }> };
      expect(data.tools.map((t) => t.name)).toEqual(["set-instance-property"]);
    });
  });

  describe("tool-plan", () => {
    it("turns a natural-language goal into schema-aware ranked candidates", async () => {
      const result = await toolPlan.execute(
        {
          goal: "find the player's cash",
          limit: 5,
          includeMutating: false,
          capabilityAware: false,
        },
        plannerContext(),
      );
      const data = result.data as {
        goal: string;
        alternatives: Array<{
          name: string;
          signature: string;
          mutatesState: boolean;
          why: string;
        }>;
        guidance: string[];
      };

      expect(data.goal).toBe("find the player's cash");
      expect(data.alternatives[0]?.name).toBe("get-players");
      expect(data.alternatives[0]?.signature).toContain("limit");
      expect(data.alternatives[0]?.mutatesState).toBe(false);
      expect(data.alternatives[0]?.why).toContain("Matched");
      expect(data.guidance).toContain(
        "Mutating tools were excluded; set includeMutating=true when you are ready to act.",
      );
    });
  });

  describe("agent-context", () => {
    it("reports a missing client and gives the agent a concrete next step", async () => {
      const result = await agentContext.execute(
        {
          includeGameInfo: false,
          includeExecutorInfo: false,
          includeCapabilities: false,
          includeHistory: false,
          historyLimit: 1,
          includeMemory: false,
          memoryLimit: 1,
        },
        {
          clients: { list: () => [], get: () => undefined },
          session: {
            id: "session-test",
            label: "Test",
            resolve: () => ({ status: "none", reason: "no-clients" }),
          },
        } as unknown as ToolContext,
      );
      const data = result.data as { readyForClientTools: boolean; recommendations: string[] };

      expect(data.readyForClientTools).toBe(false);
      expect(data.recommendations[0]).toContain("Connect a Roblox executor client");
      expect(result.summary).toBe("No Roblox clients connected.");
    });
  });
});
