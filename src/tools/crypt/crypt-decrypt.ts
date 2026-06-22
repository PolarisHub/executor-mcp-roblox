import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "crypt-decrypt",
  title: "Symmetrically decrypt data with crypt.decrypt",
  description:
    "Decrypt a ciphertext with the executor's `crypt.decrypt(data, key, iv, mode?)`. Supply the same Base64 key and " +
    "iv that were used to encrypt, plus the optional cipher mode if a non-default mode was used. The function " +
    "returns the recovered plaintext. This is a pure, side-effect-free compute that runs entirely in-game. " +
    "Requires `crypt.decrypt`; on an executor without it, it returns { error } " +
    "instead of throwing. The call is pcall-guarded so a wrong key/iv/mode degrades to a clean error. " +
    "Returns { plaintext } or { error }.",
  category: "Crypt",
  mutatesState: false,
  input: z.object({
    data: z.string().describe("The ciphertext to decrypt."),
    key: z.string().describe("The Base64-encoded symmetric key that was used to encrypt."),
    iv: z.string().describe("The Base64-encoded initialization vector that was used to encrypt."),
    mode: z
      .string()
      .describe(
        "Optional cipher mode; must match the mode used at encrypt time if it was non-default.",
      )
      .optional(),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ data, key, iv, mode, threadContext, timeoutMs }, ctx) {
    const args = [q(data), q(key), q(iv)];
    if (mode !== undefined) {
      args.push(q(mode));
    }

    const source = `
if type(crypt) ~= "table" then return { error = "crypt is not available in this executor." } end
if type(crypt.decrypt) ~= "function" then
  return { error = "crypt.decrypt is not available in this executor." }
end

local ok, plaintext = pcall(crypt.decrypt, ${args.join(", ")})
if not ok then return { error = tostring(plaintext) } end
return { plaintext = plaintext }
`;
    const data2 = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data: data2 };
  },
});
