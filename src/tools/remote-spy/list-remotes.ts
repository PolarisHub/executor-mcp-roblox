import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "list-remotes",
  title: "Inventory every remote in a subtree of the DataModel",
  description:
    "Read-only inventory of every remote/bindable object in a part of the game tree. Resolves `root` (a Luau " +
    "expression, default the whole `game`), walks its :GetDescendants() pcall-guarded, and collects every instance " +
    "whose ClassName is RemoteEvent, RemoteFunction, UnreliableRemoteEvent, BindableEvent, or BindableFunction. For " +
    "each it records its full path (GetFullName), class, and name. This is the map you build BEFORE spying: use it to " +
    "discover which remotes exist and where, then feed an interesting path into get-remote-signature (to learn its " +
    "shape) or monitor-remote (to watch one remote's traffic). Complements get-remote-spy-logs, " +
    "which shows calls that have already happened; this shows the static set of remotes regardless of whether they " +
    "have fired. Scanning the entire DataModel can be large, so results are capped at `limit` (a truncated flag is " +
    "set when the cap is hit) and a per-class tally is always returned. Uses only :GetDescendants and reflection — " +
    "no special executor functions required. Returns { ok, root, total, scanned, byClass, truncated, remotes } " +
    "where remotes is a list of { path, class, name }, or { error }.",
  category: "Remote Spy",
  input: z.object({
    root: z
      .string()
      .describe(
        "Luau expression resolving to the Instance to scan under, e.g. 'game', " +
          "'game:GetService(\"ReplicatedStorage\")', or 'game.Players.LocalPlayer.PlayerGui'. Its :GetDescendants() " +
          "is walked. Evaluated as `return <root>`. Defaults to 'game' (the whole DataModel).",
      )
      .optional()
      .default("game"),
    limit: z
      .number()
      .int()
      .describe(
        "Maximum number of remote/bindable entries to return (default 400). When the subtree contains more matching " +
          "instances than this, the list is truncated to `limit` and `truncated` is set true (the byClass tally and " +
          "`total` still reflect everything that was scanned up to the cap).",
      )
      .optional()
      .default(400),
    threadContext: z.number().int().optional(),
  }),
  async execute({ root, limit, threadContext }, ctx) {
    const cap = Math.min(Math.max(Math.floor(limit ?? 400), 1), 5000);
    const source = `
${REFLECT_PRELUDE}
local rootInst, err = __eval(${q(root)})
if err then return { error = err } end
if typeof(rootInst) ~= "Instance" then return { error = "expression did not resolve to an Instance (got " .. typeof(rootInst) .. "): " .. ${q(root)} } end

local CLASSES = {
  RemoteEvent = true,
  RemoteFunction = true,
  UnreliableRemoteEvent = true,
  BindableEvent = true,
  BindableFunction = true,
}

local okDesc, descendants = pcall(function() return rootInst:GetDescendants() end)
if not okDesc or type(descendants) ~= "table" then
  return { error = "failed to enumerate descendants of root: " .. tostring(descendants) }
end

local limit = ${cap}
local remotes = {}
local byClass = { RemoteEvent = 0, RemoteFunction = 0, UnreliableRemoteEvent = 0, BindableEvent = 0, BindableFunction = 0 }
local total = 0
local scanned = 0
local truncated = false

for _, inst in descendants do
  scanned = scanned + 1
  -- ClassName read is pcall-guarded so a hostile/locked instance can never abort the walk.
  local okClass, cls = pcall(function() return inst.ClassName end)
  if okClass and CLASSES[cls] then
    total = total + 1
    byClass[cls] = (byClass[cls] or 0) + 1
    if #remotes < limit then
      local path
      local okName, full = pcall(function() return inst:GetFullName() end)
      if okName then path = full else
        local okN, nm = pcall(function() return inst.Name end)
        path = okN and nm or tostring(inst)
      end
      local name
      local okN2, nm2 = pcall(function() return inst.Name end)
      name = okN2 and nm2 or "?"
      remotes[#remotes + 1] = { path = path, class = cls, name = name }
    else
      truncated = true
    end
  end
end

return {
  ok = true,
  root = (function() local okN, n = pcall(function() return rootInst:GetFullName() end); return okN and n or ${q(root)} end)(),
  total = total,
  scanned = scanned,
  byClass = byClass,
  truncated = truncated,
  returned = #remotes,
  remotes = remotes,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 45000 });
    return { data };
  },
});
