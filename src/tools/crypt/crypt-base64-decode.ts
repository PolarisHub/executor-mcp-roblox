import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "crypt-base64-decode",
  title: "Base64-decode a string via the executor crypt library (Volt-class executor)",
  description:
    "Decode a Base64 string back to its raw bytes using the executor's `crypt` library. This is a pure, " +
    "side-effect-free compute that runs entirely in-game. The decoder probes BOTH the flat form " +
    "(crypt.base64decode) and the namespaced form (crypt.base64.decode), using whichever the executor provides. " +
    "Requires a Volt-class executor exposing a `crypt` table; on a plain/non-Volt executor (no crypt, or no base64 " +
    "decoder under either name) it returns { error } instead of throwing. The call is pcall-guarded so malformed " +
    "Base64 degrades to a clean error. " +
    "Returns { decoded } or { error }.",
  category: "Crypt",
  mutatesState: false,
  input: z.object({
    data: z.string().describe("The Base64-encoded string to decode."),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ data, threadContext, timeoutMs }, ctx) {
    const source = `
if type(crypt) ~= "table" then return { error = "crypt is not available in this executor." } end

local decoder
if type(crypt.base64decode) == "function" then
  decoder = crypt.base64decode
elseif type(crypt.base64) == "table" and type(crypt.base64.decode) == "function" then
  decoder = crypt.base64.decode
end
if type(decoder) ~= "function" then
  return { error = "crypt.base64decode is not available in this executor." }
end

local ok, result = pcall(decoder, ${q(data)})
if not ok then return { error = tostring(result) } end
return { decoded = result }
`;
    const data2 = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data: data2 };
  },
});
