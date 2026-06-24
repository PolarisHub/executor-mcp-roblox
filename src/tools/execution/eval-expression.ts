import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { PRELUDE } from "../_shared/luau.js";

export default defineTool({
  name: "eval-expression",
  title: "Evaluate a single Luau expression",
  description:
    "Evaluate ONE Luau expression on the active client and return its typeof plus an encoded value. " +
    "Convenience wrapper over run-luau for quick reads like 'workspace.Gravity', '#game.Players:GetPlayers()', " +
    "or 'game.PlaceId'. The expression is pcall-guarded, so a runtime error is reported as { ok = false, error } " +
    "instead of failing the call. Pass an expression, not statements (no 'return', no ';'). " +
    "Note: this is PURE Luau — to compose with other server tools (e.g. `mcp.getPlayers()`, " +
    "`mcp.searchInstances({...})`) use the `script` tool instead.",
  category: "Execution",
  input: z.object({
    expression: z
      .string()
      .min(1)
      .describe("A single Luau expression to evaluate (e.g. 'workspace.Gravity', 'game.PlaceId')."),
  }),
  async execute({ expression }, ctx) {
    const source = `
${PRELUDE}
local ok, value = pcall(function() return (${expression}) end)
if not ok then
  return { ok = false, error = tostring(value) }
end
return { ok = true, type = typeof(value), value = __encode(value) }
`;
    const result = (await ctx.runLuau(source)) as {
      ok: boolean;
      type?: string;
      value?: unknown;
      error?: string;
    };

    if (result?.ok === false) {
      return {
        data: { error: result.error },
        summary: `Expression errored: ${result.error}`,
        isError: true,
      };
    }

    return {
      data: { type: result?.type, value: result?.value },
      summary: result?.type ? `=> ${result.type}` : undefined,
    };
  },
});
