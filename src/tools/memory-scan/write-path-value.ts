import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { buildValueExpr, q, REFLECT_PRELUDE, valueArgSchema } from "../_shared/reflection.js";

export default defineTool({
  name: "write-path-value",
  title: "Write a value into a live GC table slot (direct heap write, MUTATES STATE)",
  description:
    "WRITES LIVE GAME STATE. Direct heap write into one slot of a Luau table: resolve a Luau expression to a " +
    "TABLE container, then assign container[key] = <value>, returning BOTH the OLD and NEW value so the change is " +
    "auditable. This is the write counterpart to read-path-value and the natural action after a memscan locates a " +
    "field — e.g. flip a config flag ('require(game.ReplicatedStorage.Config)', key='GodMode', value true), bump " +
    "a cached stat ('getgenv().PlayerData', key='Coins', value=9999), or clear a slot (kind='nil'). The container " +
    "expression is evaluated as `return <containerExpr>` and MUST resolve to a table (anything else returns a " +
    "clean { error }). For non-primitive values (Vector3, Color3, Enum, an Instance, a table, …) use kind='raw' " +
    "and pass a Luau expression. The read of the old value and the write are each pcall-guarded. WARNING: this " +
    "mutates running client memory immediately; writing through a metatable-protected/readonly table may error " +
    "(returned as { error }) and some game state replicates or is server-authoritative. Requires loadstring/load. " +
    "Returns { Container, Key, OldValue, NewValue, ok } or { error }.",
  category: "Memory Scan",
  mutatesState: true,
  input: z.object({
    containerExpr: z
      .string()
      .describe(
        "Luau expression resolving to the TABLE whose slot you want to write, e.g. " +
          "'getgenv().PlayerData', 'require(game.ReplicatedStorage.Config)', '_G.Settings', or any table " +
          "reference found via a heap scan. Evaluated as `return <containerExpr>` and must resolve to a table.",
      ),
    key: z
      .string()
      .describe(
        "The string key (field name) within the container table to write, e.g. 'Coins', 'GodMode', 'WalkSpeed'. " +
          "Indexed as container[key]. (String keys only — for non-string keys, write via a raw containerExpr that " +
          "already indexes to the parent.)",
      ),
    value: valueArgSchema,
    threadContext: z.number().int().optional(),
  }),
  async execute({ containerExpr, key, value, threadContext }, ctx) {
    const newValueExpr = buildValueExpr(value);
    const source = `
${REFLECT_PRELUDE}
local container, err = __eval(${q(containerExpr)})
if err then return { error = err } end
if type(container) ~= "table" then
  return { error = "containerExpr did not resolve to a table (got " .. typeof(container) .. "): " .. ${q(containerExpr)} }
end

local key = ${q(key)}

local oldEnc = nil
local okRead, oldVal = pcall(function() return container[key] end)
if okRead then
  local okE, e = pcall(__encVal, oldVal)
  oldEnc = okE and e or "<unprintable>"
end

local okSet, setErr = pcall(function() container[key] = ${newValueExpr} end)
if not okSet then return { error = "failed to write key '" .. key .. "': " .. tostring(setErr) } end

local newEnc = nil
local okRead2, newVal = pcall(function() return container[key] end)
if okRead2 then
  local okE2, e2 = pcall(__encVal, newVal)
  newEnc = okE2 and e2 or "<unprintable>"
end

return {
  Container = tostring(container),
  Key = key,
  OldValue = oldEnc,
  NewValue = newEnc,
  ok = true,
}
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
