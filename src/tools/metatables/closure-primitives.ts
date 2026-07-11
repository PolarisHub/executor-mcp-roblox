import { z } from "zod";

import type { Tool } from "../../application/tool/tool.js";
import { defineTool } from "../../application/tool/define-tool.js";
import { buildValueExpr, q, REFLECT_PRELUDE, valueArgSchema } from "../_shared/reflection.js";
import { PRELUDE } from "../_shared/luau.js";

const CATEGORY = "Metatables & Closures" as const;

const functionInput = z.object({
  functionPath: z.string().min(1).describe("Luau expression resolving to the target function."),
  threadContext: z.number().int().optional(),
});

const referenceInput = functionInput.extend({
  key: z
    .string()
    .max(96)
    .optional()
    .default("")
    .describe("Optional stable key for getgenv().__mcp_closure_refs. Generated when omitted."),
});

const CLOSURE_STORE_PRELUDE = `
local function __closureRegistry()
  if type(getgenv) ~= "function" then
    return nil, "getgenv is not available; closure references cannot be retained."
  end
  local ok, genv = pcall(getgenv)
  if not ok or type(genv) ~= "table" then return nil, "getgenv failed." end
  if type(genv.__mcp_closure_refs) ~= "table" then genv.__mcp_closure_refs = {} end
  return genv.__mcp_closure_refs, nil
end

local function __storeClosure(fn, requestedKey)
  if type(fn) ~= "function" then return nil, "value to store is not a function" end
  local registry, err = __closureRegistry()
  if err then return nil, err end
  local key = tostring(requestedKey or "")
  if key == "" then
    local seed = tostring(fn):gsub("[^%w]+", "-")
    key = "closure-" .. seed
    local suffix = 1
    local base = key
    while registry[key] ~= nil and registry[key] ~= fn do
      suffix = suffix + 1
      key = base .. "-" .. tostring(suffix)
    end
  elseif registry[key] ~= nil and registry[key] ~= fn then
    return nil, "closure reference key already exists: " .. key
  end
  registry[key] = fn
  return {
    Key = key,
    Reference = "getgenv().__mcp_closure_refs[" .. string.format("%q", key) .. "]",
    Info = __fnInfo(fn),
  }, nil
end
`;

function confirmedError(action: string): { data: { error: string }; isError: true } {
  return {
    data: { error: `Refusing to ${action} (may mutate live behavior); pass confirm=true.` },
    isError: true,
  };
}

