import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "draw-clear",
  title: "Remove ALL Drawing objects (wipe the overlay)",
  description:
    "Tears down the entire MCP-managed Drawing overlay: iterates every handle stored in getgenv().__mcp_drawings, " +
    "calls :Remove() on each, empties the registry, and additionally calls Drawing.clear() when the executor " +
    "exposes it (to sweep any stray objects this tool did not create). Use it as a one-shot reset between ESP " +
    "sessions. " +
    "Requires the `Drawing` table (type-guarded); each :Remove() and the optional " +
    "Drawing.clear() are pcall-guarded so a single bad handle never aborts the wipe. On an executor without it, it " +
    'returns { error = "Drawing is not available in this executor." }. ' +
    "Returns { cleared, failed, drawingClearCalled } or { error }, where 'cleared' is the count of registry " +
    "handles successfully removed.",
  category: "Drawing",
  mutatesState: true,
  input: z.object({
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ threadContext, timeoutMs }, ctx) {
    const source = `
if type(Drawing) ~= "table" then return { error = "Drawing is not available in this executor." } end
if type(getgenv) ~= "function" then return { error = "getgenv is not available in this executor." } end

local genv = getgenv()
local registry = genv.__mcp_drawings
local cleared = 0
local failed = 0

if type(registry) == "table" then
  for id, entry in pairs(registry) do
    if type(entry) == "table" and entry.handle ~= nil then
      local okRemove = pcall(function() entry.handle:Remove() end)
      if okRemove then cleared = cleared + 1 else failed = failed + 1 end
    end
    registry[id] = nil
  end
end
genv.__mcp_drawings = {}

local drawingClearCalled = false
if type(Drawing.clear) == "function" then
  drawingClearCalled = pcall(Drawing.clear)
end

return { cleared = cleared, failed = failed, drawingClearCalled = drawingClearCalled }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: timeoutMs ?? 15000 });
    return { data };
  },
});
