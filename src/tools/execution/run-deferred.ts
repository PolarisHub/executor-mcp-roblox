import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "run-deferred",
  title: "Schedule a Luau snippet to run in the background (fire-and-forget)",
  description:
    "Schedule a Luau snippet to run on its OWN thread and return immediately WITHOUT waiting for it to finish. Use " +
    "this to start something that runs in the background while you keep issuing other tool calls — e.g. kick off a " +
    "long watcher loop, an auto-farm, a background poller, or any snippet you want to run later or off the current " +
    "thread so it cannot block the round trip. The code is COMPILED FIRST via loadstring; a syntax error is returned " +
    "cleanly as { error } and nothing is scheduled. On success the compiled function is handed to the chosen scheduler " +
    "and the tool returns at once.\n\n" +
    "Modes (Luau task library):\n" +
    "  - 'spawn'  -> task.spawn(fn): start running on a fresh thread immediately.\n" +
    "  - 'defer'  -> task.defer(fn): run on a fresh thread at the end of the current resumption cycle.\n" +
    "  - 'delay'  -> task.delay(delaySec, fn): run on a fresh thread after delaySec seconds.\n\n" +
    "IMPORTANT: because this does not wait, you will NOT see the snippet's return value, errors, or print output here — " +
    "the scheduled thread runs independently and any error inside it is swallowed by task. If the snippet installs " +
    "state or a loop, YOU are responsible for stopping it (e.g. have it watch a getgenv() flag). Requires loadstring " +
    "and the task library (both guarded). Returns { scheduled = true, mode, delaySec? } or { error }.",
  category: "Execution",
  mutatesState: true,
  input: z.object({
    code: z
      .string()
      .describe(
        "The Luau snippet to run in the background. Compiled with loadstring, then scheduled on its own thread. Since " +
          "nothing is awaited, build in your own stop condition for long loops (e.g. `while getgenv().__myFlag do ... " +
          "task.wait() end`) so you can shut it down later.",
      ),
    mode: z
      .enum(["spawn", "defer", "delay"])
      .describe(
        "How to schedule the thread: 'spawn' starts it immediately on a new thread; 'defer' runs it at the end of the " +
          "current resumption cycle; 'delay' runs it after `delaySec` seconds. Default 'spawn'.",
      )
      .optional()
      .default("spawn"),
    delaySec: z
      .number()
      .describe(
        "Seconds to wait before the snippet runs. Only used when mode='delay' (ignored for spawn/defer). Default 0.",
      )
      .optional()
      .default(0),
    threadContext: z.number().int().optional(),
  }),
  async execute({ code, mode, delaySec, threadContext }, ctx) {
    const safeMode = mode ?? "spawn";
    const delay = Math.max(delaySec ?? 0, 0);
    const source = `
if type(loadstring) ~= "function" then return { error = "loadstring is not available in this executor." } end
if type(task) ~= "table" then return { error = "the task library is not available in this executor." } end

local __fn, __cerr = loadstring(${q(code)}, "=run-deferred")
if not __fn then return { error = "compile error: " .. tostring(__cerr) } end

-- Wrap so a runtime error inside the background thread can never bubble up and
-- destabilize the scheduler; the snippet runs detached and unobserved.
local __wrapped = function() pcall(__fn) end

local __mode = ${q(safeMode)}
local __delay = ${delay}
local __scheduled = false

if __mode == "spawn" then
  if type(task.spawn) ~= "function" then return { error = "task.spawn is not available in this executor." } end
  local __ok, __err = pcall(task.spawn, __wrapped)
  if not __ok then return { error = "task.spawn failed: " .. tostring(__err) } end
  __scheduled = true
elseif __mode == "defer" then
  if type(task.defer) ~= "function" then return { error = "task.defer is not available in this executor." } end
  local __ok, __err = pcall(task.defer, __wrapped)
  if not __ok then return { error = "task.defer failed: " .. tostring(__err) } end
  __scheduled = true
elseif __mode == "delay" then
  if type(task.delay) ~= "function" then return { error = "task.delay is not available in this executor." } end
  local __ok, __err = pcall(task.delay, __delay, __wrapped)
  if not __ok then return { error = "task.delay failed: " .. tostring(__err) } end
  __scheduled = true
else
  return { error = "unknown mode: " .. tostring(__mode) }
end

return { scheduled = __scheduled, mode = __mode, delaySec = (__mode == "delay") and __delay or nil }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
