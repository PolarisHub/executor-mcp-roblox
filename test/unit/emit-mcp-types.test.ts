import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../../src/application/tool/registry.js";
import { defineTool } from "../../src/application/tool/define-tool.js";
import { emitMcpLuauTypes } from "../../src/infrastructure/dashboard/emit-mcp-types.js";

const sampleTool = defineTool({
  name: "sample-tool",
  title: "Sample tool",
  description: "A sample tool used to verify the mcp.d.luau emit.",
  category: "Inspection",
  input: z.object({
    target: z.string().describe("The fully-qualified instance path."),
    limit: z.number().int().optional().describe("Cap on results returned."),
    quiet: z.boolean().optional(),
  }),
  async execute() {
    return { data: null };
  },
});

describe("emitMcpLuauTypes", () => {
  it("emits per-field doc comments alongside the typed alias", () => {
    const registry = new ToolRegistry();
    registry.register(sampleTool);
    const out = emitMcpLuauTypes(registry);

    expect(out).toContain("export type Mcp_SampleToolInput = {");
    expect(out).toContain("-- The fully-qualified instance path.");
    expect(out).toContain("target: string,");
    expect(out).toContain("-- Cap on results returned.");
    expect(out).toContain("-- Constraints: integer");
    expect(out).toContain("-- Example: 10");
    expect(out).toContain("limit: number?,");
    // A field without `.describe()` receives deterministic inferred help.
    expect(out).toContain("-- Whether to enable quiet.");
    expect(out).toContain("quiet: boolean?,");
    expect(out).toContain("-- Phase: observe; cost: medium; quality: A");
    expect(out).toContain("sampleTool: (args: Mcp_SampleToolInput) -> any,");
  });

  it("declares mcp.help and mcp.publish/subscribe in the public surface", () => {
    const registry = new ToolRegistry();
    registry.register(sampleTool);
    const out = emitMcpLuauTypes(registry);

    expect(out).toContain("help: (name: string?) -> any,");
    expect(out).toContain("publish: (channel: string, payload: any?) -> any,");
    expect(out).toContain("subscribe: (channel: string, handler: (any, string) -> ()) -> any,");
  });
});
