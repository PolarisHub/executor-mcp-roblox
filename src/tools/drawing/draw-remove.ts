import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "draw-remove",
  title: "Remove a single Drawing object by id",
  description:
    "Destroys one Drawing overlay created by draw-create: looks the handle up by its integer id in " +
    "getgenv().__mcp_drawings, calls handle:Remove(), and clears the registry slot so list-drawings no longer " +
    "reports it. Use it to clean up a single ESP element while leaving the rest of the overlay intact. " +
    "Requires the `Drawing` table (type-guarded); the :Remove() call is " +
    "pcall-guarded. If the id is unknown it returns { removed = false, error }; on an executor without it, it returns " +
    '{ error = "Drawing is not available in this executor." }. ' +
    "Returns { id, removed } or { error }.",
  category: "Drawing",
  mutatesState: true,
  input: z.object({
    id: z
      .number()
      .int()
      .describe(
        "Integer id of the Drawing object to remove (as returned by draw-create / list-drawings).",
      ),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ id, threadContext, timeoutMs }, ctx) {
    const source = `
if type(Drawing) ~= "table" then return { error = "Drawing is not available in this executor." } end
if type(getgenv) ~= "function" then return { error = "getgenv is not available in this executor." } end

local genv = getgenv()
local registry = genv.__mcp_drawings
if type(registry) ~= "table" then return { error = "No drawings have been created (registry is empty)." } end

local id = ${Math.floor(id)}
local entry = registry[id]
if entry == nil then
  return { id = id, removed = false, error = "No drawing registered with id " .. tostring(id) .. "." }
end

local removed = false
if entry.handle ~= nil then
  local okRemove, removeErr = pcall(function() entry.handle:Remove() end)
  removed = okRemove
  registry[id] = nil
  if not okRemove then
    return { id = id, removed = false, error = "Remove() failed: " .. tostring(removeErr) }
  end
else
  registry[id] = nil
end

return { id = id, removed = removed }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: timeoutMs ?? 15000 });
    return { data };
  },
});
