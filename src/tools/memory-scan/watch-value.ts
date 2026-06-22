import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "watch-value",
  title: "Watch any Luau expression over time (live value monitor)",
  description:
    "Sample ANY Luau expression repeatedly over a bounded window and report every value it took plus exactly when " +
    "it changed — a live memory/state monitor for reverse-engineering and debugging. Give an expression that returns " +
    "a value (no `return` keyword needed) and the tool compiles it once with loadstring, then polls it on a fixed " +
    "interval until the duration elapses, recording the first sample and every subsequent change. " +
    "Use it to confirm a value actually mutates when you trigger an action (watch leaderstats coins tick up, a " +
    "Humanoid's Health drop, an anti-cheat flag flip, a getgenv() speed multiplier, a remote-cooldown timer, or a " +
    "metatable hook's hit counter), to time how fast something updates, or to prove a suspected variable is the one " +
    "that drives a behavior. " +
    "EXAMPLES: 'game.Players.LocalPlayer.leaderstats.Coins.Value', 'getgenv().speed', " +
    "'workspace.CurrentCamera.CFrame.Position', '#getconnections(game.Workspace.Part.Touched)', " +
    "'tostring(getgenv().__mcp_remotespy and #getgenv().__mcp_remotespy.logs)'. " +
    "The expression is evaluated as `return <expression>`, so it can be any value-producing Luau (indexing, function " +
    "calls, arithmetic, concatenation). Each sample is stringified for transport (Instances become GetFullName()). " +
    "Change detection compares the live value with the previous one via `~=`, so it catches identity changes for " +
    "tables/Instances and equality changes for scalars. " +
    "IMPORTANT: this call BLOCKS in-client for roughly `durationMs` while it samples (it is inherently synchronous), " +
    "so keep durations short and perform the triggering action shortly before or during the watch. " +
    "Everything is fully pcall-guarded: a compile error returns { error } immediately, and a per-tick evaluation " +
    "error is recorded as a sample value rather than aborting the loop. " +
    "Returns { expression, intervalMs, durationMs, sampleCount, changeCount, truncated, samples = [{ t, value, changed, ok }] }.",
  category: "Memory Scan",
  input: z.object({
    expression: z
      .string()
      .describe(
        "Any Luau expression that returns a value (do NOT prefix with `return` — the tool adds it). " +
          "Examples: 'game.Players.LocalPlayer.leaderstats.Coins.Value', 'getgenv().speed', " +
          "'workspace.CurrentCamera.FieldOfView', '#getconnections(game.Workspace.Part.Touched)'.",
      ),
    intervalMs: z
      .number()
      .describe(
        "Polling interval in milliseconds between samples (default: 200, clamped 20..5000). Smaller catches fast " +
          "transitions but produces more samples and more in-client overhead.",
      )
      .optional()
      .default(200),
    durationMs: z
      .number()
      .describe(
        "Total time to watch in milliseconds (default: 5000, clamped 50..30000). The call blocks in-client for about " +
          "this long; the network timeout is set to durationMs + 10000 so the loop finishes before the round-trip times out.",
      )
      .optional()
      .default(5000),
    threadContext: z.number().int().optional(),
  }),
  async execute({ expression, intervalMs, durationMs, threadContext }, ctx) {
    const interval = Math.max(20, Math.min(5000, Math.floor(intervalMs)));
    const duration = Math.max(50, Math.min(30000, Math.floor(durationMs)));

    const source = `
local expression = ${q(expression)}
local intervalSec = ${interval} / 1000
local durationSec = ${duration} / 1000
local MAX_SAMPLES = 300

-- Compile the getter once. A compile failure is a hard error.
local fn, cerr = loadstring("return " .. expression)
if not fn then
  return { error = "compile error: " .. tostring(cerr), expression = expression }
end

-- Encode any value into a transport-safe string. Instances become their full
-- path; everything else is tostring'd. Fully guarded so a weird __tostring
-- metamethod or a dead Instance can never abort the loop.
local function encode(v)
  local ok, t = pcall(typeof, v)
  if not ok then t = type(v) end
  if t == "Instance" then
    local okF, full = pcall(function() return v:GetFullName() end)
    if okF then return "Instance: " .. tostring(full) end
    return "<Instance>"
  end
  if t == "nil" then return "nil" end
  local okS, s = pcall(tostring, v)
  if okS then return s end
  return "<" .. tostring(t) .. ">"
end

local samples = {}
local changeCount = 0
local truncated = false
local startClock = os.clock()
local last
local haveLast = false
local first = true

while true do
  local elapsed = os.clock() - startClock
  local ok, v = pcall(fn)

  -- changed = first sample OR the value differs from the previous live value.
  -- Compare raw values (not encoded strings) so identity changes on
  -- tables/Instances are caught too. Errors are treated as changes vs a value.
  local changed
  if first then
    changed = true
  elseif not haveLast then
    changed = true
  else
    changed = (v ~= last)
  end

  -- Only record the first sample and any change, per spec, to keep output tight.
  if changed then
    if #samples >= MAX_SAMPLES then
      truncated = true
    else
      changeCount = changeCount + 1
      samples[#samples + 1] = {
        t = math.floor(elapsed * 1000 + 0.5),
        value = ok and encode(v) or ("<error> " .. encode(v)),
        changed = (not first),
        ok = ok,
      }
    end
  end

  last = v
  haveLast = true
  first = false

  if elapsed >= durationSec then break end
  if truncated then break end
  task.wait(intervalSec)
end

return {
  expression = expression,
  intervalMs = math.floor(intervalSec * 1000 + 0.5),
  durationMs = math.floor(durationSec * 1000 + 0.5),
  sampleCount = #samples,
  changeCount = changeCount,
  truncated = truncated,
  samples = samples,
}`;

    // Give the connector round-trip a buffer beyond the in-client loop duration
    // so the tool does not time out before the Luau loop finishes.
    const timeoutMs = duration + 10000;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data };
  },
});
