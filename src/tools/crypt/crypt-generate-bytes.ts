import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

export default defineTool({
  name: "crypt-generate-bytes",
  title: "Generate random bytes with crypt.generatebytes (Volt-class executor)",
  description:
    "Generate `size` cryptographically random bytes using the executor's `crypt.generatebytes(size)`. The bytes are " +
    "returned as a Base64 string (decode with crypt-base64-decode if you need the raw bytes). This is a pure, " +
    "side-effect-free compute that runs entirely in-game. The default size is 16; the request is clamped to a sane " +
    "1..1024 range. " +
    "Requires a Volt-class executor exposing `crypt.generatebytes`; on a plain/non-Volt executor it returns { error } " +
    "instead of throwing. The call is pcall-guarded. " +
    "Returns { bytes } or { error }.",
  category: "Crypt",
  mutatesState: false,
  input: z.object({
    size: z
      .number()
      .int()
      .describe("Number of random bytes to generate (default 16, clamped to 1..1024).")
      .optional()
      .default(16),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ size, threadContext, timeoutMs }, ctx) {
    const sz = Math.min(Math.max(Math.floor(size), 1), 1024);

    const source = `
if type(crypt) ~= "table" then return { error = "crypt is not available in this executor." } end
if type(crypt.generatebytes) ~= "function" then
  return { error = "crypt.generatebytes is not available in this executor." }
end

local ok, bytes = pcall(crypt.generatebytes, ${sz})
if not ok then return { error = tostring(bytes) } end
return { bytes = bytes }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data };
  },
});
