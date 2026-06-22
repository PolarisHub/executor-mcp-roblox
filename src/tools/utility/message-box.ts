import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

/**
 * Show a native host message box via messagebox(text, caption, flags). The flags
 * map to the OS dialog's button/icon style; the call returns the numeric code of
 * the button the user pressed.
 */
export default defineTool({
  name: "message-box",
  title: "Show a native host message box (sUNC messagebox)",
  description:
    "WRITES HOST STATE — pops up a NATIVE OS dialog on the host machine via messagebox(text, caption, flags). The " +
    "flags select the dialog's button/icon style (the same bitfield as the Win32 MessageBox), and the call blocks " +
    "until the user dismisses it, returning the numeric code of the button pressed. Requires messagebox. " +
    "The call is type-guarded and pcall-wrapped: if messagebox is missing you get " +
    "{ error = 'messagebox is not available in this executor.' }. Returns { result } or { error }.",
  category: "Utility",
  mutatesState: true,
  input: z.object({
    text: z.string().describe("The body text shown in the dialog."),
    caption: z
      .string()
      .optional()
      .default("MCP")
      .describe("The dialog title/caption (default 'MCP')."),
    flags: z
      .number()
      .int()
      .optional()
      .default(0)
      .describe("The dialog style bitfield (default 0 = OK button only)."),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ text, caption, flags, threadContext, timeoutMs }, ctx) {
    const source = `
if type(messagebox) ~= "function" then
  return { error = "messagebox is not available in this executor." }
end
local ok, result = pcall(messagebox, ${q(text)}, ${q(caption)}, ${Math.floor(flags)})
if not ok then return { error = tostring(result) } end
return { result = result }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data };
  },
});
