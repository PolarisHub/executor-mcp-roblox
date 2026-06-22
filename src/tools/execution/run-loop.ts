import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "run-loop",
  title: "Run a Luau snippet repeatedly with a delay, collecting results",
  description:
    "Run a Luau snippet `iterations` times in a single round trip, waiting `delayMs` between iterations, and collect " +
    "what each run produced. Use this to poll a value over time (e.g. read a Humanoid's Health every 200ms for 20 " +
    "iterations to watch it change), to retry a flaky operation, or to drive a short repeated action and see the " +
    "outcome of each pass — all without paying a tool round trip per iteration. The code is COMPILED ONCE (a syntax " +
    "error returns { error } and nothing runs); each iteration is executed inside its own pcall so a runtime error in " +
    "one pass is recorded and the loop continues. When collectReturns is true the FIRST return value of each run is " +
    "captured via __encVal (Instances become their full path, tables/functions become a stable string), giving an " +
    "ordered series you can compare across iterations. The whole loop runs synchronously in-client, so total time is " +
    "roughly iterations * delayMs — keep that under the tool timeout. Requires loadstring; uses task.wait for the " +
    "delay (falls back to wait). Returns { iterations, results, errorCount, errors } or { error }.",
  category: "Execution",
  mutatesState: true,
  input: z.object({
    code: z
      .string()
      .describe(
        "The Luau snippet to run each iteration. Compiled once, then executed every pass. To capture a value per " +
          "iteration, `return` it (only the first return value is collected when collectReturns is true).",
      ),
    iterations: z
      .number()
      .int()
      .describe(
        "How many times to run the snippet (default 5, clamped 1..1000). Combined with delayMs this determines total " +
          "wall-clock time, so keep iterations * delayMs comfortably under the request timeout.",
      )
      .optional()
      .default(5),
    delayMs: z
      .number()
      .describe(
        "Milliseconds to wait between iterations via task.wait (default 0 = yield minimally each pass). Use e.g. 200 " +
          "to sample a value five times a second. There is no wait after the final iteration.",
      )
      .optional()
      .default(0),
    collectReturns: z
      .boolean()
      .describe(
        "When true (default), capture the FIRST return value of each iteration into `results` (encoded as a " +
          "serializable scalar/string). Set false to skip capture when the snippet returns nothing useful or large " +
          "values you do not want echoed back.",
      )
      .optional()
      .default(true),
    threadContext: z.number().int().optional(),
  }),
  async execute({ code, iterations, delayMs, collectReturns, threadContext }, ctx) {
    const cap = Math.min(Math.max(Math.floor(iterations ?? 5), 1), 1000);
    const delaySec = (Math.max(delayMs ?? 0, 0) / 1000).toFixed(6);
    const collect = collectReturns !== false;
    const source = `
${REFLECT_PRELUDE}
if type(loadstring) ~= "function" then return { error = "loadstring is not available in this executor." } end

local __fn, __cerr = loadstring(${q(code)}, "=run-loop")
if not __fn then return { error = "compile error: " .. tostring(__cerr) } end

local __waiter = (type(task) == "table" and type(task.wait) == "function") and task.wait or wait
local __iters = ${cap}
local __delay = ${delaySec}
local __collect = ${collect ? "true" : "false"}
local __results = {}
local __errors = {}
local __errorCount = 0

for __i = 1, __iters do
  local __packed = table.pack(pcall(__fn))
  local __ok = __packed[1]
  if __ok then
    if __collect then
      local __v = __packed[2]
      local __okEnc, __enc = pcall(__encVal, __v)
      if __okEnc then __results[__i] = __enc else __results[__i] = "nil" end
    end
  else
    __errorCount = __errorCount + 1
    __errors[__i] = tostring(__packed[2])
    if __collect then __results[__i] = "nil" end
  end
  if __i < __iters and __delay >= 0 and type(__waiter) == "function" then
    pcall(__waiter, __delay)
  end
end

return {
  iterations = __iters,
  results = __results,
  errorCount = __errorCount,
  errors = __errors,
}
`;

    // The in-client loop runs synchronously; give it room for iterations*delay
    // plus per-iteration work, but never exceed the connector ceiling. If the
    // estimate already exceeds the ceiling, reject up front — otherwise we'd
    // clamp the wait BELOW the loop's own duration and report a false timeout
    // failure while discarding results the loop actually computed.
    const CEILING_MS = 120000;
    const estMs = cap * Math.max(delayMs ?? 0, 0) + 8000;
    if (estMs > CEILING_MS) {
      return {
        data: {
          error:
            `Estimated worst-case in-game time (~${Math.round(estMs / 1000)}s for ${cap} iterations at ` +
            `${Math.max(delayMs ?? 0, 0)}ms each) exceeds the ${CEILING_MS / 1000}s connector ceiling. ` +
            `Lower iterations or delayMs so iterations*delayMs stays under ~112000ms.`,
        },
        isError: true,
      };
    }
    const timeoutMs = Math.min(Math.max(estMs, 20000), CEILING_MS);

    const data = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data };
  },
});
