import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

/**
 * Builds the Luau that runs the caller's script with a live `mcp` table bound to
 * the whole tool surface. `mcp.<camelCaseTool>(args)` (or `mcp.call("kebab-name",
 * args)`) makes a loopback HTTP call to the token-gated bridge, which runs that
 * real tool on this same client and returns its data — usable inline. The script
 * runs in-game, so `game`, `workspace`, etc. are all available too.
 */
function buildScript(baseUrl: string, token: string, source: string): string {
  return `
local HttpService = game:GetService("HttpService")
local __req = (function()
  if type(request) == "function" then return request end
  if type(http_request) == "function" then return http_request end
  if type(http) == "table" and type(http.request) == "function" then return http.request end
  if type(syn) == "table" and type(syn.request) == "function" then return syn.request end
  return nil
end)()
if type(loadstring) ~= "function" then return { error = "loadstring is not available in this executor." } end

local BASE = ${q(baseUrl)}
local TOKEN = ${q(token)}

local function __camelToKebab(s)
  if string.find(s, "-", 1, true) then return s end
  local out = string.gsub(s, "%u", function(c) return "-" .. string.lower(c) end)
  if string.sub(out, 1, 1) == "-" then out = string.sub(out, 2) end
  return out
end

local function __call(name, args)
  if type(__req) ~= "function" then
    error("mcp." .. tostring(name) .. ": this executor has no HTTP request function (request/http_request).", 0)
  end
  local body = HttpService:JSONEncode({ token = TOKEN, tool = name, args = (args == nil) and {} or args })
  local res = __req({
    Url = BASE .. "/api/exec-tool",
    Method = "POST",
    Headers = { ["Content-Type"] = "application/json" },
    Body = body,
  })
  if type(res) ~= "table" or res.Body == nil then
    error("mcp." .. tostring(name) .. ": no response from server.", 0)
  end
  local ok, decoded = pcall(function() return HttpService:JSONDecode(res.Body) end)
  if not ok or type(decoded) ~= "table" then
    error("mcp." .. tostring(name) .. ": malformed response.", 0)
  end
  if not decoded.ok then
    error("mcp." .. tostring(name) .. " -> " .. tostring(decoded.error), 0)
  end
  return decoded.data
end

mcp = setmetatable({
  call = function(name, args) return __call(name, args) end,
}, {
  __index = function(_, key)
    local name = __camelToKebab(key)
    return function(args) return __call(name, args) end
  end,
})

local __userfn, __cerr = loadstring(${q(source)}, "=script")
if not __userfn then return { error = "compile error: " .. tostring(__cerr) } end
local __ok, __ret = pcall(__userfn)
if not __ok then return { error = "runtime error: " .. tostring(__ret) } end
return { result = __ret }
`;
}

export default defineTool({
  name: "script",
  title: "Run a Luau Script with the Whole Tool Surface (mcp.*)",
  description:
    "Run a Luau program in the active Roblox client that can ALSO call any other tool inline through a live `mcp` " +
    "table, and use the results in the same script — one call instead of dozens of round-trips. Inside the script: " +
    "`game`, `workspace`, and all in-game globals are available (like `execute`/`run-luau`), PLUS `mcp.<tool>(args)` " +
    "invokes any of this server's tools and RETURNS its data. Tool names are camelCase of the tool id (e.g. " +
    "`mcp.getPlayers()`, `mcp.searchInstances({ className = 'RemoteEvent' })`, `mcp.findFunctionsByName({ name = " +
    "'buy' })`, `mcp.getInstanceProperties({ path = 'game.Workspace' })`), or use `mcp.call('kebab-tool-name', " +
    "{ ... })`. `args` is a table matching that tool's input; the return value is that tool's normal data. A failing " +
    "tool raises a Lua error you can pcall. Whatever your script `return`s comes back as `{ result = ... }` (a " +
    "compile/runtime error comes back as `{ error = ... }`). Use this to orchestrate multi-step workflows: scan, " +
    "branch on results, transform, and act — leveraging the full toolset, not just a few tools. Requires loadstring " +
    "and an executor HTTP function (request/http_request); both are guarded. mcp.script is disabled (no recursion).",
  category: "Execution",
  mutatesState: true,
  input: z.object({
    source: z
      .string()
      .describe(
        "The Luau script to run. Has `game`/`workspace`/all in-game globals, plus `mcp.<tool>(args)` to call any " +
          "tool and use its returned data inline. `return <value>` to hand a value back as { result = value }.",
      ),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Overall timeout for the whole script including nested tool calls (default 120000)."),
    threadContext: z.number().int().optional(),
  }),
  async execute({ source, timeoutMs, threadContext }, ctx) {
    if (!ctx.scripting) {
      return {
        data: { error: "The scripting bridge is not available on this server." },
        isError: true,
      };
    }
    const { token, dispose } = ctx.scripting.mint();
    const wrapped = buildScript(ctx.scripting.baseUrl, token, source);
    try {
      const data = await ctx.runLuau(wrapped, {
        timeoutMs: timeoutMs ?? 120000,
        ...(threadContext !== undefined ? { threadContext } : {}),
      });
      return { data };
    } finally {
      dispose();
    }
  },
});
