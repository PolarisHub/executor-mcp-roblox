import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "list-instance-signals",
  title: "List instance signals",
  description:
    "Enumerate the RBXScriptSignal members (events) of a Roblox Instance and report how many connections each has. " +
    "Connection counts require an executor exposing getconnections(signal); if it is unavailable the signals are still listed " +
    "but ConnectionCount is reported as null with a note. Returns { Instance, GetConnectionsAvailable, Signals: [{ SignalName, ConnectionCount, Note? }] } " +
    "or { error } when the instance cannot be resolved.",
  category: "Inspection",
  input: z.object({
    instancePath: z
      .string()
      .describe(
        "Lua expression resolving to the target Instance, e.g. 'game.Players.LocalPlayer' or 'game.Workspace.Part'. Evaluated as `return <instancePath>`.",
      ),
    threadContext: z.number().int().optional(),
  }),
  async execute({ instancePath, threadContext }, ctx) {
    const source = `
local okInst, inst = pcall(function() return (loadstring("return " .. ${q(instancePath)}))() end)
if not okInst or typeof(inst) ~= "Instance" then
  return { error = "instancePath did not resolve to an Instance: " .. tostring(${q(instancePath)}) }
end

local getconnectionsFn = getconnections
local hasGetConnections = type(getconnectionsFn) == "function"

local signals = {}
local seen = {}

-- RBXScriptSignal members are not enumerable via pairs on Instances, so probe known + reflected names.
-- Use a property-name probe: attempt to read each candidate and check its typeof.
local function probe(name)
  if seen[name] then return end
  local okGet, value = pcall(function() return inst[name] end)
  if okGet and typeof(value) == "RBXScriptSignal" then
    seen[name] = true
    local count = nil
    local note = nil
    if hasGetConnections then
      local okC, conns = pcall(getconnectionsFn, value)
      if okC and type(conns) == "table" then
        count = #conns
      else
        note = "getconnections failed for this signal: " .. tostring(conns)
      end
    else
      note = "getconnections unavailable in this executor"
    end
    signals[#signals + 1] = { SignalName = name, ConnectionCount = count, Note = note }
  end
end

-- Discover candidate member names via getproperties / API dump if available, else fall back to common signals.
local discovered = false
if type(getproperties) == "function" then
  local okP, props = pcall(getproperties, inst)
  if okP and type(props) == "table" then
    discovered = true
    for _, name in ipairs(props) do probe(tostring(name)) end
  end
end

-- Reflect over the instance's class members through a pcall loop on common + discovered names.
local commonSignals = {
  "Changed","ChildAdded","ChildRemoved","DescendantAdded","DescendantRemoving","AncestryChanged","Destroying",
  "AttributeChanged","Touched","TouchEnded","Activated","Deactivated","MouseButton1Click","MouseButton2Click",
  "MouseButton1Down","MouseButton1Up","MouseButton2Down","MouseButton2Up","MouseEnter","MouseLeave","MouseMoved",
  "InputBegan","InputChanged","InputEnded","Triggered","Died","Running","Jumping","Climbing","Seated","StateChanged",
  "HealthChanged","CharacterAdded","CharacterRemoving","PlayerAdded","PlayerRemoving","OnClientEvent","OnServerEvent",
  "Heartbeat","Stepped","RenderStepped","Completed","Paused","Resumed","Stopped","Play","Loaded","Ended",
  "FocusLost","FocusGained","SelectionChanged","Equipped","Unequipped","ProximityPromptShown","PromptShown",
}
for _, name in ipairs(commonSignals) do probe(name) end

-- Attempt to enumerate attribute-change and property-change signals are dynamic; covered above where applicable.

return {
  Instance = inst:GetFullName(),
  ClassName = inst.ClassName,
  GetConnectionsAvailable = hasGetConnections,
  DiscoveredViaReflection = discovered,
  SignalCount = #signals,
  Signals = signals,
}
`;

    const data = await ctx.runLuau(source, {
      timeoutMs: 20000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data };
  },
});
