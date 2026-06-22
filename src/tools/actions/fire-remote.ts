import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { buildValueExpr, q, REFLECT_PRELUDE } from "../_shared/reflection.js";

const valueArgSchema = z
  .object({
    kind: z
      .enum(["string", "number", "boolean", "nil", "raw"])
      .describe(
        "How to interpret `value`. 'string'/'number'/'boolean' pass that literal scalar. 'nil' passes nil (ignores " +
          "`value`). 'raw' treats `value` as a Luau expression — use for non-primitive arguments (Vector3, Color3, " +
          "Enum, Instance references, tables built via a constructor, etc.).",
      ),
    value: z
      .union([z.string(), z.number(), z.boolean()])
      .describe(
        "The literal value (for string/number/boolean) or, when kind='raw', a Luau expression string such as " +
          "'Vector3.new(0,50,0)', 'game.Workspace.Part', or '{ amount = 5 }'. Omit entirely when kind='nil'.",
      )
      .optional(),
  })
  .describe("A single remote argument, expressed as a typed value.");

export default defineTool({
  name: "fire-remote",
  title: "Fire a RemoteEvent / invoke a RemoteFunction / Bindable",
  description:
    "ACTS ON LIVE STATE — CAN REACH THE SERVER. Resolve a Luau expression to a remote object " +
    "(RemoteEvent / UnreliableRemoteEvent / RemoteFunction / BindableEvent / BindableFunction) and call it with the " +
    "chosen mode and arguments. Modes: FireServer / InvokeServer (RemoteEvent / RemoteFunction → travel to the " +
    "SERVER), FireAllClients / FireClient (server→client, only valid from the server side), Fire (BindableEvent → " +
    "local listeners), and Invoke (BindableFunction → local handler, returns a value). InvokeServer and Invoke " +
    "return the call's return values. The call is pcall-guarded. WARNING: FireServer, InvokeServer and FireClient " +
    "cross the network boundary and trigger REAL server-side / other-client logic (granting items, taking damage, " +
    "purchases, etc.) — only use this to test a game you own/control, never to affect other players. Returns " +
    "{ Remote, Mode, ok, ReturnValues? } or { error }.",
  category: "Actions",
  mutatesState: true,
  input: z.object({
    remotePath: z
      .string()
      .describe(
        "Luau expression resolving to the remote, e.g. " +
          "'game:GetService(\"ReplicatedStorage\").Remotes.BuyItem', " +
          "'game.ReplicatedStorage.Events.Damage', or 'getRemote()'. Evaluated as `return <remotePath>`. Must " +
          "resolve to a RemoteEvent, UnreliableRemoteEvent, RemoteFunction, BindableEvent or BindableFunction.",
      ),
    mode: z
      .enum(["FireServer", "InvokeServer", "FireAllClients", "FireClient", "Fire"])
      .describe(
        "Which method to call on the remote — must match the object's class. 'FireServer' (RemoteEvent / " +
          "UnreliableRemoteEvent → server, no return). 'InvokeServer' (RemoteFunction → server, RETURNS the " +
          "server's return values). 'FireAllClients' / 'FireClient' (RemoteEvent server→client; only valid when " +
          "this code runs on the server). 'Fire' (BindableEvent → local listeners, same Lua VM). Note: a " +
          "BindableFunction's Invoke method is not exposed here — this tool targets remotes plus BindableEvent:Fire.",
      ),
    args: z
      .array(valueArgSchema)
      .describe(
        "Ordered list of arguments to send. For FireClient the FIRST argument must be the target Player " +
          "(kind='raw', e.g. 'game.Players.SomePlayer'). Omit or pass [] for no arguments.",
      )
      .optional(),
    threadContext: z.number().int().optional(),
  }),
  async execute({ remotePath, mode, args, threadContext }, ctx) {
    const argExprs = (args ?? []).map(buildValueExpr);
    const argList = argExprs.join(", ");
    const returnsValues = mode === "InvokeServer";
    const source = `
${REFLECT_PRELUDE}
local remote, err = __eval(${q(remotePath)})
if err then return { error = err } end
if typeof(remote) ~= "Instance" then return { error = "expression did not resolve to a remote Instance (got " .. typeof(remote) .. "): " .. ${q(remotePath)} } end

local cls = remote.ClassName
local valid = {
  RemoteEvent = true,
  UnreliableRemoteEvent = true,
  RemoteFunction = true,
  BindableEvent = true,
  BindableFunction = true,
}
if not valid[cls] then return { error = "target is a " .. cls .. ", not a remote/bindable object." } end

local mode = ${q(mode)}
local fn = remote[mode]
if type(fn) ~= "function" then return { error = "'" .. mode .. "' is not available on a " .. cls .. "." } end

local path = ${q(remotePath)}
local okName, full = pcall(function() return remote:GetFullName() end)
if okName then path = full end

local results = table.pack(pcall(function() return remote[mode](remote${argList ? ", " + argList : ""}) end))
local okCall = results[1]
if not okCall then return { error = "'" .. mode .. "' raised an error: " .. tostring(results[2]) } end

local out = {
  Remote = path,
  Mode = mode,
  ClassName = cls,
  ok = true,
}

if ${returnsValues ? "true" : "false"} then
  local returns = {}
  for i = 2, results.n do returns[#returns + 1] = __encVal(results[i]) end
  out.ReturnValues = returns
end

return out
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
