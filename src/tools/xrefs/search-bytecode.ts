import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q, XREF_PRELUDE } from "../_shared/xrefs.js";

export default defineTool({
  name: "search-bytecode",
  title: "Search compiled bytecode for a signature (IDA byte search)",
  description:
    "Scan every script returned by getscripts(), dump each one's compiled bytecode with getscriptbytecode, and find " +
    "scripts whose bytecode contains a given hex byte pattern — the runtime equivalent of an IDA binary/byte search. " +
    "Use it to locate scripts carrying a known opcode signature, constant blob, or fingerprint. Provide the pattern as " +
    "a hex byte string (e.g. '1a2b3c' or '1a 2b 3c'); it is normalized (spaces stripped, lowercased) and must be an " +
    "even number of hex digits. Each match reports the script's full name, class, and the byte offset of the first hit. " +
    "Requires getscripts + getscriptbytecode; caps the scan and flags truncation.",
  category: "Disassembly & Xrefs",
  input: z.object({
    hexPattern: z
      .string()
      .describe(
        "Hex byte pattern to search for in compiled bytecode, e.g. '1a2b3c' or '1a 2b 3c'. Spaces are stripped and " +
          "it is lowercased; must contain an even number of hex digits.",
      ),
    limit: z
      .number()
      .int()
      .describe("Max matching scripts to return (default 50).")
      .optional()
      .default(50),
    maxScan: z
      .number()
      .int()
      .describe("Max scripts to scan (default 6000).")
      .optional()
      .default(6000),
    threadContext: z.number().int().optional(),
  }),
  async execute({ hexPattern, limit, maxScan, threadContext }, ctx) {
    const normalized = hexPattern.replace(/\s+/g, "").toLowerCase();
    if (normalized.length === 0 || normalized.length % 2 !== 0 || !/^[0-9a-f]+$/.test(normalized)) {
      return {
        data: {
          error:
            "Invalid hexPattern: must be a non-empty, even-length string of hex bytes (e.g. '1a2b3c'). Got: " +
            JSON.stringify(hexPattern),
        },
        isError: true,
      };
    }
    const lim = Math.min(Math.max(Math.floor(limit), 1), 1000);
    const cap = Math.min(Math.max(Math.floor(maxScan), 50), 30000);
    const source = `
${XREF_PRELUDE}
if type(getscripts) ~= "function" then return { error = "getscripts is not available in this executor." } end
if type(getscriptbytecode) ~= "function" then return { error = "getscriptbytecode is not available in this executor." } end

local pattern = ${q(normalized)}
local limit = ${lim}
local cap = ${cap}

local okScripts, scripts = pcall(getscripts)
if not okScripts or type(scripts) ~= "table" then
  return { error = "getscripts() failed or returned no list." }
end

local hexmap = "0123456789abcdef"
local matches = {}
local matchCount = 0
local scanned = 0
local trunc = false

for _, scr in scripts do
  if scanned >= cap then trunc = true break end
  scanned = scanned + 1
  local okBc, bc = pcall(getscriptbytecode, scr)
  if okBc and type(bc) == "string" and #bc > 0 then
    -- Convert raw bytes to a lowercase hex string for substring search.
    local parts = {}
    for i = 1, #bc do
      local b = string.byte(bc, i)
      local hi = math.floor(b / 16) + 1
      local lo = (b % 16) + 1
      parts[i] = string.sub(hexmap, hi, hi) .. string.sub(hexmap, lo, lo)
    end
    local hex = table.concat(parts)
    local hitAt = string.find(hex, pattern, 1, true)
    if hitAt then
      matchCount = matchCount + 1
      if #matches < limit then
        local okName, name = pcall(function() return scr:GetFullName() end)
        local class = ""
        local okClass, cn = pcall(function() return scr.ClassName end)
        if okClass and type(cn) == "string" then class = cn end
        -- hitAt is a 1-based char index into the hex string (2 chars per byte).
        local byteOffset = math.floor((hitAt - 1) / 2)
        matches[#matches + 1] = {
          script = (okName and type(name) == "string") and name or tostring(scr),
          class = class,
          byteOffset = byteOffset,
        }
      end
    end
  end
end

return {
  hexPattern = pattern,
  matchCount = matchCount,
  scriptsScanned = scanned,
  truncatedScan = trunc,
  matches = matches,
}
`;
    const data = await ctx.runLuau(source, {
      timeoutMs: 45000,
      ...(threadContext !== undefined ? { threadContext } : {}),
    });
    return { data };
  },
});
