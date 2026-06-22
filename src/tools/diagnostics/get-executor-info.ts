import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";

/** Marquee executor functions whose presence gates the rest of the toolkit. */
const KEY_CAPABILITIES = [
  "getgc",
  "hookfunction",
  "hookmetamethod",
  "getrawmetatable",
  "getnilinstances",
  "getactors",
  "getcallbackvalue",
  "getconnections",
  "getscriptbytecode",
  "loadstring",
] as const;

export default defineTool({
  name: "get-executor-info",
  title: "Identify the executor and its headline capabilities",
  description:
    "In-game probe that reports WHICH executor is hosting the connector and a small capability map. " +
    "Calls identifyexecutor() (guarded — it may return a name and/or version, or nothing) with " +
    "getexecutorname()/getexecutorinfo() fallbacks, then flags a handful of marquee functions (getgc, " +
    "hookfunction, getnilinstances, getactors, …) true/false. Call this first on a new client to confirm " +
    "you are on a full-featured executor before reaching for reflection/hooking tools.",
  category: "Diagnostics",
  input: z.object({}),
  async execute(_input, ctx) {
    const probes = KEY_CAPABILITIES.map((name) => `  ${name} = type(${name}) == "function",`).join(
      "\n",
    );
    const source = `
local out = { name = "unknown", version = "unknown", raw = nil }

if type(identifyexecutor) == "function" then
  local ok, a, b = pcall(identifyexecutor)
  if ok then
    if type(a) == "string" and a ~= "" then out.name = a end
    if type(b) == "string" and b ~= "" then out.version = b end
    local raw = (type(a) == "string" and a or "") .. (type(b) == "string" and (" " .. b) or "")
    if raw ~= "" and raw ~= " " then out.raw = raw end
  end
end

if out.name == "unknown" and type(getexecutorname) == "function" then
  local ok, n = pcall(getexecutorname)
  if ok and type(n) == "string" and n ~= "" then out.name = n end
end

if type(getexecutorinfo) == "function" then
  local ok, info = pcall(getexecutorinfo)
  if ok and type(info) == "table" then
    if out.name == "unknown" and type(info.name) == "string" then out.name = info.name end
    if out.version == "unknown" and type(info.version) == "string" then out.version = info.version end
  end
end

out.capabilities = {
${probes}
}
out.ok = true
return out
`;
    const result = (await ctx.runLuau(source)) as {
      name?: string;
      version?: string;
      capabilities?: Record<string, boolean>;
    };
    return {
      data: result,
      summary: `${result?.name ?? "unknown"}${result?.version && result.version !== "unknown" ? ` ${result.version}` : ""}`,
    };
  },
});
