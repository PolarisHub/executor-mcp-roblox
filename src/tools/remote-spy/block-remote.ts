import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "block-remote",
  title: "Block a remote so the spy drops its calls (MUTATES live state)",
  description:
    "WRITES LIVE GAME STATE. DANGER — Adds a remote to getgenv().__mcp_remoteSpy.blocked so the installed remote-spy " +
    "hook DROPS every matching FireServer/InvokeServer call (it does NOT call through to the original, so the game " +
    "never sends that request). Install the spy first with ensure-remote-spy. `remotePath` is a Luau expression " +
    "resolved to an Instance; the remote is keyed by its GetFullName() so it matches exactly what the hook logs and " +
    "compares. The legacy block-remote was a Cobalt connector wrapper; this maintains the self-contained getgenv " +
    "block-set instead. Blocking is per-path and persists until you remove it (re-install / clear state). Blocked " +
    "calls still appear in get-remote-spy-logs with blocked=true. Returns { blocked, remote } where `remote` is the " +
    "resolved full path, or { error } if the spy is not installed or the path does not resolve to an Instance.",
  category: "Remote Spy",
  mutatesState: true,
  input: z.object({
    remotePath: z
      .string()
      .describe(
        "Luau expression resolving to the remote whose calls should be dropped, e.g. " +
          "'game:GetService(\"ReplicatedStorage\").Remotes.BuyItem'. Evaluated as `return <remotePath>` and must " +
          "resolve to an Instance; it is keyed by GetFullName() so it matches the path the spy hook records.",
      ),
    threadContext: z.number().int().optional(),
  }),
  async execute({ remotePath, threadContext }, ctx) {
    const source = `
${REFLECT_PRELUDE}
if type(getgenv) ~= "function" then return { error = "getgenv not available" } end
local genv = getgenv()
local st = genv.__mcp_remoteSpy
if type(st) ~= "table" then return { error = "remote spy is not installed; call ensure-remote-spy first." } end
if type(st.blocked) ~= "table" then st.blocked = {} end

local remote, err = __eval(${q(remotePath)})
if err then return { error = err } end
if typeof(remote) ~= "Instance" then return { error = "expression did not resolve to an Instance (got " .. typeof(remote) .. "): " .. ${q(remotePath)} } end

local path
local okName, full = pcall(function() return remote:GetFullName() end)
path = okName and full or ${q(remotePath)}

st.blocked[path] = true
return { blocked = true, remote = path }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 15000 });
    return { data };
  },
});