const closureCapabilities = defineTool({
  name: "closure-capabilities",
  title: "Probe the complete closure/reflection primitive surface",
  description:
    "Read-only capability matrix for the official Volt closure library plus the MCP's useful debug closure " +
    "operations. Reports the selected alias for every primitive without calling it.",
  category: CATEGORY,
  input: z.object({ threadContext: z.number().int().optional() }),
  async execute({ threadContext }, ctx) {
    const source = `
local function alias(...)
  local names = {...}
  local hosts = {}
  if type(getgenv) == "function" then local ok, value = pcall(getgenv); if ok and type(value) == "table" then hosts[#hosts + 1] = value end end
  if type(getfenv) == "function" then local ok, value = pcall(getfenv, 0); if ok and type(value) == "table" then hosts[#hosts + 1] = value end end
  if type(_G) == "table" then hosts[#hosts + 1] = _G end
  for _, name in ipairs(names) do
    for _, host in ipairs(hosts) do
      local ok, value = pcall(function() return host[name] end)
      if ok and type(value) == "function" then return true, name end
    end
    if type(loadstring) == "function" then
      local okLoader, loader = pcall(loadstring, "return " .. name)
      if okLoader and type(loader) == "function" then
        local okValue, value = pcall(loader)
        if okValue and type(value) == "function" then return true, name end
      end
    end
  end
  return false, nil
end
local functions = {}
local function add(name, ...)
  local ok, selected = alias(...)
  functions[name] = { available = ok, selectedAlias = selected }
end
add("checkcaller", "checkcaller")
add("clonefunction", "clonefunction", "clonefunc")
add("getfunctionhash", "getfunctionhash")
add("hookfunction", "hookfunction")
add("hookmetamethod", "hookmetamethod")
add("iscclosure", "iscclosure")
add("isexecutorclosure", "isexecutorclosure", "checkclosure", "isourclosure")
add("isfunctionhooked", "isfunctionhooked")
add("islclosure", "islclosure")
add("isnewcclosure", "isnewcclosure", "iscustomcclosure")
add("newcclosure", "newcclosure")
add("newlclosure", "newlclosure")
add("restorefunction", "restorefunction", "restorefunc")
add("setstackhidden", "setstackhidden")
add("getconstants", "getconstants", "debug.getconstants")
add("getupvalues", "getupvalues", "debug.getupvalues")
add("getprotos", "getprotos", "debug.getprotos")
add("getinfo", "getinfo", "debug.getinfo")
add("setconstant", "setconstant", "debug.setconstant")
add("setupvalue", "setupvalue", "debug.setupvalue")
add("getfenv", "getfenv")
add("setfenv", "setfenv")
local count, availableCount = 0, 0
for _, entry in pairs(functions) do
  count = count + 1
  if entry.available then availableCount = availableCount + 1 end
end
return { ok = true, total = count, availableCount = availableCount, missingCount = count - availableCount, functions = functions }
`;
    return { data: await ctx.runLuau(source, { threadContext, timeoutMs: 15000 }) };
  },
});

const checkCaller = defineTool({
  name: "check-caller",
  title: "Check whether the current call originates from the executor",
  description:
    "Call Volt checkcaller in the active executor thread. This normally reports true for a direct MCP call and is " +
    "most useful as a capability/behavior probe before installing a hook.",
  category: CATEGORY,
  input: z.object({ threadContext: z.number().int().optional() }),
  async execute({ threadContext }, ctx) {
    const source = `
if type(checkcaller) ~= "function" then return { error = "checkcaller is not available in this executor." } end
local ok, value = pcall(checkcaller)
if not ok then return { error = "checkcaller failed: " .. tostring(value) } end
return { ok = true, calledByExecutor = value == true }
`;
    return { data: await ctx.runLuau(source, { threadContext, timeoutMs: 10000 }) };
  },
});

const cloneFunction = defineTool({
  name: "clone-function",
  title: "Clone a function and retain a reusable closure reference",
  description:
    "Clone a function with clonefunction/clonefunc. The function result is retained in " +
    "getgenv().__mcp_closure_refs and returned as a reusable Reference expression because functions cannot cross JSON.",
  category: CATEGORY,
  input: referenceInput,
  async execute({ functionPath, key, threadContext }, ctx) {
    const source = `
${REFLECT_PRELUDE}
${CLOSURE_STORE_PRELUDE}
local clone = (type(clonefunction) == "function" and clonefunction) or (type(clonefunc) == "function" and clonefunc)
if type(clone) ~= "function" then return { error = "clonefunction/clonefunc is not available in this executor." } end
local fn, err = __evalFn(${q(functionPath)})
if err then return { error = err } end
local ok, cloned = pcall(clone, fn)
if not ok or type(cloned) ~= "function" then return { error = "clonefunction failed: " .. tostring(cloned) } end
local stored, storeErr = __storeClosure(cloned, ${q(key)})
if storeErr then return { error = storeErr } end
stored.Target = ${q(functionPath)}
stored.SharedUpvalues = true
return stored
`;
    return { data: await ctx.runLuau(source, { threadContext, timeoutMs: 20000 }) };
  },
});

