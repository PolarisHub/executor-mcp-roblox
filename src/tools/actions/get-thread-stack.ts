import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "get-thread-stack",
  title: "Walk a thread/coroutine's call stack",
  description:
    "Walk the call stack of a Luau thread/coroutine frame-by-frame using debug.info. For each level it reports the " +
    "function Name, Source, and Line (debug.info(thread, level, 'nsl')), stopping when the stack is exhausted. If " +
    "threadPath is omitted it traces the CURRENT injected thread instead, using debug.info(level, 'nsl'). A " +
    "debug.traceback() string is also included when available. Use this to see exactly where a suspended coroutine " +
    "or an event handler's thread is currently executing — e.g. pass a connection's .Thread, a stored coroutine, or " +
    "leave it blank to inspect your own execution context. " +
    "WARNING: this ACTS ON THE LIVE GAME — it evaluates your threadPath expression and introspects live thread state " +
    "in the running client. " +
    "Returns { Thread?, FrameCount, Frames:[{ Level, Name, Source, Line }], Traceback? } or { error }.",
  category: "Actions",
  input: z.object({
    threadPath: z
      .string()
      .describe(
        "Optional Luau expression resolving to a thread/coroutine, e.g. 'getconnections(game.Workspace.Part.Touched)[1].Thread', " +
          "'getgenv().myCoroutine', or 'coroutine.running()'. Evaluated as `return <threadPath>`. If omitted, the current " +
          "injected thread is traced instead.",
      )
      .optional(),
    maxLevels: z
      .number()
      .int()
      .min(1)
      .max(60)
      .describe(
        "Maximum number of stack levels to walk before stopping (default 20, max 60). Walking stops early once " +
          "debug.info returns nil for a level (top of stack reached).",
      )
      .optional()
      .default(20),
    threadContext: z.number().int().optional(),
  }),
  async execute({ threadPath, maxLevels, threadContext }, ctx) {
    const hasThread = typeof threadPath === "string" && threadPath.length > 0;
    const source = `
${REFLECT_PRELUDE}
local __maxLevels = ${maxLevels}

if not __hasDebug or type(__d.info) ~= "function" then
  return { error = "debug.info is not available in this executor; cannot walk thread stacks." }
end

local __thread = nil
local __hasThreadArg = ${hasThread ? "true" : "false"}
if __hasThreadArg then
  local t, err = __eval(${hasThread ? q(threadPath) : '""'})
  if err then return { error = err } end
  if typeof(t) ~= "thread" then
    return { error = "expression did not resolve to a thread (got " .. typeof(t) .. "): " .. ${hasThread ? q(threadPath) : '""'} }
  end
  __thread = t
end

local frames = {}
for level = 1, __maxLevels do
  local ok, name, source, line
  if __thread ~= nil then
    ok, name, source, line = pcall(__d.info, __thread, level, "nsl")
  else
    ok, name, source, line = pcall(__d.info, level, "nsl")
  end
  if not ok then break end
  if name == nil and source == nil and line == nil then break end
  frames[#frames + 1] = {
    Level = level,
    Name = (name ~= nil and tostring(name)) or "",
    Source = (source ~= nil and tostring(source)) or "",
    Line = (type(line) == "number" and line) or -1,
  }
end

local traceback = nil
if type(debug) == "table" and type(debug.traceback) == "function" then
  local okTb, tb = pcall(function()
    if __thread ~= nil then return debug.traceback(__thread) end
    return debug.traceback()
  end)
  if okTb and tb ~= nil then traceback = tostring(tb) end
end

return {
  Thread = __hasThreadArg and ${hasThread ? q(threadPath) : '"<current>"'} or "<current>",
  FrameCount = #frames,
  Frames = frames,
  Traceback = traceback,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
