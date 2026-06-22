import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "crypt-base64-encode",
  title: "Base64-encode a string via the executor crypt library (Volt-class executor)",
  description:
    "Encode an arbitrary string to Base64 using the executor's `crypt` library. This is a pure, side-effect-free " +
    "compute that runs entirely in-game. The encoder probes BOTH the flat form (crypt.base64encode) and the " +
    "namespaced form (crypt.base64.encode), using whichever the executor provides. " +
    "Requires a Volt-class executor exposing a `crypt` table; on a plain/non-Volt executor (no crypt, or no base64 " +
    "encoder under either name) it returns { error } instead of throwing. The call is pcall-guarded so a malformed " +
    "input degrades to a clean error. " +
    "Returns { encoded } or { error }.",
  category: "Crypt",
  mutatesState: false,
  input: z.object({
    data: z.string().describe("The raw string to Base64-encode."),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ data, threadContext, timeoutMs }, ctx) {
    const source = `
if type(crypt) ~= "table" then return { error = "crypt is not available in this executor." } end

local encoder
if type(crypt.base64encode) == "function" then
  encoder = crypt.base64encode
elseif type(crypt.base64) == "table" and type(crypt.base64.encode) == "function" then
  encoder = crypt.base64.encode
end
if type(encoder) ~= "function" then
  return { error = "crypt.base64encode is not available in this executor." }
end

local ok, result = pcall(encoder, ${q(data)})
if not ok then return { error = tostring(result) } end
return { encoded = result }
`;
    const data2 = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data: data2 };
  },
});
