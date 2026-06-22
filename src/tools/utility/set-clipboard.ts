import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

/**
 * Copy text to the host OS clipboard via setclipboard(text) (falling back to
 * toclipboard(text) on executors that spell it differently).
 */
export default defineTool({
  name: "set-clipboard",
  title: "Copy text to the host clipboard (sUNC setclipboard / toclipboard)",
  description:
    "WRITES HOST STATE — copies the given text to the host machine's OS clipboard via setclipboard(text), falling " +
    "back to toclipboard(text) on executors that use that name. This overwrites whatever is currently on the " +
    "clipboard. Requires one of these functions. The call is type-guarded and " +
    "pcall-wrapped: if neither is present you get { error = 'setclipboard is not available in this executor.' }. " +
    "Returns { ok, length } or { error }.",
  category: "Utility",
  mutatesState: true,
  input: z.object({
    text: z.string().describe("The text to place on the host clipboard."),
    threadContext: z.number().int().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  async execute({ text, threadContext, timeoutMs }, ctx) {
    const source = `
local fn = nil
if type(setclipboard) == "function" then
  fn = setclipboard
elseif type(toclipboard) == "function" then
  fn = toclipboard
end
if type(fn) ~= "function" then
  return { error = "setclipboard is not available in this executor." }
end
local text = ${q(text)}
local ok, err = pcall(fn, text)
if not ok then return { error = tostring(err) } end
return { ok = true, length = #text }
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs });
    return { data };
  },
});
