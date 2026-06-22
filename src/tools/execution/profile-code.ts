import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "profile-code",
  title: "Time a Luau snippet over repeated runs (micro-benchmark)",
  description:
    "Micro-benchmark a Luau snippet by running it `runs` times and timing each run with os.clock(), returning the " +
    "wall-clock statistics so you can measure how fast (or how variable) a piece of code is. Use this to compare two " +
    "implementations, to find out how expensive a function call / loop / property access really is, or to confirm a " +
    "fix actually made something faster. The code is COMPILED ONCE via loadstring (a syntax error is returned cleanly " +
    "as { error } and nothing is run); then each of the `runs` invocations is timed individually inside its own pcall " +
    "so a runtime error in one run is counted but does not abort the benchmark. Timing measures the run only — compile " +
    "time is excluded. Note os.clock() resolution is coarse, so for very cheap snippets raise `runs` or wrap a loop " +
    "inside your code. Requires loadstring and os.clock (both guarded). Returns { runs, totalMs, avgMs, minMs, maxMs, " +
    "errorCount, firstError? } or { error }.",
  category: "Execution",
  mutatesState: true,
  input: z.object({
    code: z
      .string()
      .describe(
        "The Luau snippet to benchmark. Compiled once with loadstring, then executed `runs` times. It may do anything " +
          "(call a function, run a loop, read properties); any value it returns is ignored — only the elapsed time per " +
          "run is measured. Wrap an inner loop here if a single execution is too cheap to time accurately.",
      ),
    runs: z
      .number()
      .int()
      .describe(
        "How many times to execute the compiled snippet (default 1, clamped 1..100000). More runs give a more stable " +
          "average for cheap code but take longer. Each run is timed and pcall-guarded independently.",
      )
      .optional()
      .default(1),
    threadContext: z.number().int().optional(),
  }),
  async execute({ code, runs, threadContext }, ctx) {
    const cap = Math.min(Math.max(Math.floor(runs ?? 1), 1), 100000);
    const source = `
if type(loadstring) ~= "function" then return { error = "loadstring is not available in this executor." } end
if type(os) ~= "table" or type(os.clock) ~= "function" then return { error = "os.clock is not available in this executor." } end

local __fn, __cerr = loadstring(${q(code)}, "=profile-code")
if not __fn then return { error = "compile error: " .. tostring(__cerr) } end

local __runs = ${cap}
local __total = 0
local __min = nil
local __max = nil
local __errorCount = 0
local __firstError = nil

for __i = 1, __runs do
  local __t0 = os.clock()
  local __ok, __err = pcall(__fn)
  local __dt = os.clock() - __t0
  if __dt < 0 then __dt = 0 end
  __total = __total + __dt
  if __min == nil or __dt < __min then __min = __dt end
  if __max == nil or __dt > __max then __max = __dt end
  if not __ok then
    __errorCount = __errorCount + 1
    if __firstError == nil then __firstError = tostring(__err) end
  end
end

local __toMs = function(s) return s * 1000 end
return {
  runs = __runs,
  totalMs = __toMs(__total),
  avgMs = __toMs(__total / __runs),
  minMs = __toMs(__min or 0),
  maxMs = __toMs(__max or 0),
  errorCount = __errorCount,
  firstError = __firstError,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
