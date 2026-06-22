import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

/**
 * Luau executed for action="start".
 *
 * Installs a single __namecall hook on `game` that records every outgoing
 * remote call (FireServer / InvokeServer / FireAllClients / FireClient) into a
 * ring buffer in getgenv().__mcp_remoteTrace.log. The hook:
 *   - is wrapped in newcclosure so it looks like a native C closure,
 *   - reads its own state + original from getgenv() each call so it stays
 *     correct even if the table is replaced, and ALWAYS calls through to the
 *     original metamethod last (transparent passthrough),
 *   - pcall-guards every observation (getnamecallmethod, tostring of args,
 *     self:GetFullName()) so a locked/odd object can never break gameplay,
 *   - caps captured args at 8 and the buffer at `max` (drops oldest).
 */
const START_LUAU = `
if type(hookmetamethod) ~= "function" then return { error = "hookmetamethod not available" } end
if type(getnamecallmethod) ~= "function" then return { error = "getnamecallmethod not available" } end
if type(newcclosure) ~= "function" then return { error = "newcclosure not available" } end
if type(getgenv) ~= "function" then return { error = "getgenv not available" } end

local genv = getgenv()
if type(genv.__mcp_remoteTrace) == "table" then
  return { alreadyRunning = true, count = #genv.__mcp_remoteTrace.log }
end

-- Methods that send data to the server/other clients. __namecall fires for the
-- huge majority of method calls in the game, so we filter aggressively and do
-- as little work as possible for non-remote calls.
local TRACKED = {
  FireServer = true,
  InvokeServer = true,
  FireAllClients = true,
  FireClient = true,
}

genv.__mcp_remoteTrace = { log = {}, max = 500, orig = nil }

local hook = newcclosure(function(self, ...)
  local st = genv.__mcp_remoteTrace
  -- Observation is fully isolated in a pcall so it can never affect the real
  -- call, then we ALWAYS fall through to the original metamethod.
  pcall(function()
    if not st then return end
    local okm, m = pcall(getnamecallmethod)
    if not okm or not TRACKED[m] then return end

    local packed = table.pack(...)
    local n = packed.n or #packed
    local args = {}
    local cap = math.min(n, 8)
    for i = 1, cap do
      local okv, v = pcall(tostring, packed[i])
      args[i] = okv and v or "?"
    end

    local okn, rn = pcall(function() return self:GetFullName() end)
    local entry = {
      remote = okn and rn or tostring(self),
      method = m,
      args = args,
      argCount = n,
      argsTruncated = n > cap,
      t = os.clock(),
    }

    local log = st.log
    log[#log + 1] = entry
    if #log > st.max then table.remove(log, 1) end
  end)

  -- Call through to the captured original metamethod. Read it from state so a
  -- later re-hook can't strand us on a stale upvalue.
  local s = genv.__mcp_remoteTrace
  local orig = s and s.orig
  if type(orig) == "function" then
    return orig(self, ...)
  end
  -- Fallback: synthesize the call if (somehow) we lost the original, so the
  -- game keeps working rather than silently dropping the call. Re-resolve the
  -- namecall method here since the one captured above is scoped to the pcall.
  local okfm, fm = pcall(getnamecallmethod)
  if okfm and type(fm) == "string" then
    return self[fm](self, ...)
  end
  -- Last resort: we cannot determine the method; return nothing.
  return
end)

local okHook, original = pcall(hookmetamethod, game, "__namecall", hook)
if not okHook then
  genv.__mcp_remoteTrace = nil
  return { error = "hookmetamethod failed: " .. tostring(original) }
end
if type(original) ~= "function" then
  -- Best-effort cleanup: we have no original to restore, so refuse to leave a
  -- non-restorable hook installed.
  genv.__mcp_remoteTrace = nil
  return { error = "hookmetamethod did not return the original metamethod; refusing to install a non-restorable hook" }
end

genv.__mcp_remoteTrace.orig = original
genv.__mcp_remoteTrace.hook = hook
return { started = true, max = genv.__mcp_remoteTrace.max }
`;

/**
 * Luau executed for action="stop". Restores the original __namecall (via
 * re-hooking with the stored original, falling back to restorefunction) and
 * clears the trace state so a subsequent start can run cleanly.
 */