const getFunctionHash = defineTool({
  name: "get-function-hash",
  title: "Hash a Luau closure's bytecode",
  description:
    "Resolve a function and return getfunctionhash(fn), useful for stable comparison and change detection. Volt only " +
    "supports bytecode hashing for Luau closures; C closures return a clean executor error.",
  category: CATEGORY,
  input: functionInput,
  async execute({ functionPath, threadContext }, ctx) {
    const source = `
${REFLECT_PRELUDE}
if type(getfunctionhash) ~= "function" then return { error = "getfunctionhash is not available in this executor." } end
local fn, err = __evalFn(${q(functionPath)})
if err then return { error = err } end
local ok, hash = pcall(getfunctionhash, fn)
if not ok then return { error = "getfunctionhash failed: " .. tostring(hash) } end
return { ok = true, Target = ${q(functionPath)}, Hash = tostring(hash), Info = __fnInfo(fn) }
`;
    return { data: await ctx.runLuau(source, { threadContext, timeoutMs: 15000 }) };
  },
});

function predicateTool(options: {
  name: string;
  title: string;
  description: string;
  predicateExpression: string;
  unavailable: string;
  predicateLabel: string;
}): Tool {
  return defineTool({
    name: options.name,
    title: options.title,
    description: options.description,
    category: CATEGORY,
    input: functionInput,
    async execute({ functionPath, threadContext }, ctx) {
      const source = `
${REFLECT_PRELUDE}
local predicate = ${options.predicateExpression}
if type(predicate) ~= "function" then return { error = ${q(options.unavailable)} } end
local fn, err = __evalFn(${q(functionPath)})
if err then return { error = err } end
local ok, result = pcall(predicate, fn)
if not ok then return { error = ${q(options.predicateLabel + " failed: ")} .. tostring(result) } end
return { ok = true, Target = ${q(functionPath)}, Result = result == true, Predicate = ${q(options.predicateLabel)}, Info = __fnInfo(fn) }
`;
      return { data: await ctx.runLuau(source, { threadContext, timeoutMs: 10000 }) };
    },
  });
}

const isCClosure = predicateTool({
  name: "is-c-closure",
  title: "Check whether a function is a native or wrapped C closure",
  description: "Resolve a function and call iscclosure with guarded metadata.",
  predicateExpression: "iscclosure",
  unavailable: "iscclosure is not available in this executor.",
  predicateLabel: "iscclosure",
});

const isLClosure = predicateTool({
  name: "is-l-closure",
  title: "Check whether a function is a Luau closure",
  description: "Resolve a function and call islclosure with guarded metadata.",
  predicateExpression: "islclosure",
  unavailable: "islclosure is not available in this executor.",
  predicateLabel: "islclosure",
});

const isExecutorClosure = predicateTool({
  name: "is-executor-closure",
  title: "Check whether a closure originates from the executor",
  description:
    "Call isexecutorclosure with checkclosure/isourclosure aliases to distinguish executor-created closures from game closures.",
  predicateExpression:
    '(type(isexecutorclosure) == "function" and isexecutorclosure) or (type(checkclosure) == "function" and checkclosure) or (type(isourclosure) == "function" and isourclosure)',
  unavailable: "isexecutorclosure/checkclosure/isourclosure is not available in this executor.",
  predicateLabel: "isexecutorclosure",
});

const isFunctionHooked = predicateTool({
  name: "is-function-hooked",
  title: "Check whether a function currently has an executor hook",
  description: "Resolve a function and call isfunctionhooked before hooking/restoring it.",
  predicateExpression: "isfunctionhooked",
  unavailable: "isfunctionhooked is not available in this executor.",
  predicateLabel: "isfunctionhooked",
});

const isNewCClosure = predicateTool({
  name: "is-new-c-closure",
  title: "Distinguish newcclosure wrappers from native C closures",
  description: "Call isnewcclosure with the iscustomcclosure alias when available.",
  predicateExpression:
    '(type(isnewcclosure) == "function" and isnewcclosure) or (type(iscustomcclosure) == "function" and iscustomcclosure)',
  unavailable: "isnewcclosure/iscustomcclosure is not available in this executor.",
  predicateLabel: "isnewcclosure",
});

