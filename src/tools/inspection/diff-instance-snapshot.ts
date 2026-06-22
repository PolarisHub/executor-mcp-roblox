import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

// Hard cap on how many changed-entry detail records we return per list so a
// big diff (e.g. a whole UI rebuilt) doesn't flood the AI with thousands of
// rows. The underlying counts are always exact; only the detail arrays are
// capped (and flagged via `truncated` on each list).
const MAX_LIST = 200;

export default defineTool({
  name: "diff-instance-snapshot",
  title: "Snapshot an instance subtree and diff what an action changed",
  description:
    "Answer 'what did clicking this button / firing this remote / opening this menu actually change in the game " +
    "tree?' by snapshotting an instance subtree, performing the action in-game, then diffing the before/after.\n\n" +
    "Workflow: (1) call action='snapshot' on a root (default game.Workspace) to capture a baseline; (2) do the " +
    "thing in-game (click, fire a remote, walk somewhere, wait for a wave to spawn); (3) call action='compare' " +
    "with the SAME name to see exactly which instances were ADDED, REMOVED, or CHANGED.\n\n" +
    "How it works: it walks root:GetDescendants() (capped at maxInstances) and builds a per-instance signature " +
    "from a handful of cheap properties (ClassName, Name, Parent, and whichever of Position/Transparency/Value/" +
    "Text/Visible/Anchored/Health/Enabled exist). 'changed' entries report the before and after signatures so you " +
    "can see precisely which property moved (a part teleported, a value bumped, a label retexted, a GUI shown).\n\n" +
    "State is stored CLIENT-SIDE in getgenv().__mcp_snapshots[name], so baselines persist across tool calls and " +
    "are naturally isolated per game / per session. Use distinct names to keep several independent baselines.\n\n" +
    "snapshot returns: { action='snapshot', name, root, captured, truncated }.\n" +
    "compare returns: { action='compare', name, root, counts={ added, removed, changed }, added=[paths], " +
    "removed=[paths], changed=[{ path, before, after }], truncated=bool }.\n\n" +
    "Non-mutating and fully pcall-guarded (locked/destroyed instances are skipped, never aborting the scan). " +
    "Each detail list is capped at " +
    MAX_LIST +
    " entries; the exact counts are always reported.",
  category: "Inspection",
  input: z.object({
    action: z
      .enum(["snapshot", "compare"])
      .describe(
        "'snapshot' captures a baseline signature map of the subtree under `name`. 'compare' re-walks the subtree " +
          "now and diffs it against the stored baseline of that `name`, reporting added/removed/changed instances.",
      ),
    root: z
      .string()
      .describe(
        "Luau expression for the root instance of the subtree to snapshot/diff (default 'game.Workspace'). " +
          "Examples: 'game.Workspace', 'game.Players.LocalPlayer.PlayerGui', " +
          "'game.Workspace:FindFirstChild(\"Map\")'. Evaluated as `return <root>`. Pick the smallest subtree that " +
          "contains what you expect to change — a tighter root means a faster, less noisy diff.",
      )
      .optional()
      .default("game.Workspace"),
    name: z
      .string()
      .describe(
        "Slot/name for the snapshot (default 'default'). compare diffs against the baseline stored under this same " +
          "name. Use distinct names to keep several independent before/after pairs around at once.",
      )
      .optional()
      .default("default"),
    maxInstances: z
      .number()
      .int()
      .describe(
        "Max descendants to walk per pass (default 4000). The walk stops at this many and flags `truncated`; a " +
          "truncated baseline plus a truncated compare can produce spurious added/removed near the cap, so prefer a " +
          "tighter root over a huge cap.",
      )
      .optional()
      .default(4000),
    threadContext: z.number().int().optional(),
  }),
  async execute({ action, root, name, maxInstances, threadContext }, ctx) {
    const isSnapshot = action === "snapshot";
    const cap = Math.min(Math.max(Math.floor(maxInstances), 1), 50000);

    const source = `
local result = {}

-- Build a short, cheap signature for one instance. Reads a handful of common
-- properties via pcall (any that don't exist / are locked are simply skipped),
-- joined by "|". Cheap enough to run over thousands of instances.
local function signature(inst)
  local parts = {}
  local okClass, cls = pcall(function() return inst.ClassName end)
  parts[#parts + 1] = "c=" .. (okClass and tostring(cls) or "?")
  local okName, nm = pcall(function() return inst.Name end)
  parts[#parts + 1] = "n=" .. (okName and tostring(nm) or "?")
  local okPar, par = pcall(function() local p = inst.Parent; return p and p.Name or "<nil>" end)
  parts[#parts + 1] = "p=" .. (okPar and tostring(par) or "?")

  -- Property name -> how to stringify it. Each read is independently guarded so
  -- a single locked/missing property never aborts the signature.
  local function add(label, getter)
    local ok, v = pcall(getter)
    if ok and v ~= nil then parts[#parts + 1] = label .. "=" .. tostring(v) end
  end
  add("Position", function() return inst.Position end)
  add("Transparency", function() return inst.Transparency end)
  add("Value", function() return inst.Value end)
  add("Text", function() return inst.Text end)
  add("Visible", function() return inst.Visible end)
  add("Anchored", function() return inst.Anchored end)
  add("Health", function() return inst.Health end)
  add("Enabled", function() return inst.Enabled end)

  return table.concat(parts, "|")
end

local function fullName(inst)
  local ok, n = pcall(function() return inst:GetFullName() end)
  if ok and type(n) == "string" then return n end
  return nil
end

-- Walk root:GetDescendants() into a map fullName -> signature, capped.
-- Returns map, count, truncated, err.
local function buildMap(rootInst)
  local okDesc, descendants = pcall(function() return rootInst:GetDescendants() end)
  if not okDesc or type(descendants) ~= "table" then
    return nil, 0, false, "could not enumerate descendants of root: " .. tostring(descendants)
  end
  local map = {}
  local count = 0
  local truncated = false
  for _, inst in ipairs(descendants) do
    if count >= ${cap} then
      truncated = true
      break
    end
    local fn = fullName(inst)
    if fn ~= nil then
      -- On a name collision (two instances share GetFullName), keep the first;
      -- this only loses a duplicate path, never aborts the scan.
      if map[fn] == nil then
        local okSig, sig = pcall(signature, inst)
        map[fn] = okSig and sig or "<sig-error>"
        count = count + 1
      end
    end
  end
  return map, count, truncated, nil
end

local function getStore()
  if type(getgenv) ~= "function" then return nil end
  local okEnv, env = pcall(getgenv)
  if not okEnv or type(env) ~= "table" then return nil end
  if type(env.__mcp_snapshots) ~= "table" then
    env.__mcp_snapshots = {}
  end
  return env.__mcp_snapshots
end

local function resolveRoot()
  local fn, cerr = loadstring("return " .. ${q(root)})
  if not fn then return nil, "compile error in root expression: " .. tostring(cerr) end
  local ok, val = pcall(fn)
  if not ok then return nil, "error evaluating root expression: " .. tostring(val) end
  if typeof(val) ~= "Instance" then
    return nil, "root expression did not resolve to an Instance (got " .. typeof(val) .. ")."
  end
  return val, nil
end

local function run()
  local NAME = ${q(name)}
  local store = getStore()
  if not store then
    return { error = "getgenv() is unavailable; cannot persist instance snapshots client-side." }
  end

  local rootInst, rerr = resolveRoot()
  if not rootInst then return { error = rerr } end
  local rootFull = fullName(rootInst) or ${q(root)}

  ${
    isSnapshot
      ? `
  -- SNAPSHOT: build the map and store it under NAME.
  local map, count, truncated, merr = buildMap(rootInst)
  if not map then return { error = merr } end
  store[NAME] = { map = map, t = os.clock(), root = rootFull }
  return {
    action = "snapshot",
    name = NAME,
    root = rootFull,
    captured = count,
    truncated = truncated,
  }`
      : `
  -- COMPARE: re-walk now and diff against the stored baseline.
  local base = store[NAME]
  if type(base) ~= "table" or type(base.map) ~= "table" then
    return { error = "No snapshot named '" .. NAME .. "' to compare against. Run action='snapshot' first." }
  end
  local before = base.map

  local now, count, truncated, merr = buildMap(rootInst)
  if not now then return { error = merr } end

  local added = {}
  local removed = {}
  local changed = {}
  local addedCount, removedCount, changedCount = 0, 0, 0
  local addedTrunc, removedTrunc, changedTrunc = false, false, false

  -- added (in now, not before) + changed (in both, differing signature).
  for path, sigNow in pairs(now) do
    local sigBefore = before[path]
    if sigBefore == nil then
      addedCount = addedCount + 1
      if #added < ${MAX_LIST} then added[#added + 1] = path else addedTrunc = true end
    elseif sigBefore ~= sigNow then
      changedCount = changedCount + 1
      if #changed < ${MAX_LIST} then
        changed[#changed + 1] = { path = path, before = sigBefore, after = sigNow }
      else
        changedTrunc = true
      end
    end
  end

  -- removed (in before, not now).
  for path in pairs(before) do
    if now[path] == nil then
      removedCount = removedCount + 1
      if #removed < ${MAX_LIST} then removed[#removed + 1] = path else removedTrunc = true end
    end
  end

  return {
    action = "compare",
    name = NAME,
    root = rootFull,
    baselineRoot = base.root,
    counts = { added = addedCount, removed = removedCount, changed = changedCount },
    added = added,
    removed = removed,
    changed = changed,
    nowScanned = count,
    truncated = truncated or (addedTrunc or removedTrunc or changedTrunc),
  }`
  }
end

local ok, res = pcall(run)
if ok then
  result = res
else
  result = { error = "diff-instance-snapshot failed: " .. tostring(res) }
end
return result`;

    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 45000 });
    return { data };
  },
});
