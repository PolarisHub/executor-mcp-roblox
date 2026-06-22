import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "clear-remote-spy-logs",
  title: "Empty the remote-spy log ring buffer",
  description:
    "Empties getgenv().__mcp_remoteSpy.logs without uninstalling the spy or touching the block/ignore sets — the hook " +
    "keeps capturing new calls afterwards. Use it to reset the buffer before reproducing a specific action so the logs " +
    "you then read with get-remote-spy-logs contain only the calls of interest. The legacy clear-remote-spy-logs was a " +
    "Cobalt connector wrapper; this clears the self-contained getgenv ring buffer instead. Returns " +
    "{ cleared, removed } where `removed` is how many entries were discarded, or { notRunning, cleared=false } when " +
    "the spy has not been installed.",
  category: "Remote Spy",
  input: z.object({
    threadContext: z.number().int().optional(),
  }),
  async execute({ threadContext }, ctx) {
    const source = `
if type(getgenv) ~= "function" then return { error = "getgenv not available" } end
local genv = getgenv()
local st = genv.__mcp_remoteSpy
if type(st) ~= "table" or type(st.logs) ~= "table" then
  return { notRunning = true, cleared = false, removed = 0 }
end

local removed = #st.logs
-- Replace in place so any closure holding a reference to the old table is not
-- stranded; the hook re-reads st.logs each call anyway.
st.logs = {}
return { cleared = true, removed = removed }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 15000 });
    return { data };
  },
});
