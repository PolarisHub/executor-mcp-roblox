import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "measure-memory",
  title: "Measure Lua heap growth caused by running a snippet",
  description:
    "Measure how much Lua heap memory a snippet allocates: read gcinfo() (the live Lua heap size in KB) immediately " +
    "before running your code, run it once (compiled via loadstring, executed inside a pcall), then read gcinfo() " +
    "again and report the delta. Use this to spot leaks or unexpectedly heavy allocations — e.g. confirm a function " +
    "frees what it creates, see how big a table a constructor builds, or detect a snippet that balloons the heap. " +
    "Caveats: gcinfo reports the WHOLE Lua heap, so concurrent game activity and garbage collection between the two " +
    "samples add noise; a negative deltaKB means a GC cycle ran (it does NOT mean your code freed memory). For a " +
    "cleaner reading, allocate enough to dwarf the noise or run a tight loop inside `code`. A compile error or a " +
    "runtime error is reported in `error` with ok=false (the before/after samples are still returned). Requires " +
    "gcinfo and loadstring (both guarded). Returns { beforeKB, afterKB, deltaKB, ok, error? } or { error }.",
  category: "Execution",
  mutatesState: true,
  input: z.object({
    code: z
      .string()
      .describe(
        "The Luau snippet to measure. Compiled with loadstring and run once between two gcinfo() samples. Whatever it " +
          "returns is ignored; only the change in heap size is reported. Allocate enough (or loop) so the delta stands " +
          "out above background GC noise.",
      ),
    threadContext: z.number().int().optional(),
  }),
  async execute({ code, threadContext }, ctx) {
    const source = `
if type(gcinfo) ~= "function" then return { error = "gcinfo is not available in this executor; cannot measure heap." } end
if type(loadstring) ~= "function" then return { error = "loadstring is not available in this executor." } end

local __okBefore, __before = pcall(gcinfo)
if not __okBefore or type(__before) ~= "number" then return { error = "gcinfo() did not return a number before run." } end

local __fn, __cerr = loadstring(${q(code)}, "=measure-memory")
if not __fn then
  return { beforeKB = __before, afterKB = __before, deltaKB = 0, ok = false, error = "compile error: " .. tostring(__cerr) }
end

local __ok, __err = pcall(__fn)

local __okAfter, __after = pcall(gcinfo)
if not __okAfter or type(__after) ~= "number" then __after = __before end

return {
  beforeKB = __before,
  afterKB = __after,
  deltaKB = __after - __before,
  ok = __ok == true,
  error = (not __ok) and ("runtime error: " .. tostring(__err)) or nil,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