const newCClosure = defineTool({
  name: "new-c-closure",
  title: "Wrap a Luau function as a C closure and retain it",
  description:
    "Call newcclosure(function, debugName?) and store the wrapper under getgenv().__mcp_closure_refs, returning a " +
    "reusable Reference expression and closure metadata.",
  category: CATEGORY,
  input: referenceInput.extend({
    debugName: z.string().max(128).optional().default(""),
  }),
  async execute({ functionPath, key, debugName, threadContext }, ctx) {
    const source = `
${REFLECT_PRELUDE}
${CLOSURE_STORE_PRELUDE}
if type(newcclosure) ~= "function" then return { error = "newcclosure is not available in this executor." } end
local fn, err = __evalFn(${q(functionPath)})
if err then return { error = err } end
local debugName = ${q(debugName)}
local ok, wrapped
if debugName ~= "" then ok, wrapped = pcall(newcclosure, fn, debugName) else ok, wrapped = pcall(newcclosure, fn) end
if not ok or type(wrapped) ~= "function" then return { error = "newcclosure failed: " .. tostring(wrapped) } end
local stored, storeErr = __storeClosure(wrapped, ${q(key)})
if storeErr then return { error = storeErr } end
stored.Target = ${q(functionPath)}
stored.Wrapper = "C"
stored.DebugName = debugName ~= "" and debugName or nil
return stored
`;
    return { data: await ctx.runLuau(source, { threadContext, timeoutMs: 20000 }) };
  },
});

const newLClosure = defineTool({
  name: "new-l-closure",
  title: "Wrap a C closure as a Luau closure and retain it",
  description:
    "Call newlclosure(function) and store the wrapper under getgenv().__mcp_closure_refs, returning a reusable " +
    "Reference expression and closure metadata.",
  category: CATEGORY,
  input: referenceInput,
  async execute({ functionPath, key, threadContext }, ctx) {
    const source = `
${REFLECT_PRELUDE}
${CLOSURE_STORE_PRELUDE}
if type(newlclosure) ~= "function" then return { error = "newlclosure is not available in this executor." } end
local fn, err = __evalFn(${q(functionPath)})
if err then return { error = err } end
local ok, wrapped = pcall(newlclosure, fn)
if not ok or type(wrapped) ~= "function" then return { error = "newlclosure failed: " .. tostring(wrapped) } end
local stored, storeErr = __storeClosure(wrapped, ${q(key)})
if storeErr then return { error = storeErr } end
stored.Target = ${q(functionPath)}
stored.Wrapper = "Luau"
return stored
`;
    return { data: await ctx.runLuau(source, { threadContext, timeoutMs: 20000 }) };
  },
});

const restoreFunction = defineTool({
  name: "restore-function",
  title: "Restore any currently hooked function",
  description:
    "WRITES LIVE GAME STATE. Resolve a target and call restorefunction/restorefunc directly. Unlike restore-hook, " +
    "this also restores hooks not installed through the MCP registry. Requires confirm=true.",
  category: CATEGORY,
  mutatesState: true,
  input: functionInput.extend({ confirm: z.boolean().default(false) }),
  async execute({ functionPath, confirm, threadContext }, ctx) {
    if (confirm !== true) return confirmedError("restore a function");
    const source = `
${REFLECT_PRELUDE}
local restore = (type(restorefunction) == "function" and restorefunction) or (type(restorefunc) == "function" and restorefunc)
if type(restore) ~= "function" then return { error = "restorefunction/restorefunc is not available in this executor." } end
local fn, err = __evalFn(${q(functionPath)})
if err then return { error = err } end
local ok, failure = pcall(restore, fn)
if not ok then return { error = "restorefunction failed: " .. tostring(failure) } end
return { ok = true, Restored = ${q(functionPath)}, Info = __fnInfo(fn) }
`;
    return { data: await ctx.runLuau(source, { threadContext, timeoutMs: 15000 }) };
  },
});

