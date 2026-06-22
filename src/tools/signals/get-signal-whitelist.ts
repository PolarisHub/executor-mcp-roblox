import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { SIGNAL_PRELUDE } from "../_shared/signals.js";

export default defineTool({
  name: "get-signal-whitelist",
  title: "List the engine's replicatable-signal whitelist",
  description:
    "Enumerate the full set of signals the Roblox engine allows to be replicated to the server, using the " +
    "executor's getsignalwhitelist. This is the global allow-list that can-signal-replicate / replicate-signal " +
    'check against, so it answers "which signals can I drive server-side?" up front, without probing them one at ' +
    "a time. The whitelist is typically large (180+ entries), so each entry is mapped through a safe serializer " +
    "and the output is capped at `limit`. Requires the getsignalwhitelist executor function; " +
    "degrades with a clear { error } if unavailable. Returns { Count, Truncated, Signals }.",
  category: "Signals & Connections",
  input: z.object({
    limit: z
      .number()
      .int()
      .positive()
      .describe(
        "Maximum number of whitelist entries to return (default 300). The list can be large, so this caps the response; Count always reflects the true total and Truncated indicates whether entries were dropped.",
      )
      .optional()
      .default(300),
    threadContext: z.number().int().optional(),
  }),
  async execute({ limit, threadContext }, ctx) {
    const source = `
${SIGNAL_PRELUDE}
if type(getsignalwhitelist) ~= "function" then
  return { error = "getsignalwhitelist is not available in this executor." }
end

local ok, res = pcall(getsignalwhitelist)
if not ok or type(res) ~= "table" then
  return { error = "getsignalwhitelist failed: " .. tostring(res) }
end

local limit = ${Math.max(1, Math.floor(limit))}

-- Whitelist entries are tables describing a signal, e.g. { Parent = "Seat",
-- Event = "RemoteCreateSeatWeld" }. Encode each field so the output is readable
-- instead of an opaque "table: 0x..." pointer.
local function encEntry(entry)
  if type(entry) == "table" then
    local t = {}
    for k, v in pairs(entry) do t[tostring(k)] = __encVal(v) end
    return t
  end
  return __encVal(entry)
end

local list = {}
local total = 0
for _, entry in pairs(res) do
  total = total + 1
  if #list < limit then
    list[#list + 1] = encEntry(entry)
  end
end

return {
  Count = total,
  Truncated = total > #list,
  Signals = list,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
