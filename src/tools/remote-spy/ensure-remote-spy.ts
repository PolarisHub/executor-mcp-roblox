import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

/**
 * Self-contained remote-spy installer.
 *
 * The legacy ensure-remote-spy was a thin wrapper over a connector-side Cobalt
 * message type that does not exist in the clean-slate protocol, so this is a
 * full reimplementation as a get-data-by-code tool. It installs (idempotently) a
 * single __namecall hook on `game` that logs every RemoteEvent/RemoteFunction
 * FireServer/InvokeServer call into a capped ring buffer living in
 * getgenv().__mcp_remoteSpy.logs. The same getgenv() state table holds a
 * block-set (calls dropped, not called through) and an ignore-set (calls passed
 * through but not logged), maintained by block-remote / ignore-remote.
 *
 * The hook:
 *   - reads its state + original from getgenv() each call so it survives a
 *     replaced state table and always calls through to the original last,
 *   - pcall-isolates ALL observation so a locked/odd object can never break
 *     gameplay, and always calls through to the original metamethod EXCEPT for
 *     blocked remotes (which it deliberately drops),
 *   - type-guards hookmetamethod / getnamecallmethod / newcclosure / getgenv and
 *     reports a clean { error } when the executor lacks them.
 */
function buildSource(max: number): string {
  return `
if type(getgenv) ~= "function" then return { error = "getgenv not available" } end
if type(hookmetamethod) ~= "function" then return { error = "hookmetamethod not available" } end
if type(getnamecallmethod) ~= "function" then return { error = "getnamecallmethod not available" } end
if type(newcclosure) ~= "function" then return { error = "newcclosure not available" } end

local genv = getgenv()
local st = genv.__mcp_remoteSpy
if type(st) ~= "table" then
  st = {}
  genv.__mcp_remoteSpy = st
end
-- (Re)initialise the parts that must exist; never clobber an existing log/sets.
if type(st.logs) ~= "table" then st.logs = {} end
if type(st.blocked) ~= "table" then st.blocked = {} end
if type(st.ignored) ~= "table" then st.ignored = {} end
st.max = ${max}

if st.active and type(st.hook) == "function" then
  return { installed = false, alreadyActive = true, count = #st.logs, max = st.max }
end

-- Only these methods send data; __namecall fires for nearly every method call,
-- so filter aggressively and do as little work as possible otherwise.
local TRACKED = { FireServer = true, InvokeServer = true }

-- A shallow, JSON-friendly encode of a single argument (one level deep for
-- tables). Always pcall-guarded by the caller.
local function __encArg(v)
  local t = typeof(v)
  if t == "nil" or t == "boolean" or t == "number" or t == "string" then return v end
  if t == "Instance" then
    local ok, n = pcall(function() return v:GetFullName() end)
    return { __type = "Instance", path = ok and n or tostring(v) }
  end
  if t == "EnumItem" then return { __type = "EnumItem", value = tostring(v) } end
  local ok, s = pcall(tostring, v)
  return { __type = t, value = ok and s or "<unprintable>" }
end

st.active = true

local hook = newcclosure(function(self, ...)
  local s = genv.__mcp_remoteSpy
  local blocked = false
  -- Observation + block decision fully isolated; the real call falls through
  -- below unless this remote is explicitly blocked.
  pcall(function()
    if not s or not s.active then return end
    local okm, m = pcall(getnamecallmethod)
    if not okm or not TRACKED[m] then return end

    local path
    local okn, full = pcall(function() return self:GetFullName() end)
    path = okn and full or tostring(self)

    if s.blocked and s.blocked[path] then blocked = true end

    -- ignore-set: still call through (handled below) but do NOT log it.
    if s.ignored and s.ignored[path] then return end

    local packed = table.pack(...)
    local n = packed.n or #packed
    local cap = math.min(n, 8)
    local args = {}
    for i = 1, cap do
      local oke, v = pcall(__encArg, packed[i])
      args[i] = oke and v or "?"
    end

    local class
    local okc, c = pcall(function() return self.ClassName end)
    class = okc and c or "?"

    local logs = s.logs
    logs[#logs + 1] = {
      method = m,
      remote = path,
      class = class,
      args = args,
      argCount = n,
      argsTruncated = n > cap,
      blocked = blocked,
      t = (type(os) == "table" and os.clock and os.clock()) or 0,
    }
    if #logs > (s.max or ${max}) then table.remove(logs, 1) end
  end)

  -- Blocked remotes are dropped: do NOT call through (the game never sends it).
  if blocked then return end

  -- Always call through to the original metamethod (read from state to survive
  -- re-hooks / a replaced state table).
  local s2 = genv.__mcp_remoteSpy
  local orig = s2 and s2.orig
  if type(orig) == "function" then
    return orig(self, ...)
  end
  -- Fallback: synthesize the call so the game keeps working if we lost the original.
  local okfm, fm = pcall(getnamecallmethod)
  if okfm and type(fm) == "string" then
    return self[fm](self, ...)
  end
  return
end)

local okHook, original = pcall(hookmetamethod, game, "__namecall", hook)
if not okHook then
  st.active = false
  return { error = "hookmetamethod failed: " .. tostring(original) }
end
if type(original) ~= "function" then
  st.active = false
  return { error = "hookmetamethod did not return the original metamethod; refusing to install a non-restorable hook" }
end

st.orig = original
st.hook = hook
return { installed = true, alreadyActive = false, count = #st.logs, max = st.max }
`;
}

export default defineTool({
  name: "ensure-remote-spy",
  title: "Install the global remote spy (MUTATES live state via __namecall hook)",
  description:
    "WRITES LIVE GAME STATE. DANGER — INSTALLS A PERSISTENT METAMETHOD HOOK. Idempotently installs a single __namecall " +
    "hook on `game` that logs every RemoteEvent/RemoteFunction FireServer/InvokeServer call the client makes (the " +
    "method, the remote's full path, its ClassName, a shallow-encoded snapshot of up to 8 arguments, and a timestamp) " +
    "into a capped ring buffer in getgenv().__mcp_remoteSpy.logs. The same state table holds a block-set (managed by " +
    "block-remote — matching calls are DROPPED, not sent) and an ignore-set (managed by ignore-remote — matching calls " +
    "still go through but are not logged). Safe to call repeatedly: a second call is a no-op returning " +
    "{ installed=false, alreadyActive=true } and never clears the existing logs or sets. Read the buffer with " +
    "get-remote-spy-logs and empty it with clear-remote-spy-logs. The hook always calls through to the original " +
    "metamethod (except for blocked remotes) and all observation is pcall-isolated, so it is transparent — but a live " +
    "metamethod hook adds per-call overhead to EVERY method call and is a strong anticheat signal. Requires getgenv, " +
    "hookmetamethod, getnamecallmethod, and newcclosure. Returns { installed, alreadyActive, count, max } or { error }.",
  category: "Remote Spy",
  mutatesState: true,
  input: z.object({
    max: z
      .number()
      .int()
      .describe(
        "Capacity of the log ring buffer (default 500, clamped to 10..5000). When the buffer is full the oldest " +
          "entries are dropped. A repeat call updates this cap without clearing existing logs.",
      )
      .optional()
      .default(500),
    threadContext: z.number().int().optional(),
  }),
  async execute({ max, threadContext }, ctx) {
    const cap = Math.min(Math.max(Math.floor(max ?? 500), 10), 5000);
    const source = buildSource(cap);
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 15000 });
    return { data };
  },
});