const setStackHidden = defineTool({
  name: "set-stack-hidden",
  title: "Set a closure's stack-trace visibility",
  description:
    "WRITES LIVE GAME STATE. Call setstackhidden(function, hidden) to alter runtime stack/debug visibility. This can " +
    "make diagnostics incomplete, so it is confirmation-gated and should be restored with hidden=false after use.",
  category: CATEGORY,
  mutatesState: true,
  input: functionInput.extend({
    hidden: z.boolean().describe("True hides the function; false restores normal visibility."),
    confirm: z.boolean().default(false),
  }),
  async execute({ functionPath, hidden, confirm, threadContext }, ctx) {
    if (confirm !== true) return confirmedError("change stack visibility");
    const source = `
${REFLECT_PRELUDE}
if type(setstackhidden) ~= "function" then return { error = "setstackhidden is not available in this executor." } end
local fn, err = __evalFn(${q(functionPath)})
if err then return { error = err } end
local ok, failure = pcall(setstackhidden, fn, ${hidden ? "true" : "false"})
if not ok then return { error = "setstackhidden failed: " .. tostring(failure) } end
return { ok = true, Target = ${q(functionPath)}, Hidden = ${hidden ? "true" : "false"}, Info = __fnInfo(fn) }
`;
    return { data: await ctx.runLuau(source, { threadContext, timeoutMs: 15000 }) };
  },
});

const invokeClosure = defineTool({
  name: "invoke-closure",
  title: "Invoke a closure by reference with typed arguments",
  description:
    "WRITES LIVE GAME STATE. Invoke an arbitrary live function expression with up to 24 typed arguments and return " +
    "up to 20 encoded results. Function calls may have side effects, so confirm=true is mandatory.",
  category: CATEGORY,
  mutatesState: true,
  input: functionInput.extend({
    arguments: z.array(valueArgSchema).max(24).optional().default([]),
    confirm: z.boolean().default(false),
  }),
  async execute({ functionPath, arguments: args, confirm, threadContext }, ctx) {
    if (confirm !== true) return confirmedError("invoke a live closure");
    const argSource = args.map(buildValueExpr).join(", ");
    const source = `
${REFLECT_PRELUDE}
${PRELUDE}
local fn, err = __evalFn(${q(functionPath)})
if err then return { error = err } end
local args = { ${argSource} }
local packed = table.pack(pcall(fn, table.unpack(args, 1, #args)))
if not packed[1] then return { error = "closure invocation failed: " .. tostring(packed[2]) } end
local results = {}
for i = 2, math.min(packed.n, 21) do results[#results + 1] = __encode(packed[i]) end
return { ok = true, Target = ${q(functionPath)}, ResultCount = math.max(0, packed.n - 1), Results = results, Truncated = packed.n > 21 }
`;
    return { data: await ctx.runLuau(source, { threadContext, timeoutMs: 30000 }) };
  },
});

const setFunctionEnv = defineTool({
  name: "set-function-env",
  title: "Replace a closure's environment table",
  description:
    "WRITES LIVE GAME STATE. Resolve a function and an environment-table expression, then call setfenv. This changes " +
    "global lookup behavior for the live closure and requires confirm=true.",
  category: CATEGORY,
  mutatesState: true,
  input: functionInput.extend({
    environmentExpression: z.string().min(1),
    confirm: z.boolean().default(false),
  }),
  async execute({ functionPath, environmentExpression, confirm, threadContext }, ctx) {
    if (confirm !== true) return confirmedError("replace a function environment");
    const source = `
${REFLECT_PRELUDE}
if type(setfenv) ~= "function" then return { error = "setfenv is not available in this executor." } end
local fn, err = __evalFn(${q(functionPath)})
if err then return { error = err } end
local env, envErr = __eval(${q(environmentExpression)})
if envErr then return { error = envErr } end
if type(env) ~= "table" then return { error = "environmentExpression did not resolve to a table." } end
local ok, result = pcall(setfenv, fn, env)
if not ok then return { error = "setfenv failed: " .. tostring(result) } end
return { ok = true, Target = ${q(functionPath)}, Environment = ${q(environmentExpression)}, Info = __fnInfo(fn) }
`;
    return { data: await ctx.runLuau(source, { threadContext, timeoutMs: 15000 }) };
  },
});

