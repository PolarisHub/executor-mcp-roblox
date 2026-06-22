import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "ignore-remote",
  title: "Ignore a remote so the spy stops logging it",
  description:
    "Adds a remote to getgenv().__mcp_remoteSpy.ignored so the installed remote-spy hook STILL calls it through " +
    "(the game behaves normally) but does NOT log its FireServer/InvokeServer calls. Use it to silence a noisy, " +
    "uninteresting remote (e.g. a heartbeat/replication chatterbox) so get-remote-spy-logs stays readable. This is the " +
    "opposite of block-remote: ignore = pass through but don't record; block = drop entirely. Install the spy first " +
    "with ensure-remote-spy. `remotePath` is a Luau expression resolved to an Instance and keyed by GetFullName() so " +
    "it matches the path the hook compares. The legacy ignore-remote was a Cobalt connector wrapper; this maintains " +
    "the self-contained getgenv ignore-set instead. Returns { ignored, remote } where `remote` is the resolved full " +
    "path, or { error } if the spy is not installed or the path does not resolve to an Instance.",
  category: "Remote Spy",
  input: z.object({
    remotePath: z
      .string()
      .describe(
        "Luau expression resolving to the remote whose calls should be passed through but not logged, e.g. " +
          "'game:GetService(\"ReplicatedStorage\").Remotes.Heartbeat'. Evaluated as `return <remotePath>` and must " +
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
if type(st.ignored) ~= "table" then st.ignored = {} end

local remote, err = __eval(${q(remotePath)})
if err then return { error = err } end
if typeof(remote) ~= "Instance" then return { error = "expression did not resolve to an Instance (got " .. typeof(remote) .. "): " .. ${q(remotePath)} } end

local path
local okName, full = pcall(function() return remote:GetFullName() end)
path = okName and full or ${q(remotePath)}

st.ignored[path] = true
return { ignored = true, remote = path }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 15000 });
    return { data };
  },
});