const STOP_LUAU = `
if type(getgenv) ~= "function" then return { error = "getgenv not available" } end
local genv = getgenv()
local st = genv.__mcp_remoteTrace
if type(st) ~= "table" then return { notRunning = true } end

local orig = st.orig
local restored = false
local restoreErr = nil
if type(orig) == "function" then
  if type(hookmetamethod) == "function" then
    local ok, err = pcall(hookmetamethod, game, "__namecall", orig)
    if ok then restored = true else restoreErr = tostring(err) end
  end
  if (not restored) and type(restorefunction) == "function" and type(st.hook) == "function" then
    local ok2, err2 = pcall(restorefunction, st.hook)
    if ok2 then restored = true else restoreErr = (restoreErr and (restoreErr .. "; ") or "") .. tostring(err2) end
  end
else
  restoreErr = "no stored original to restore"
end

local captured = #st.log
genv.__mcp_remoteTrace = nil
return { stopped = true, restored = restored, restoreError = restoreErr, captured = captured }
`;

/**
 * Luau executed for action="fetch". Returns up to `limit` most-recent entries,
 * newest first, without mutating the buffer (so fetch is repeatable).
 */
function fetchLuau(limit: number): string {
  return `
if type(getgenv) ~= "function" then return { error = "getgenv not available" } end
local genv = getgenv()
local st = genv.__mcp_remoteTrace
if type(st) ~= "table" then return { notRunning = true, count = 0, entries = {} } end

local log = st.log or {}
local total = #log
local limit = ${limit}
local entries = {}
-- Walk newest -> oldest, capped at limit.
local taken = 0
for i = total, 1, -1 do
  if taken >= limit then break end
  taken = taken + 1
  entries[taken] = log[i]
end
return { count = total, returned = taken, max = st.max, entries = entries }
`;
}

export default defineTool({
  name: "trace-remote-traffic",
  title: "Trace outgoing remote calls live (MUTATES live state via __namecall hook)",
  description:
    "WRITES LIVE GAME STATE. DANGER — PERSISTENT METAMETHOD HOOK. Live-captures the remote traffic the CLIENT SENDS to " +
    "the server by hooking game's __namecall and recording every FireServer / InvokeServer / FireAllClients / FireClient " +
    "call (the remote's full path, the method, and a tostring of up to 8 arguments) into a 500-entry ring buffer. This " +
    "is the single best way to reverse a game's network protocol: see exactly which RemoteEvents/RemoteFunctions the " +
    "client uses and what payloads it sends as you play. " +
    "Because it hooks __namecall — which fires for essentially every method call in the game — the hook stays active " +
    "until you stop it and adds overhead to ALL method calls; a busy game generates a lot of traffic, and a live " +
    "metamethod hook is a strong anti-cheat signal. The capture work is fully pcall-isolated and the hook always calls " +
    "through to the original, so it is transparent, but you SHOULD stop it when done. " +
    "Workflow: action='start' installs the hook (no-op returning {alreadyRunning} if it is already running); " +
    "action='fetch' returns the newest entries without clearing the buffer (call repeatedly to poll); " +
    "action='stop' restores the original __namecall and clears state. State lives in getgenv().__mcp_remoteTrace and " +
    "persists across tool calls. Requires hookmetamethod, getnamecallmethod, newcclosure, and getgenv. " +
    "Returns (start) { started, max } | { alreadyRunning }; (fetch) { count, returned, entries } where each entry is " +
    "{ remote, method, args, argCount, argsTruncated, t }; (stop) { stopped, restored, captured } — or { error }.",
  category: "Remote Spy",
  mutatesState: true,
  input: z.object({
    action: z
      .enum(["start", "fetch", "stop"])
      .describe(
        "start = install the __namecall hook and begin capturing outgoing remote calls (persistent until stopped). " +
          "fetch = read the captured entries (newest first) WITHOUT clearing them; poll this while you play. " +
          "stop = restore the original __namecall metamethod and clear all captured state.",
      ),
    limit: z
      .number()
      .int()
      .describe(
        "fetch only: maximum number of entries to return, newest first (default 100, capped at the 500-entry buffer).",
      )
      .optional()
      .default(100),
    threadContext: z.number().int().optional(),
  }),
  async execute({ action, limit, threadContext }, ctx) {
    let luau: string;
    let timeoutMs = 15000;

    if (action === "start") {
      luau = START_LUAU;
    } else if (action === "stop") {
      luau = STOP_LUAU;
    } else {
      const lim = Math.min(Math.max(Math.floor(limit ?? 100), 1), 500);
      luau = fetchLuau(lim);
      timeoutMs = 20000;
    }

    const data = await ctx.runLuau(luau, { threadContext, timeoutMs });
    return { data };
  },
});
