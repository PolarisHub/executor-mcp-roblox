import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "crypt-generate-key",
  title: "Generate a random symmetric key with crypt.generatekey",
  description:
    "Generate a cryptographically random symmetric key using the executor's `crypt.generatekey()`. The key is " +
    "returned as a Base64 string suitable for use with crypt-encrypt / crypt-decrypt. This is a pure, " +
    "side-effect-free compute that runs entirely in-game. " +
    "Requires `crypt.generatekey`; on an executor without it, it returns { error } " +
    "instead of throwing. The call is pcall-guarded. " +
    "Returns { key } or { error }.",
  category: "Crypt",
  mutatesState: false,
  input: z.object({
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ threadContext, timeoutMs }, ctx) {
    const source = `
if type(crypt) ~= "table" then return { error = "crypt is not available in this executor." } end
if type(crypt.generatekey) ~= "function" then
  return { error = "crypt.generatekey is not available in this executor." }
end

local ok, key = pcall(crypt.generatekey)
if not ok then return { error = tostring(key) } end
return { key = key }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data };
  },
});
