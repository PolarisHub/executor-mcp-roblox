import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "crypt-encrypt",
  title: "Symmetrically encrypt data with crypt.encrypt (Volt-class executor)",
  description:
    "Encrypt a string with the executor's `crypt.encrypt(data, key, iv?, mode?)`. The key is a Base64 string " +
    "(see crypt-generate-key). An optional Base64 initialization vector (iv) and an optional cipher mode (e.g. " +
    "'CBC', 'CTR') may be supplied; when omitted the executor picks/derives them. The function returns the " +
    "ciphertext plus the iv actually used, both of which are reported. This is a pure, side-effect-free compute " +
    "that runs entirely in-game. " +
    "Requires a Volt-class executor exposing `crypt.encrypt`; on a plain/non-Volt executor it returns { error } " +
    "instead of throwing. The call is pcall-guarded so a bad key/iv degrades to a clean error. " +
    "Returns { ciphertext, iv } or { error }.",
  category: "Crypt",
  mutatesState: false,
  input: z.object({
    data: z.string().describe("The plaintext string to encrypt."),
    key: z.string().describe("The Base64-encoded symmetric key (see crypt-generate-key)."),
    iv: z
      .string()
      .describe(
        "Optional Base64-encoded initialization vector; omit to let the executor derive one.",
      )
      .optional(),
    mode: z
      .string()
      .describe(
        "Optional cipher mode (e.g. 'CBC', 'CTR', 'CFB', 'OFB', 'ECB'); omit for the executor default.",
      )
      .optional(),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ data, key, iv, mode, threadContext, timeoutMs }, ctx) {
    const args = [q(data), q(key)];
    if (iv !== undefined) {
      args.push(q(iv));
    } else if (mode !== undefined) {
      // mode is positionally 4th; placehold the iv slot with nil so mode lands correctly.
      args.push("nil");
    }
    if (mode !== undefined) {
      args.push(q(mode));
    }

    const source = `
if type(crypt) ~= "table" then return { error = "crypt is not available in this executor." } end
if type(crypt.encrypt) ~= "function" then
  return { error = "crypt.encrypt is not available in this executor." }
end

local ok, ciphertext, ivOut = pcall(crypt.encrypt, ${args.join(", ")})
if not ok then return { error = tostring(ciphertext) } end
return { ciphertext = ciphertext, iv = ivOut }
`;
    const data2 = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data: data2 };
  },
});
