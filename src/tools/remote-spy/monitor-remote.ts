import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "monitor-remote",
  title: "Focused single-remote spy via __namecall hook (MUTATES live state)",
  description:
    "WRITES LIVE GAME STATE. DANGER — INSTALLS A PERSISTENT METAMETHOD HOOK while running. A laser-focused remote spy " +
    "that captures the outgoing calls (FireServer / InvokeServer / FireAllClients / FireClient) made through ONE " +
    "specific remote, identified by reference. Unlike trace-remote-traffic (which logs ALL remotes) and " +
    "get-remote-spy-logs, this watches a single remote you already care about — ideal once list-remotes / " +
    "get-remote-signature have pointed you at the interesting one. It hooks game's __namecall, but inside the wrapper " +
    "it only records a call when the calling instance (`self`) is the EXACT resolved target remote (reference " +
    "equality), so the buffer stays clean even though __namecall fires for the whole game. Each captured call stores " +
    "the method, a shallow tostring-encode of up to 8 arguments, the argument count, and a timestamp.\n\n" +
    "WORKFLOW (stateful — survives across tool calls via getgenv().__mcp_monitorRemote keyed by remotePath):\n" +
    "  - action='start' (remotePath REQUIRED): resolve the remote, install the __namecall hook, begin buffering its " +
    "calls. No-op returning { alreadyRunning } if a monitor is already active for that exact path.\n" +
    "  - action='fetch': return the buffered calls (newest first, capped at `limit`) WITHOUT clearing them; poll while " +
    "you play.\n" +
    "  - action='stop': restore the original __namecall metamethod and clear the buffer. Safe to call repeatedly.\n\n" +
    "The hook ALWAYS calls through to the original metamethod and all observation is pcall-isolated, so it is " +
    "transparent — but a live metamethod hook adds per-call overhead and is a strong anticheat signal, so STOP when " +
    "done. Requires hookmetamethod, getnamecallmethod, newcclosure, and getgenv. Returns (start) { started, key, " +
    "remote } | { alreadyRunning }; (fetch) { key, remote, count, returned, calls } where each call is " +
    "{ method, args, argCount, argsTruncated, t }; (stop) { stopped, restored, captured } — or { error }.",
  category: "Remote Spy",
  mutatesState: true,
  input: z.object({
    action: z
      .enum(["start", "fetch", "stop"])
      .describe(
        "start = resolve remotePath, install the __namecall hook, and begin capturing ONLY that remote's outgoing " +
          "calls (persistent until stopped). fetch = return the captured calls (newest first) WITHOUT clearing them. " +
          "stop = restore the original __namecall metamethod and clear this remote's buffer. Use the SAME remotePath " +
          "for all three so they address the same registry entry.",
      ),
    remotePath: z
      .string()
      .describe(
        "Luau expression resolving to the single remote/bindable to watch, e.g. " +
          "'game:GetService(\"ReplicatedStorage\").Remotes.BuyItem'. Evaluated as `return <remotePath>` and must " +
          "resolve to an Instance. REQUIRED for action='start' (it is resolved and stored by reference for the " +
          "equality check). For 'fetch'/'stop' it is the registry key identifying which running monitor to act on, so " +
          "it MUST match the string used at start.",
      )
      .optional(),
    limit: z
      .number()
      .int()
      .describe(
        "fetch only: maximum number of captured calls to return, newest first (default 100, capped at the 500-entry " +
          "ring buffer). Ignored for start/stop.",
      )
      .optional()
      .default(100),
    threadContext: z.number().int().optional(),
  }),
  async execute({ action, remotePath, limit, threadContext }, ctx) {
    if (!remotePath) {
      const error =
        action === "start"
          ? "remotePath is required for action='start' (the Luau expression resolving to the remote to monitor)."
          : "remotePath is required to identify which running monitor to " +
            action +
            " (use the same expression you passed to start).";
      return { data: { error }, isError: true };
    }

    const cap = Math.min(Math.max(Math.floor(limit ?? 100), 1), 500);
    const keyExpr = q(remotePath);

    // Shared prelude: capability guard for getgenv + the registry table.
    const prelude = `
${REFLECT_PRELUDE}
if type(getgenv) ~= "function" then return { error = "getgenv is not available in this executor; cannot maintain the monitor registry." } end
local __genv = getgenv()
if type(__genv.__mcp_monitorRemote) ~= "table" then __genv.__mcp_monitorRemote = {} end
local __REG = __genv.__mcp_monitorRemote
local __KEY = ${keyExpr}
`;

    let body: string;

    if (action === "start") {
      body = `
if type(hookmetamethod) ~= "function" then return { error = "hookmetamethod is not available in this executor." } end
if type(getnamecallmethod) ~= "function" then return { error = "getnamecallmethod is not available in this executor." } end
if type(newcclosure) ~= "function" then return { error = "newcclosure is not available in this executor." } end

local existing = __REG[__KEY]
if type(existing) == "table" and existing.active then
  return { alreadyRunning = true, key = __KEY, count = #existing.log }
end

local remote, rerr = __eval(__KEY)
if rerr then return { error = rerr } end
if typeof(remote) ~= "Instance" then return { error = "expression did not resolve to an Instance (got " .. typeof(remote) .. "): " .. __KEY } end

local remoteName
local okName, full = pcall(function() return remote:GetFullName() end)
if okName then remoteName = full else remoteName = __KEY end

-- Only these methods send data; filter aggressively so non-remote namecalls are cheap.
local TRACKED = { FireServer = true, InvokeServer = true, FireAllClients = true, FireClient = true }

-- Register the entry (with the resolved remote stored by reference) BEFORE hooking
-- so the hook closure can find it immediately.
local entry = { log = {}, max = 500, orig = nil, hook = nil, active = true, target = remote, remoteName = remoteName }
__REG[__KEY] = entry

local hook = newcclosure(function(self, ...)
  local e = __REG[__KEY]
  -- Observation fully isolated; the real call always falls through below.
  pcall(function()
    if not e or not e.active then return end
    -- Reference equality: only log calls made THROUGH our exact remote.
    if self ~= e.target then return end
    local okm, m = pcall(getnamecallmethod)
    if not okm or not TRACKED[m] then return end

    local packed = table.pack(...)
    local n = packed.n or #packed
    local cap = math.min(n, 8)
    local args = {}
    for i = 1, cap do
      local oke, v = pcall(__encVal, packed[i])
      args[i] = oke and v or "?"
    end

    local log = e.log
    log[#log + 1] = {
      method = m,
      args = args,
      argCount = n,
      argsTruncated = n > cap,
      t = (type(os) == "table" and os.clock and os.clock()) or 0,
    }
    if #log > e.max then table.remove(log, 1) end
  end)

  -- Always call through to the original metamethod (read from state to survive re-hooks).
  local s = __REG[__KEY]
  local orig = s and s.orig
  if type(orig) == "function" then
    return orig(self, ...)
  end
  -- Fallback: synthesize the call so the game keeps working if we somehow lost the original.
  local okfm, fm = pcall(getnamecallmethod)
  if okfm and type(fm) == "string" then
    return self[fm](self, ...)
  end
  return
end)

local okHook, original = pcall(hookmetamethod, game, "__namecall", hook)
if not okHook then
  __REG[__KEY] = nil
  return { error = "hookmetamethod failed: " .. tostring(original) }
end
if type(original) ~= "function" then
  __REG[__KEY] = nil
  return { error = "hookmetamethod did not return the original metamethod; refusing to install a non-restorable hook." }
end

entry.orig = original
entry.hook = hook
return { started = true, key = __KEY, remote = remoteName, max = entry.max }
`;
    } else if (action === "fetch") {
      body = `
local entry = __REG[__KEY]
if type(entry) ~= "table" then
  return { notRunning = true, key = __KEY, count = 0, returned = 0, calls = {} }
end

local log = entry.log or {}
local total = #log
local limit = ${cap}
local calls = {}
local taken = 0
-- Newest -> oldest, capped at limit.
for i = total, 1, -1 do
  if taken >= limit then break end
  taken = taken + 1
  calls[taken] = log[i]
end

return {
  key = __KEY,
  remote = entry.remoteName,
  active = entry.active == true,
  count = total,
  returned = taken,
  max = entry.max,
  truncated = taken < total,
  calls = calls,
}
`;
    } else {
      // stop
      body = `
local entry = __REG[__KEY]
if type(entry) ~= "table" then
  return { notRunning = true, key = __KEY }
end

local restored = false
local restoreErr = nil
local orig = entry.orig
if type(orig) == "function" then
  if type(hookmetamethod) == "function" then
    local ok, err = pcall(hookmetamethod, game, "__namecall", orig)
    if ok then restored = true else restoreErr = tostring(err) end
  end
  if (not restored) and type(restorefunction) == "function" and type(entry.hook) == "function" then
    local ok2, err2 = pcall(restorefunction, entry.hook)
    if ok2 then restored = true else restoreErr = (restoreErr and (restoreErr .. "; ") or "") .. tostring(err2) end
  end
else
  restoreErr = "no stored original to restore"
end

local captured = entry.log and #entry.log or 0
entry.active = false
__REG[__KEY] = nil

return {
  stopped = true,
  key = __KEY,
  remote = entry.remoteName,
  restored = restored,
  captured = captured,
  warning = restored and nil or ("Could not confirm restoration of the original __namecall" .. (restoreErr and (": " .. restoreErr) or "") .. ". The hook may still be active."),
}
`;
    }

    const source = prelude + body;
    const timeoutMs = action === "fetch" ? 20000 : 15000;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data };
  },
});
