import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, PRELUDE } from "../_shared/luau.js";

export default defineTool({
  name: "execute-and-wait",
  title: "Execute code and wait for the result",
  description:
    "Run Luau in the active Roblox client and WAIT for what happened, returning a structured result: " +
    "{ ok, returnValue, output, error? }. Unlike the fire-and-forget 'execute' tool, this reports success/failure, " +
    "any error message, the FIRST value your code returns (encoded so Instances/Vector3/etc. survive), and the " +
    'print()/warn() output it emitted. Output capture connects game:GetService("LogService").MessageOut to a buffer ' +
    "for the duration of the run, then disconnects — so it sees logs even when an executor routes print() to the " +
    "Roblox console rather than swapping the global. The code is COMPILED FIRST via loadstring (a syntax error is " +
    "reported as { ok = false, error } and nothing runs), then executed under pcall; a runtime error is reported in " +
    "`error`, never as a tool failure. Use this for quick experiments, debugging, or calling a function and " +
    "inspecting what it gives back in one round trip.",
  category: "Execution",
  mutatesState: true,
  input: z.object({
    code: z
      .string()
      .describe(
        "The Luau code to run. It may 'return' a value (the FIRST return comes back in `returnValue`, encoded) and " +
          "may print()/warn() (captured into `output`). Do not JSON-encode anything yourself.",
      ),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().positive().optional(),
  }),
  async execute({ code, threadContext, timeoutMs }, ctx) {
    const source = `
${PRELUDE}
if type(loadstring) ~= "function" then return { ok = false, error = "loadstring is not available in this executor.", output = {} } end

local __fn, __cerr = loadstring(${q(code)}, "=execute-and-wait")
if not __fn then return { ok = false, error = "compile error: " .. tostring(__cerr), output = {} } end

-- Capture print()/warn() output by listening on LogService.MessageOut for the
-- duration of the run. Works even when the executor routes print to the console.
local __captured = {}
local __conn = nil
pcall(function()
  local __logService = game:GetService("LogService")
  __conn = __logService.MessageOut:Connect(function(message)
    __captured[#__captured + 1] = tostring(message)
  end)
end)

local __packed = table.pack(pcall(__fn))

-- Give MessageOut a tick to flush any queued lines before disconnecting.
if type(task) == "table" and type(task.wait) == "function" then
  pcall(task.wait)
else
  pcall(wait)
end
if __conn then pcall(function() __conn:Disconnect() end) end

local __ok = __packed[1]
if __ok then
  local __okEnc, __enc = pcall(__encode, __packed[2])
  return {
    ok = true,
    returnValue = __okEnc and __enc or nil,
    output = __captured,
  }
else
  return {
    ok = false,
    error = "runtime error: " .. tostring(__packed[2]),
    output = __captured,
  }
end
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data };
  },
});
