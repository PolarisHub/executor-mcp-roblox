import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, REFLECT_PRELUDE } from "../_shared/reflection.js";

export default defineTool({
  name: "read-path-value",
  title: "Read the value at a Luau path/expression (precise slot read)",
  description:
    "Evaluate a single Luau expression and report exactly what lives at that slot — without mutating anything. " +
    "Use it to read a precise location after a heap scan points you at it (e.g. " +
    "'getgenv().PlayerData.Coins', 'game.Players.LocalPlayer.leaderstats.Cash.Value', " +
    "'require(game.ReplicatedStorage.Config).GodMode', 'getrawmetatable(game).__namecall'), or to spot-check any " +
    "value/global/field during analysis. The expression is evaluated as `return <expression>` under a pcall, so " +
    "a bad path returns a clean { error } instead of throwing. The result reports { type } (Roblox typeof), " +
    "{ value } (a safe encoded scalar — Instances become 'Instance: <FullName>', tables/functions become their " +
    "address), and { isTable }. When the value is a table it also returns { length } (the array-part length via #) " +
    "and { keys } (up to 50 string keys, so you can see the shape and pick the next field to read). Reading the " +
    "keys/length is pcall-guarded. This is read-only and is the counterpart to write-path-value. Requires " +
    "loadstring/load. Returns { type, value, isTable, length?, keys?, keysTruncated? } or { error }.",
  category: "Memory Scan",
  input: z.object({
    expression: z
      .string()
      .describe(
        "Luau expression resolving to the value to read, e.g. 'getgenv().PlayerData.Coins', " +
          "'game.Players.LocalPlayer.leaderstats.Cash.Value', 'require(game.ReplicatedStorage.Config)', " +
          "'_G.Settings', or any table slot / global / call result. Evaluated as `return <expression>`.",
      ),
    threadContext: z.number().int().optional(),
  }),
  async execute({ expression, threadContext }, ctx) {
    const source = `
${REFLECT_PRELUDE}
local val, err = __eval(${q(expression)})
if err then return { error = err } end

local okT, t = pcall(typeof, val)
local vtype = okT and t or type(val)

local enc
local okEnc, e = pcall(__encVal, val)
enc = okEnc and e or "<unprintable>"

local isTable = (type(val) == "table")
local result = { type = vtype, value = enc, isTable = isTable }

if isTable then
  local okLen, len = pcall(function() return #val end)
  result.length = okLen and len or 0

  local keys = {}
  local keysTruncated = false
  pcall(function()
    local count = 0
    for k, _ in pairs(val) do
      if type(k) == "string" then
        count = count + 1
        if #keys < 50 then
          keys[#keys + 1] = k
        else
          keysTruncated = true
          break
        end
      end
    end
  end)
  result.keys = keys
  result.keysTruncated = keysTruncated
end

return result
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
