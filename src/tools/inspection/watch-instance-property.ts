import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "watch-instance-property",
  title: "Watch a property change over time",
  description:
    "Poll a single property of an instance at a fixed interval for a bounded duration and record every sampled value plus whether it changed since the previous sample. " +
    "Use this to debug timing/animation/state issues — e.g. confirm a Frame's Visible actually toggles when you click, watch a Humanoid's Health drop, or see whether a Value object updates. " +
    "Returns { Path, Property, Samples = [{ t, value, changed }], changeCount }. " +
    "The call blocks for roughly `durationMs` while sampling, so it is inherently synchronous; keep durations short.",
  category: "Inspection",
  input: z.object({
    instancePath: z
      .string()
      .describe(
        "Dotted path to the instance to watch, starting at 'game' (e.g. 'game.Players.LocalPlayer.PlayerGui.HUD.HealthBar').",
      ),
    propertyName: z
      .string()
      .describe(
        "Name of the single property to sample each interval (e.g. 'Visible', 'Text', 'Value', 'Health', 'Position').",
      ),
    checkIntervalMs: z
      .number()
      .int()
      .describe(
        "Polling interval in milliseconds (default: 100, min: 10, max: 5000). Smaller catches fast transitions but produces more samples.",
      )
      .optional()
      .default(100),
    durationMs: z
      .number()
      .int()
      .describe(
        "Total time to watch in milliseconds (default: 3000, max: 30000). The tool blocks for about this long; perform the triggering action (click/type) shortly before or during the watch.",
      )
      .optional()
      .default(3000),
    threadContext: z.number().int().optional(),
  }),
  async execute({ instancePath, propertyName, checkIntervalMs, durationMs, threadContext }, ctx) {
    const interval = Math.max(10, Math.min(5000, Math.floor(checkIntervalMs)));
    const duration = Math.max(interval, Math.min(30000, Math.floor(durationMs)));

    const source = `
local path = ${q(instancePath)}
local propName = ${q(propertyName)}
local intervalSec = ${interval} / 1000
local durationSec = ${duration} / 1000

local function resolve(p)
  local segments = {}
  for seg in string.gmatch(p, "[^%.]+") do table.insert(segments, seg) end
  if #segments == 0 then return nil, "Empty path" end
  local first = segments[1]
  local current
  if first == "game" or first == "Game" then
    current = game
  elseif first == "workspace" or first == "Workspace" then
    current = workspace
  else
    local ok, svc = pcall(function() return game:GetService(first) end)
    if ok and svc then
      current = svc
    else
      local ok2, child = pcall(function() return game:FindFirstChild(first) end)
      if ok2 and child then current = child end
    end
  end
  if not current then return nil, "Could not resolve root '" .. tostring(first) .. "'" end
  for i = 2, #segments do
    local name = segments[i]
    local ok, nxt = pcall(function() return (current :: any)[name] end)
    if not ok or nxt == nil then
      local ok2, child = pcall(function() return current:FindFirstChild(name) end)
      if ok2 and child then nxt = child else
        return nil, "Path segment '" .. tostring(name) .. "' not found"
      end
    end
    current = nxt
  end
  return current
end

local inst, err = resolve(path)
if not inst then return { error = err or "Failed to resolve path", Path = path } end
if typeof(inst) ~= "Instance" then
  return { error = "Resolved value is not an Instance (got " .. typeof(inst) .. ")", Path = path }
end

local function encode(v)
  local t = typeof(v)
  if t == "Instance" then
    local ok, full = pcall(function() return v:GetFullName() end)
    return ok and full or tostring(v)
  end
  local ok, s = pcall(function() return tostring(v) end)
  return ok and s or "<unprintable>"
end

local function readProp()
  local ok, value = pcall(function() return (inst :: any)[propName] end)
  if not ok then return false, nil end
  return true, value
end

-- Validate the property is readable once up front.
local okInit = readProp()
if not okInit then
  return { error = "Property '" .. propName .. "' is not readable on " .. inst.ClassName, Path = path, Property = propName }
end

local samples = {}
local changeCount = 0
local startClock = os.clock()
local lastEncoded = nil
local first = true

while true do
  local elapsed = os.clock() - startClock
  local ok, value = readProp()
  local encoded = ok and encode(value) or "<read-failed>"
  local changed = (not first) and (encoded ~= lastEncoded)
  if changed then changeCount = changeCount + 1 end
  table.insert(samples, {
    t = math.floor(elapsed * 1000 + 0.5),
    value = encoded,
    changed = changed,
  })
  lastEncoded = encoded
  first = false
  if elapsed >= durationSec then break end
  task.wait(intervalSec)
end

return {
  Path = path,
  Property = propName,
  ClassName = inst.ClassName,
  DurationMs = math.floor(durationSec * 1000 + 0.5),
  IntervalMs = math.floor(intervalSec * 1000 + 0.5),
  SampleCount = #samples,
  changeCount = changeCount,
  Samples = samples,
}`;

    // Give the connector round-trip a buffer beyond the in-game loop duration
    // so the tool does not time out before the Luau loop finishes.
    const timeoutMs = duration + 10000;

    const data = await ctx.runLuau(source, {
      timeoutMs,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data };
  },
});
