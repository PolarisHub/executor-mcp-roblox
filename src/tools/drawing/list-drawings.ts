import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "list-drawings",
  title: "List all MCP-managed Drawing objects — REQUIRES a Volt-class executor",
  description:
    "Read-only inventory of the Drawing overlay this server manages: walks getgenv().__mcp_drawings and returns " +
    "each registered object's { id, type, visible } so you can see what is currently on screen before updating or " +
    "removing it. 'visible' reflects the live handle.Visible property (pcall-read; null if it could not be read). " +
    "Does NOT touch the screen or any handle. " +
    "Requires a Volt-class executor exposing the `Drawing` table (type-guarded). On a non-Volt executor it returns " +
    "{ error = \"Drawing is not available in this executor.\" }. The list is capped by 'limit'. " +
    "Returns { count, truncated, drawings[] } or { error }.",
  category: "Drawing",
  input: z.object({
    limit: z
      .number()
      .int()
      .describe("Max number of drawings to return (default 200). Hitting it sets truncated=true.")
      .optional()
      .default(200),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ limit, threadContext, timeoutMs }, ctx) {
    const cap = Math.min(Math.max(Math.floor(limit), 1), 5000);
    const source = `
if type(Drawing) ~= "table" then return { error = "Drawing is not available in this executor." } end
if type(getgenv) ~= "function" then return { error = "getgenv is not available in this executor." } end

local genv = getgenv()
local registry = genv.__mcp_drawings
local drawings = {}
local count = 0
local truncated = false

if type(registry) == "table" then
  for id, entry in pairs(registry) do
    if type(entry) == "table" and entry.handle ~= nil then
      count = count + 1
      if #drawings < ${cap} then
        local visible = nil
        local okVis, v = pcall(function() return entry.handle.Visible end)
        if okVis then visible = v end
        drawings[#drawings + 1] = { id = id, type = entry.type, visible = visible }
      else
        truncated = true
      end
    end
  end
end

return { count = count, truncated = truncated, drawings = drawings }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: timeoutMs ?? 15000 });
    return { data };
  },
});
