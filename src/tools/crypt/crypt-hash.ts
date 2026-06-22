import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

export default defineTool({
  name: "crypt-hash",
  title: "Hash a string with crypt.hash (sha1/sha256/sha384/sha512/md5)",
  description:
    "Compute a cryptographic digest of a string using the executor's `crypt.hash(data, algorithm)`. This is a pure, " +
    "side-effect-free compute that runs entirely in-game. Supported algorithms are sha1, sha256 (default), sha384, " +
    "sha512, and md5; the result is the hex digest string returned by the executor. " +
    "Requires `crypt.hash`; on an executor without it (no crypt table or no hash " +
    "function) it returns { error } instead of throwing. The call is pcall-guarded so an unsupported algorithm " +
    "degrades to a clean error. " +
    "Returns { hash, algorithm } or { error }.",
  category: "Crypt",
  mutatesState: false,
  input: z.object({
    data: z.string().describe("The string to hash."),
    algorithm: z
      .enum(["sha1", "sha256", "sha384", "sha512", "md5"])
      .describe("The hash algorithm to use (default 'sha256').")
      .optional()
      .default("sha256"),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ data, algorithm, threadContext, timeoutMs }, ctx) {
    const source = `
if type(crypt) ~= "table" then return { error = "crypt is not available in this executor." } end
if type(crypt.hash) ~= "function" then
  return { error = "crypt.hash is not available in this executor." }
end

local ok, result = pcall(crypt.hash, ${q(data)}, ${q(algorithm)})
if not ok then return { error = tostring(result) } end
return { hash = result, algorithm = ${q(algorithm)} }
`;
    const data2 = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data: data2 };
  },
});