const listClosureReferences = defineTool({
  name: "list-closure-references",
  title: "List retained clone/newclosure handles",
  description:
    "Read the bounded getgenv().__mcp_closure_refs registry created by clone-function/new-c-closure/new-l-closure and " +
    "return reusable expressions plus function metadata.",
  category: CATEGORY,
  input: z.object({
    limit: z.number().int().min(1).max(200).optional().default(100),
    threadContext: z.number().int().optional(),
  }),
  async execute({ limit, threadContext }, ctx) {
    const source = `
${REFLECT_PRELUDE}
if type(getgenv) ~= "function" then return { error = "getgenv is not available in this executor." } end
local ok, genv = pcall(getgenv)
if not ok or type(genv) ~= "table" then return { error = "getgenv failed." } end
local registry = genv.__mcp_closure_refs
if type(registry) ~= "table" then return { ok = true, Count = 0, References = {} } end
local keys = {}
for key in pairs(registry) do keys[#keys + 1] = tostring(key) end
table.sort(keys)
local out = {}
for i = 1, math.min(#keys, ${limit}) do
  local key = keys[i]
  local value = registry[key]
  out[#out + 1] = {
    Key = key,
    Reference = "getgenv().__mcp_closure_refs[" .. string.format("%q", key) .. "]",
    Info = type(value) == "function" and __fnInfo(value) or nil,
    Type = typeof(value),
  }
end
return { ok = true, Count = #keys, Returned = #out, Truncated = #keys > #out, References = out }
`;
    return { data: await ctx.runLuau(source, { threadContext, timeoutMs: 15000 }) };
  },
});

const releaseClosureReference = defineTool({
  name: "release-closure-reference",
  title: "Release a retained closure handle",
  description:
    "WRITES LIVE GAME STATE. Remove one key from getgenv().__mcp_closure_refs so cloned/wrapped closures can be " +
    "garbage-collected. This invalidates its returned Reference and requires confirm=true.",
  category: CATEGORY,
  mutatesState: true,
  input: z.object({
    key: z.string().min(1).max(96),
    confirm: z.boolean().default(false),
    threadContext: z.number().int().optional(),
  }),
  async execute({ key, confirm, threadContext }, ctx) {
    if (confirm !== true) return confirmedError("release a closure reference");
    const source = `
if type(getgenv) ~= "function" then return { error = "getgenv is not available in this executor." } end
local ok, genv = pcall(getgenv)
if not ok or type(genv) ~= "table" then return { error = "getgenv failed." } end
local registry = genv.__mcp_closure_refs
if type(registry) ~= "table" or registry[${q(key)}] == nil then return { error = "closure reference key was not found." } end
registry[${q(key)}] = nil
return { ok = true, Released = ${q(key)} }
`;
    return { data: await ctx.runLuau(source, { threadContext, timeoutMs: 10000 }) };
  },
});

export const closurePrimitiveTools: Tool[] = [
  closureCapabilities,
  checkCaller,
  cloneFunction,
  getFunctionHash,
  isCClosure,
  isLClosure,
  isExecutorClosure,
  isFunctionHooked,
  isNewCClosure,
  newCClosure,
  newLClosure,
  restoreFunction,
  setStackHidden,
  invokeClosure,
  setFunctionEnv,
  listClosureReferences,
  releaseClosureReference,
];
