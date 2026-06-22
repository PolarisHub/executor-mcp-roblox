import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "get-console-output",
  title: "Get the roblox developer console output from the Roblox Game Client",
  description:
    "Read recent Roblox developer console logs from the active client. Use limit and logsOrder to control volume and ordering.",
  category: "Inspection",
  input: z.object({
    limit: z
      .number()
      .int()
      .describe("Maximum number of results to return (default: 50, to avoid overwhelming output)")
      .optional()
      .default(50),
    logsOrder: z
      .enum(["NewestFirst", "OldestFirst"])
      .describe("The order of the logs to return (default: NewestFirst)")
      .optional()
      .default("NewestFirst"),
    threadContext: z.number().int().optional(),
  }),
  async execute({ limit, logsOrder, threadContext }, ctx) {
    const safeLimit = Math.max(1, Math.floor(limit));
    const source = `
local limit = ${safeLimit}
local logsOrder = ${logsOrder === "OldestFirst" ? '"OldestFirst"' : '"NewestFirst"'}

local LogService = game:GetService("LogService")
local logs = LogService:GetLogHistory()
local results = {}

local function encode(entry)
  return {
    message = entry.message,
    messageType = tostring(entry.messageType),
    timestamp = entry.timestamp,
  }
end

if logsOrder == "NewestFirst" then
  for i = #logs, 1, -1 do
    if #results >= limit then break end
    table.insert(results, encode(logs[i]))
  end
else
  for _, log in ipairs(logs) do
    if #results >= limit then break end
    table.insert(results, encode(log))
  end
end

return { count = #logs, limited = #logs > limit, results = results }
`;
    const data = await ctx.runLuau(source, {
      timeoutMs: 30000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data };
  },
});
