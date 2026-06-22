import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "run-with-timeout",
  title: "Run a Luau snippet with a watchdog timeout",
  description:
    "Run a Luau snippet under a WATCHDOG: it executes on its own thread and this tool polls a done flag against an " +
    "os.clock() deadline, so a snippet that hangs on a YIELD (a yield that never resumes, a :Wait() on a signal that " +
    "never fires) cannot block the round trip forever — after timeoutSec you get a clean { timedOut = true } instead of " +
    "waiting out the whole connector timeout. Use this any time you are about to run code that MIGHT hang or take an " +
    "unknown amount of time. The snippet is COMPILED FIRST via loadstring (a syntax error returns { error } and nothing " +
    "runs), then started with task.spawn; the watchdog waits with task.wait until either the thread sets its done flag " +
    "or the deadline passes.\n\n" +
    "LIMITATION: Luau is cooperatively scheduled, so the watchdog can only fire when the snippet YIELDS. A snippet that " +
    "never yields (e.g. `while true do end` or a tight CPU loop with no task.wait) runs synchronously inside task.spawn, " +
    "so the watchdog loop never gets to run and the round trip still blocks until the connector timeout. Put a task.wait() " +
    "inside long loops if you want the watchdog to be able to interrupt them.\n\n" +
    "IMPORTANT: a timeout REPORTS that the snippet did not finish in time, but it does NOT kill the runaway thread — " +
    "the executor keeps running it in the background (and it may keep consuming CPU). Prefer snippets that can finish, " +
    "and keep timeoutSec sane. If the snippet completes in time, its FIRST return value is encoded via __encVal and " +
    "returned; a runtime error inside it is captured in `error`. Requires loadstring, the task library, and os.clock " +
    "(all guarded). Returns { completed, timedOut, elapsedMs, result?, error? } or { error }.",
  category: "Execution",
  mutatesState: true,
  input: z.object({
    code: z
      .string()
      .describe(
        "The Luau snippet to run under the watchdog. Compiled with loadstring and run on its own thread. To report a " +
          "value back, `return` it (only the first return value is captured, encoded as a serializable scalar/string).",
      ),
    timeoutSec: z
      .number()
      .describe(
        "How long to let the snippet run before giving up and reporting timedOut, in seconds (default 5, clamped " +
          "0.1..60). On timeout the snippet is NOT killed — it keeps running in the background; this only stops THIS " +
          "tool from waiting.",
      )
      .optional()
      .default(5),
    threadContext: z.number().int().optional(),
  }),
  async execute({ code, timeoutSec, threadContext }, ctx) {
    const timeout = Math.min(Math.max(timeoutSec ?? 5, 0.1), 60);
    const timeoutStr = timeout.toFixed(6);
    const source = `
${REFLECT_PRELUDE}
if type(loadstring) ~= "function" then return { error = "loadstring is not available in this executor." } end
if type(task) ~= "table" or type(task.spawn) ~= "function" or type(task.wait) ~= "function" then
  return { error = "the task library (task.spawn/task.wait) is not available in this executor." }
end
if type(os) ~= "table" or type(os.clock) ~= "function" then return { error = "os.clock is not available in this executor." } end

local __fn, __cerr = loadstring(${q(code)}, "=run-with-timeout")
if not __fn then return { error = "compile error: " .. tostring(__cerr) } end

local __state = { done = false, ok = nil, value = nil, err = nil }

task.spawn(function()
  local __packed = table.pack(pcall(__fn))
  __state.ok = __packed[1]
  if __packed[1] then
    __state.value = __packed[2]
  else
    __state.err = tostring(__packed[2])
  end
  __state.done = true
end)

local __t0 = os.clock()
local __deadline = __t0 + ${timeoutStr}
while (not __state.done) and (os.clock() < __deadline) do
  task.wait()
end
local __elapsedMs = (os.clock() - __t0) * 1000

if not __state.done then
  return { completed = false, timedOut = true, elapsedMs = __elapsedMs }
end

if __state.ok then
  local __okEnc, __enc = pcall(__encVal, __state.value)
  local __r
  if __okEnc then __r = __enc else __r = "nil" end
  return { completed = true, timedOut = false, elapsedMs = __elapsedMs, result = __r }
else
  return { completed = true, timedOut = false, elapsedMs = __elapsedMs, error = "runtime error: " .. tostring(__state.err) }
end
`;

    // Wait a few seconds beyond the in-client watchdog so we reliably receive
    // the timedOut/result table rather than hitting the connector timeout.
    const timeoutMs = Math.min(Math.ceil(timeout * 1000) + 8000, 120000);

    const data = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data };
  },
});
