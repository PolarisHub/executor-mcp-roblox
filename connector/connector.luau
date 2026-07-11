--!nocheck
--[[
	Clean-slate in-game connector for the executor MCP bridge.

	This single, self-contained script runs inside a Roblox executor. It speaks the
	versioned JSON envelope protocol defined in src/domain/protocol/messages.ts:

		connector -> server : hello, result, event, pong
		server -> connector : welcome, op, ping

	Design goals (mirrors the rewrite's robustness rules):
		- Every executor-specific global is type-guarded before use; absence degrades
		  gracefully instead of erroring.
		- Inbound evals use a bounded, priority-aware queue. A reserved nested lane
		  prevents script/mcp.* deadlocks without allowing task-spawn storms.
		- Results are encoded to a JSON-safe form (recursive, cycle-guarded, depth/size
		  capped) and serialized with HttpService:JSONEncode — no bespoke Lua encoding.
		- The socket reconnects forever with capped exponential backoff + jitter.

	Configure via getgenv().BridgeURL (default "localhost:16384"). The script connects
	to ws://<BridgeURL>/bridge.
]]

--// Wait for the game to finish loading so Players.LocalPlayer etc. exist. \\--
if typeof(game) == "Instance" and not game:IsLoaded() then
	pcall(function()
		game.Loaded:Wait()
	end)
end

--==============================================================================--
-- Configuration
--==============================================================================--

local RuntimeConfig = {}
pcall(function()
	if type(getgenv) == "function" then RuntimeConfig = getgenv() end
end)

local function boundedInteger(value, fallback, minimum, maximum)
	local number = tonumber(value)
	if number == nil or number ~= number then return fallback end
	return math.clamp(math.floor(number), minimum, maximum)
end

local BridgeURL = RuntimeConfig.BridgeURL or "localhost:16384"
-- Optional shared secret. When the server is started with
-- ROBLOX_MCP_BRIDGE_TOKEN set, the connector must send this exact string or the
-- bridge closes the socket. Leave nil/empty when the server runs unauthenticated.
local BridgeToken = RuntimeConfig.BridgeToken
local PROTOCOL_VERSION = 1

-- Reconnect backoff bounds (seconds).
local RECONNECT_BASE_DELAY = 1
local RECONNECT_MAX_DELAY = 30

-- Value-encoding guards: keep a pathological return value from producing a giant
-- or infinite payload.
local ENCODE_MAX_DEPTH = 6
local ENCODE_MAX_TABLE_ENTRIES = 500
local ENCODE_MAX_STRING_LENGTH = 50000
local ENCODE_MAX_KEY_LENGTH = 256
local ENCODE_MAX_TOTAL_NODES = 5000
local ENCODE_MAX_TOTAL_STRING_BYTES = 1024 * 1024

-- Game-safety budgets. These are deliberately bounded even when overridden:
-- supporting many agents means queueing fairly, never spawning unbounded work.
local MAX_CONCURRENT_EVALS = boundedInteger(RuntimeConfig.MCPMaxConcurrentEvals, 2, 2, 8)
local MAX_QUEUED_EVALS = boundedInteger(RuntimeConfig.MCPMaxQueuedEvals, 96, 8, 512)
local MAX_QUEUED_SOURCE_BYTES = boundedInteger(
	RuntimeConfig.MCPMaxQueuedSourceBytes,
	2 * 1024 * 1024,
	256 * 1024,
	16 * 1024 * 1024
)
local NESTED_QUEUE_RESERVE = math.min(8, math.max(1, math.floor(MAX_QUEUED_EVALS / 10)))
local MAX_RPC_BATCH_CALLS = boundedInteger(RuntimeConfig.MCPMaxRpcBatchCalls, 64, 8, 256)
local MAX_PARALLEL_COROUTINES = boundedInteger(RuntimeConfig.MCPMaxParallelCoroutines, 64, 4, 256)
local MAX_PUBSUB_HANDLERS_PER_CHANNEL = 32
local MAX_PUBSUB_DISPATCH_QUEUE = 128
local MAX_PUBSUB_WORKERS = 4
local OUTPUT_BUFFER_LIMIT = boundedInteger(RuntimeConfig.MCPOutputBufferLimit, 256, 32, 2048)
local OUTPUT_BATCH_LIMIT = boundedInteger(RuntimeConfig.MCPOutputBatchLimit, 50, 10, 200)
local OUTPUT_MESSAGE_LIMIT = boundedInteger(RuntimeConfig.MCPOutputMessageLimit, 4096, 256, 16384)
local OUTPUT_FLUSH_SECONDS = 0.25
local SCRIPT_OUTPUT_LIMIT = 250
local MAX_INBOUND_FRAME_BYTES = 8 * 1024 * 1024

--==============================================================================--
-- Services (guarded — every executor exposes these, but never assume)
--==============================================================================--

local function safeService(name)
	local ok, service = pcall(function()
		return game:GetService(name)
	end)
	if ok then
		return service
	end
	return nil
end

local HttpService = safeService("HttpService")
local Players = safeService("Players")

assert(HttpService ~= nil, "[connector] HttpService is unavailable; cannot run.")

--==============================================================================--
-- Small guarded helpers around optional executor globals
--==============================================================================--

local function isCallable(value)
	return typeof(value) == "function"
end

-- Probe list of executor functions we advertise as capabilities when present.
local CAPABILITY_PROBES = {
	"getgenv",
	"getrenv",
	"getreg",
	"getgc",
	"getinstances",
	"cloneref",
	"compareinstances",
	"getnilinstances",
	"getloadedmodules",
	"getrunningscripts",
	"getscripts",
	"getsenv",
	"getfenv",
	"getconnections",
	"getcallbackvalue",
	"hookfunction",
	"hookmetamethod",
	"newcclosure",
	"checkcaller",
	"clonefunction",
	"getfunctionhash",
	"iscclosure",
	"islclosure",
	"isexecutorclosure",
	"isfunctionhooked",
	"isnewcclosure",
	"newlclosure",
	"restorefunction",
	"setstackhidden",
	"getconstants",
	"getupvalues",
	"getprotos",
	"setconstant",
	"setupvalue",
	"setfenv",
	"getactors",
	"run_on_actor",
	"getluastate",
	"getgamestate",
	"getactorstates",
	"isparallel",
	"create_comm_channel",
	"get_comm_channel",
	"LuaStateProxy.new",
	"getexecutorname",
	"identifyexecutor",
	"getthreadidentity",
	"setthreadidentity",
	"getrawmetatable",
	"setrawmetatable",
	"setreadonly",
	"isreadonly",
	"getnamecallmethod",
	"getcallingscript",
	"getscriptfromthread",
	"firesignal",
	"fireclickdetector",
	"fireproximityprompt",
	"firetouchinterest",
	"getscriptbytecode",
	"getscriptclosure",
	"getscripthash",
	"decompile",
	"mouse1click",
	"mouse1press",
	"mouse1release",
	"mouse2click",
	"mouse2press",
	"mouse2release",
	"mousemoveabs",
	"mousemoverel",
	"mousescroll",
	"keypress",
	"keyrelease",
	"keyclick",
	"iswindowactive",
	"loadstring",
	"request",
	"WebSocket",
	"getcustomasset",
	"readfile",
	"writefile",
	"isfile",
	"listfiles",
}

local function probeCapabilities()
	local caps = {}
	for _, name in ipairs(CAPABILITY_PROBES) do
		local ok, value = pcall(function()
			return (getfenv and getfenv()[name]) or rawget(getgenv and getgenv() or {}, name)
		end)
		-- Fall back to a direct global lookup if the above could not resolve it.
		if not ok or value == nil then
			ok, value = pcall(function()
				return _G[name]
			end)
		end
		if not ok or value == nil then
			-- Last resort: reference the global directly through a guarded loader.
			ok, value = pcall(function()
				local loader = loadstring and loadstring("return " .. name)
				if loader then
					return loader()
				end
				return nil
			end)
		end
		if ok and isCallable(value) then
			table.insert(caps, name)
		end
	end
	return caps
end

local function detectExecutor()
	if isCallable(identifyexecutor) then
		local ok, name = pcall(identifyexecutor)
		if ok and typeof(name) == "string" and name ~= "" then
			return name
		end
	end
	if isCallable(getexecutorname) then
		local ok, name = pcall(getexecutorname)
		if ok and typeof(name) == "string" and name ~= "" then
			return name
		end
	end
	return nil
end

local function newGuid()
	local ok, guid = pcall(function()
		return HttpService:GenerateGUID(false)
	end)
	if ok and typeof(guid) == "string" then
		return guid
	end
	-- Fallback GUID if GenerateGUID is somehow unavailable.
	return string.format("%08x-%04x-%04x", math.random(0, 0xFFFFFFFF), math.random(0, 0xFFFF), math.random(0, 0xFFFF))
end

--==============================================================================--
-- Handshake
--==============================================================================--

-- Built fresh on every (re)connect so place/job/account are current after teleports.
local function buildHandshake(clientId)
	local userId, username, displayName = nil, nil, nil
	if Players then
		pcall(function()
			local player = Players.LocalPlayer
			if player then
				userId = player.UserId
				username = player.Name
				displayName = player.DisplayName
			end
		end)
	end

	local placeId = nil
	local jobId = nil
	local gameName = nil
	pcall(function()
		placeId = game.PlaceId
		jobId = game.JobId
		gameName = game.Name
	end)

	return {
		clientId = clientId,
		userId = userId,
		username = username,
		displayName = displayName,
		gameName = gameName,
		placeId = placeId,
		jobId = jobId,
		executor = detectExecutor(),
		capabilities = probeCapabilities(),
		-- nil when the operator didn't set getgenv().BridgeToken; server's behavior
		-- depends on whether it was started with a matching ROBLOX_MCP_BRIDGE_TOKEN.
		token = (typeof(BridgeToken) == "string" and BridgeToken ~= "") and BridgeToken or nil,
	}
end

--==============================================================================--
-- JSON value encoding
--
-- The server expects plain JSON. Convert an arbitrary Luau value into a
-- JSON-encodable form: Instances -> "Instance: <FullName>", Roblox datatypes
-- (Vector3, CFrame, Color3, ...) -> tostring, functions -> tostring, tables ->
-- recurse (cycle-guarded, depth/size capped), scalars pass through.
--==============================================================================--

local function encodeString(value, budget)
	local remaining = math.max(0, ENCODE_MAX_TOTAL_STRING_BYTES - budget.stringBytes)
	if remaining == 0 then return "<result-string-budget>" end
	local length = math.min(#value, ENCODE_MAX_STRING_LENGTH, remaining)
	budget.stringBytes = budget.stringBytes + length
	if length < #value then
		return string.sub(value, 1, length) .. "… (truncated)"
	end
	return value
end

local function encodeValue(value, depth, seen, budget)
	budget.nodes = budget.nodes + 1
	if budget.nodes > ENCODE_MAX_TOTAL_NODES then return "<result-node-budget>" end
	local kind = typeof(value)

	if kind == "nil" then
		return nil
	elseif kind == "boolean" or kind == "number" then
		-- JSON cannot represent NaN/inf; coerce to a string so encoding never fails.
		if kind == "number" and (value ~= value or value == math.huge or value == -math.huge) then
			return tostring(value)
		end
		return value
	elseif kind == "string" then
		return encodeString(value, budget)
	elseif kind == "Instance" then
		local ok, full = pcall(function()
			return value:GetFullName()
		end)
		return encodeString("Instance: " .. (ok and full or tostring(value)), budget)
	elseif kind == "function" then
		return encodeString("function: " .. tostring(value), budget)
	elseif kind == "thread" then
		return encodeString("thread: " .. tostring(value), budget)
	elseif kind == "table" then
		if depth >= ENCODE_MAX_DEPTH then
			return "<max-depth>"
		end
		if seen[value] then
			return "<cycle>"
		end
		seen[value] = true

		local result
		-- Decide array vs. map: a table is treated as an array when it has a
		-- contiguous 1..n integer keyspace and no other keys.
		local count = 0
		local isArray = true
		for k in pairs(value) do
			count += 1
			if typeof(k) ~= "number" or k % 1 ~= 0 or k < 1 then
				isArray = false
			end
		end
		if isArray and count > 0 then
			isArray = (count == #value)
		end

		if isArray then
			result = {}
			local n = math.min(#value, ENCODE_MAX_TABLE_ENTRIES)
			for i = 1, n do
				result[i] = encodeValue(value[i], depth + 1, seen, budget)
			end
			if #value > ENCODE_MAX_TABLE_ENTRIES then
				result[n + 1] = "… (truncated)"
			end
		else
			result = {}
			local entries = 0
			for k, v in pairs(value) do
				if entries >= ENCODE_MAX_TABLE_ENTRIES then
					result["…"] = "(truncated)"
					break
				end
				-- JSON object keys must be strings.
				local key
				if typeof(k) == "string" then
					key = string.sub(k, 1, ENCODE_MAX_KEY_LENGTH)
				else
					key = string.sub(tostring(k), 1, ENCODE_MAX_KEY_LENGTH)
				end
				result[key] = encodeValue(v, depth + 1, seen, budget)
				entries += 1
			end
		end

		seen[value] = nil
		return result
	else
		-- Vector3, CFrame, Color3, UDim2, EnumItem, BrickColor, etc.
		return encodeString(tostring(value), budget)
	end
end

local function encodeForJson(value)
	return encodeValue(value, 0, {}, { nodes = 0, stringBytes = 0 })
end

--==============================================================================--
-- Eval op execution
--==============================================================================--

local function applyThreadContext(threadContext)
	if typeof(threadContext) == "number" and isCallable(setthreadidentity) then
		pcall(setthreadidentity, threadContext)
	end
end

--==============================================================================--
-- Persistent VM environment (hidden: held only in this upvalue, never a global,
-- so it stays out of getgenv()/global scans)
--==============================================================================--

-- Base env that VM scripts read through (game, workspace, print, task, ...),
-- captured from the connector's own environment so the VM sees the same globals.
local GLOBAL_ENV = (getfenv and getfenv(1)) or _G

-- Writes (user-defined globals) land here and survive across runs; reads fall
-- through to GLOBAL_ENV. Rebuilt on "vm-reset".
local vmState = nil
local function freshVmEnv()
	local env = {}
	setmetatable(env, { __index = GLOBAL_ENV })
	return env
end
local function getVmEnv()
	if vmState == nil then
		vmState = freshVmEnv()
	end
	return vmState
end

--==============================================================================--
-- mcp.*: in-script tool calls routed over the SAME WebSocket as eval ops.
-- No executor `request()` call, no HTTP, no JSON encode/decode in user space —
-- the running script just calls a Lua function and the connector pushes a frame.
--==============================================================================--

local pendingRpc = {}   -- [id] = { done=false, ok=false, value=nil }
local rpcCounter = 0
local currentSend = nil -- set by runConnection while a socket is alive
-- Output sink set by runConnection: appends a tagged entry into the per-tick
-- flush buffer. Used by both the LogService.MessageOut tap (source="game") and
-- the per-script print/warn wrappers (source="script", scriptToken=...).
local pushOutput = nil
-- Set by runConnection. The script wrappers call markRecentScript(line) right
-- before calling real_print; the LogService tap calls wasRecentlyScripted(line)
-- so we don't emit the same line twice as both "script" and "game".
local markRecentScript = nil
local wasRecentlyScripted = nil

-- Camel-case to kebab-case for mcp.getPlayers -> "get-players".
local function camelToKebab(s)
	if string.find(s, "-", 1, true) then return s end
	local out = string.gsub(s, "%u", function(c) return "-" .. string.lower(c) end)
	if string.sub(out, 1, 1) == "-" then out = string.sub(out, 2) end
	return out
end

-- Block until the server returns an rpc-result for this id, or timeout. Returns
-- the result table { ok, data?, error? } or { ok=false, error=<reason> } on miss.
-- If the bridge disconnects mid-call, our pending entry can be wiped from under
-- us; we re-read `pendingRpc[id]` each tick and treat a nil entry as disconnect.
local function awaitRpc(id, timeoutMs)
	local deadline = os.clock() + (timeoutMs or 30000) / 1000
	while os.clock() < deadline do
		local pending = pendingRpc[id]
		if pending == nil then
			return { ok = false, error = "bridge disconnected mid-call" }
		end
		if pending.done then break end
		task.wait(0.01)
	end
	local pending = pendingRpc[id]
	if pending == nil then
		return { ok = false, error = "bridge disconnected mid-call" }
	end
	pendingRpc[id] = nil
	if not pending.done then
		return { ok = false, error = string.format("mcp call timed out after %dms", timeoutMs or 30000) }
	end
	return pending.value
end

local pendingBatch = {}

-- Cross-game pub/sub: channel name -> array of handler functions registered by
-- in-game scripts via mcp.subscribe. Inbound `pubsub-message` frames dispatch
-- to every handler registered on the channel. Cleared on disconnect.
local pubsubHandlers = {}

-- Block until the server returns an rpc-batch-result, or timeout. Same nil-guard
-- pattern as awaitRpc for the disconnect race.
local function awaitBatch(id, timeoutMs)
	local deadline = os.clock() + (timeoutMs or 60000) / 1000
	while os.clock() < deadline do
		local pending = pendingBatch[id]
		if pending == nil then
			return { ok = false, error = "bridge disconnected mid-batch" }
		end
		if pending.done then break end
		task.wait(0.01)
	end
	local pending = pendingBatch[id]
	if pending == nil then
		return { ok = false, error = "bridge disconnected mid-batch" }
	end
	pendingBatch[id] = nil
	if not pending.done then
		return { ok = false, error = string.format("mcp.all timed out after %dms", timeoutMs or 60000) }
	end
	return { ok = true, results = pending.value or {} }
end

-- Build the `mcp` table that the script sees. Each call pushes an rpc-call frame
-- and yields on the matching reply. Errors as Lua errors so `pcall` works.
local function buildMcpTable(token)
	-- The active coroutine scheduler when running inside `mcp.parallel({fn, ...})`.
	-- A nil value means we're in regular sequential script context; a table value
	-- means call() should yield a marker instead of doing the round-trip itself,
	-- so the scheduler can batch every concurrent function's calls into one
	-- rpc-batch frame.
	local currentScheduler = nil

	-- Split large batches into bounded chunks. This preserves every result while
	-- preventing one mcp.all/parallel round from creating hundreds of host tasks.
	local function dispatchBatch(calls, label)
		local combined = {}
		local first = 1
		while first <= #calls do
			if currentSend == nil then
				return { ok = false, error = label .. ": bridge disconnected before batch dispatch" }
			end
			local chunk = {}
			local last = math.min(#calls, first + MAX_RPC_BATCH_CALLS - 1)
			for index = first, last do chunk[#chunk + 1] = calls[index] end
			rpcCounter = rpcCounter + 1
			local id = "b" .. tostring(rpcCounter)
			pendingBatch[id] = { done = false, value = nil }
			local ok, sent = pcall(function()
				return currentSend({ type = "rpc-batch", id = id, token = token, calls = chunk })
			end)
			if not ok or sent == false then
				pendingBatch[id] = nil
				return { ok = false, error = label .. ": send failed" }
			end
			local outcome = awaitBatch(id, 60000)
			if not outcome.ok then return outcome end
			for _, result in ipairs(outcome.results or {}) do
				combined[#combined + 1] = result
			end
			first = last + 1
		end
		return { ok = true, results = combined }
	end

	local function call(name, args)
		if name == "script" then
			error("mcp.script is disabled (no recursion).", 0)
		end
		-- If this coroutine is registered with a live scheduler, surrender the
		-- call to it: yield with a marker, get the result back on resume.
		if currentScheduler ~= nil then
			local me = coroutine.running()
			if me ~= nil and currentScheduler.threadsByCoro[me] then
				local data, err = coroutine.yield({ tool = name, args = args or {} })
				if err ~= nil then
					error("mcp." .. tostring(name) .. " -> " .. tostring(err), 0)
				end
				return data
			end
		end
		if currentSend == nil then
			error("mcp." .. tostring(name) .. ": bridge socket is not connected.", 0)
		end
		rpcCounter = rpcCounter + 1
		local id = "r" .. tostring(rpcCounter)
		pendingRpc[id] = { done = false, value = nil }
		local ok, sent = pcall(function()
			return currentSend({ type = "rpc-call", id = id, token = token, tool = name, args = args or {} })
		end)
		if not ok or sent == false then
			pendingRpc[id] = nil
			error("mcp." .. tostring(name) .. ": send failed", 0)
		end
		local result = awaitRpc(id, 30000)
		if not result.ok then
			error("mcp." .. tostring(name) .. " -> " .. tostring(result.error), 0)
		end
		return result.data
	end

	-- Run N tool calls in parallel. Pass a table of either:
	--   { key1 = "tool-name",                     key2 = { "tool-name", args } }
	--   { key1 = { tool = "tool-name", args = {} } }
	--   { [1] = "tool-name", [2] = { "tool-name", args } }   -- numeric keys ok
	-- Returns a table keyed identically with either the tool's data on success
	-- or { error = "..." } on failure, so the caller never needs pcall per-entry.
	local function all(spec)
		if type(spec) ~= "table" then
			error("mcp.all: expected a table of calls, got " .. type(spec), 0)
		end
		if currentSend == nil then
			error("mcp.all: bridge socket is not connected.", 0)
		end
		local calls = {}
		local keyOrder = {}
		for k, entry in pairs(spec) do
			local toolName, args
			if type(entry) == "string" then
				toolName = entry
				args = {}
			elseif type(entry) == "table" then
				toolName = entry.tool or entry[1]
				args = entry.args or entry[2] or {}
			else
				error("mcp.all entry for " .. tostring(k) .. " must be a string or table.", 0)
			end
			if type(toolName) ~= "string" then
				error("mcp.all entry for " .. tostring(k) .. " is missing a tool name.", 0)
			end
			local keyStr = tostring(k)
			keyOrder[#keyOrder + 1] = { key = keyStr, original = k }
			calls[#calls + 1] = { key = keyStr, tool = camelToKebab(toolName), args = args }
		end
		if #calls == 0 then return {} end

		local outcome = dispatchBatch(calls, "mcp.all")
		if not outcome.ok then
			error("mcp.all -> " .. tostring(outcome.error), 0)
		end
		-- Map the array of results back onto the user's keys (string OR number).
		local byKey = {}
		for _, r in ipairs(outcome.results) do byKey[r.key] = r end
		local out = {}
		for _, ko in ipairs(keyOrder) do
			local r = byKey[ko.key]
			if r == nil then
				out[ko.original] = { error = "no result for key " .. ko.key }
			elseif r.ok then
				out[ko.original] = r.data
			else
				out[ko.original] = { error = r.error }
			end
		end
		return out
	end

	-- mcp.defer("get-players") (or camelCase) returns a deferred descriptor that
	-- mcp.parallel/mcp.all recognize and batch as a single round-trip. Lets you
	-- write the readable, ergonomic form:
	--   local r = mcp.parallel({
	--     players = mcp.defer("get-players"),
	--     remotes = mcp.defer("search-instances", { className = "RemoteEvent" }),
	--   })
	local function defer(name, args)
		if type(name) ~= "string" then
			error("mcp.defer: tool name must be a string.", 0)
		end
		return { __mcpDeferred = true, tool = camelToKebab(name), args = args or {} }
	end

	-- True coroutine-based parallel: when spec entries are functions, each runs
	-- on its own coroutine; every mcp.* call inside yields a marker; the
	-- scheduler collects markers across all coroutines per round, sends ONE
	-- rpc-batch, resumes each coroutine with its result. Repeats until every
	-- coroutine returns (or errors). Lets you write:
	--   local r = mcp.parallel({
	--     players = function() return mcp.getPlayers() end,
	--     remotes = function() return mcp.searchInstances({ className = "Part" }) end,
	--   })
	-- A single function can make MANY mcp.* calls — they all get batched per
	-- round across every coroutine. Falls back to mcp.all() when no entries are
	-- functions (preserves the deferred-table form).
	local function parallel(spec)
		if type(spec) ~= "table" then
			error("mcp.parallel: expected a table of calls or functions.", 0)
		end
		-- Detect function form.
		local hasFunction = false
		for _, v in pairs(spec) do
			if type(v) == "function" then hasFunction = true; break end
		end
		if not hasFunction then
			return all(spec)
		end

		-- Normalize entries: each gets a coroutine. Non-function entries become
		-- trivial functions that call() the named tool, so mixed forms work too.
		local cos = {}
		for k, v in pairs(spec) do
			if #cos >= MAX_PARALLEL_COROUTINES then
				error(string.format(
					"mcp.parallel: capped at %d coroutines; split this workload into smaller rounds",
					MAX_PARALLEL_COROUTINES
				), 0)
			end
			local fn
			if type(v) == "function" then
				fn = v
			elseif type(v) == "string" then
				fn = function() return call(v, {}) end
			elseif type(v) == "table" then
				local toolName = v.tool or v[1]
				local args = v.args or v[2] or {}
				if type(toolName) ~= "string" then
					error("mcp.parallel entry for " .. tostring(k) .. " has no tool name.", 0)
				end
				fn = function() return call(toolName, args) end
			else
				error("mcp.parallel entry for " .. tostring(k) .. " must be function/string/table.", 0)
			end
			local co = coroutine.create(fn)
			cos[#cos + 1] = {
				key = k,
				co = co,
				pending = nil, -- marker yielded; nil once resumed
				done = false,
				errored = false,
				result = nil,
			}
		end

		-- Set up the scheduler context and remember the previous one so nested
		-- mcp.parallel calls compose cleanly.
		local prevScheduler = currentScheduler
		local thisScheduler = { threadsByCoro = {} }
		for _, c in ipairs(cos) do thisScheduler.threadsByCoro[c.co] = c end
		currentScheduler = thisScheduler

		local terminated = false
		local function setError(c, message)
			c.done = true; c.errored = true; c.result = message; c.pending = nil
		end

		local roundSafety = 0
		while not terminated do
			roundSafety = roundSafety + 1
			if roundSafety > 4096 then
				for _, c in ipairs(cos) do
					if not c.done then setError(c, "mcp.parallel: round cap exceeded (4096)") end
				end
				break
			end
			-- Resume every coroutine that's idle (pending == nil and not done).
			-- A coroutine either dies (done), yields a marker (pending != nil),
			-- or errors (errored). Collect markers from the yielding ones.
			local markers = {}
			for _, c in ipairs(cos) do
				if not c.done and c.pending == nil then
					local ok, value = coroutine.resume(c.co)
					if not ok then
						setError(c, tostring(value))
					elseif coroutine.status(c.co) == "dead" then
						c.done = true; c.result = value
					else
						-- yielded a marker
						if type(value) ~= "table" or type(value.tool) ~= "string" then
							setError(c, "mcp.parallel: coroutine yielded an unrecognized marker; only mcp.* calls may yield here")
						else
							c.pending = value
							markers[#markers + 1] = c
						end
					end
				end
			end
			if #markers == 0 then break end

			-- Dispatch one rpc-batch covering every marker this round.
			if currentSend == nil then
				for _, c in ipairs(markers) do setError(c, "mcp.parallel: bridge disconnected mid-scheduler") end
				break
			end
			local calls = {}
			for i, c in ipairs(markers) do
				calls[i] = { key = "p" .. i, tool = camelToKebab(c.pending.tool), args = c.pending.args }
			end
			local outcome = dispatchBatch(calls, "mcp.parallel")
			if not outcome.ok then
				for _, c in ipairs(markers) do setError(c, outcome.error or "mcp.parallel: batch failed") end
				break
			end
			-- Resume each yielded coroutine with its individual result.
			local byKey = {}
			for _, r in ipairs(outcome.results) do byKey[r.key] = r end
			for i, c in ipairs(markers) do
				local r = byKey["p" .. i]
				local resumeData, resumeErr
				if r and r.ok then
					resumeData = r.data
				else
					resumeErr = (r and r.error) or "no result"
				end
				c.pending = nil
				local ok2, value2 = coroutine.resume(c.co, resumeData, resumeErr)
				if not ok2 then
					setError(c, tostring(value2))
				elseif coroutine.status(c.co) == "dead" then
					c.done = true; c.result = value2
				end
				-- If still suspended (yielded again), next round's pump catches it.
			end
		end

		currentScheduler = prevScheduler

		-- Build keyed result map. Errors come back as { error = "..." }, mirroring
		-- the mcp.all return shape so callers can treat both forms uniformly.
		local out = {}
		for _, c in ipairs(cos) do
			if c.errored then
				out[c.key] = { error = c.result }
			else
				out[c.key] = c.result
			end
		end
		return out
	end

	-- Cross-game pub/sub: publish a payload to every OTHER client subscribed to
	-- the channel. Sender does NOT receive its own message.
	local function publish(channel, payload)
		if type(channel) ~= "string" or channel == "" then
			error("mcp.publish: channel must be a non-empty string.", 0)
		end
		if currentSend == nil then
			error("mcp.publish: bridge socket is not connected.", 0)
		end
		if currentSend({ type = "pubsub-publish", channel = channel, payload = payload }) == false then
			error("mcp.publish: send failed", 0)
		end
	end
	-- Subscribe to a channel; `handler` is called with (payload, fromClientId)
	-- when another client publishes. Returns an unsubscribe function. Multiple
	-- handlers per channel are supported.
	local function subscribe(channel, handler)
		if type(channel) ~= "string" or channel == "" then
			error("mcp.subscribe: channel must be a non-empty string.", 0)
		end
		if type(handler) ~= "function" then
			error("mcp.subscribe: handler must be a function.", 0)
		end
		if currentSend == nil then
			error("mcp.subscribe: bridge socket is not connected.", 0)
		end
		local list = pubsubHandlers[channel]
		if list == nil then
			list = {}
			pubsubHandlers[channel] = list
			currentSend({ type = "pubsub-subscribe", channel = channel })
		end
		if #list >= MAX_PUBSUB_HANDLERS_PER_CHANNEL then
			error(string.format(
				"mcp.subscribe: channel handler cap reached (%d)",
				MAX_PUBSUB_HANDLERS_PER_CHANNEL
			), 0)
		end
		list[#list + 1] = handler
		-- Returned unsubscribe drops just this handler; if it's the last, also
		-- send pubsub-unsubscribe so the server stops routing to us.
		return function()
			local entries = pubsubHandlers[channel]
			if entries == nil then return end
			for i = #entries, 1, -1 do
				if entries[i] == handler then table.remove(entries, i) end
			end
			if #entries == 0 then
				pubsubHandlers[channel] = nil
				if currentSend then
					currentSend({ type = "pubsub-unsubscribe", channel = channel })
				end
			end
		end
	end

	-- mcp.help(name?) — Luau-side convenience for `tool-schema`. Accepts a
	-- string name, a table { name=, search=, category= }, or no argument.
	-- Returns the raw structured response (so a script can inspect it
	-- programmatically); kebab-ifies a camelCase name so `mcp.help("getPlayers")`
	-- and `mcp.help("get-players")` both work.
	local function help(name)
		local args = {}
		if type(name) == "string" then
			args.name = camelToKebab(name)
		elseif type(name) == "table" then
			for k, v in pairs(name) do args[k] = v end
			if type(args.name) == "string" then args.name = camelToKebab(args.name) end
		end
		return call("tool-schema", args)
	end

	return setmetatable({
		call = function(name, args) return call(name, args) end,
		all = all,
		parallel = parallel,
		defer = defer,
		publish = publish,
		subscribe = subscribe,
		help = help,
	}, {
		__index = function(_, key)
			local name = camelToKebab(key)
			return function(args) return call(name, args) end
		end,
	})
end

-- Run a single eval op and return an OpResult-shaped table:
--   { ok = true, value = <encoded first return value> }
--   { ok = false, error = <message>, kind = "runtime" | "timeout" }
local function truncateText(value, limit)
	local text = tostring(value)
	if #text <= limit then return text end
	return string.sub(text, 1, math.max(1, limit - 18)) .. "... [truncated]"
end

local function runEval(op, isConnectionAlive)
	local source = op.source

	-- Wipe the persistent VM environment and return immediately.
	if op.env == "vm-reset" then
		vmState = freshVmEnv()
		return { ok = true, value = { reset = true } }
	end

	if typeof(source) ~= "string" then
		return { ok = false, error = "eval op missing string 'source'.", kind = "runtime" }
	end

	if not isCallable(loadstring) then
		return { ok = false, error = "Executor does not support loadstring.", kind = "runtime" }
	end

	local fn, compileErr = loadstring(source)
	if not fn then
		return { ok = false, error = "compile error: " .. tostring(compileErr), kind = "runtime" }
	end

	-- Script-tool mode: build a per-run env with `mcp` and captured print/warn,
	-- layered over the persistent VM env (writes there land back in the VM env so
	-- user globals still survive across runs).
	local scriptOutput = nil
	local scriptOutputDropped = 0
	if typeof(op.scriptToken) == "string" and op.scriptToken ~= "" then
		local baseEnv = (op.env == "vm") and getVmEnv() or freshVmEnv()
		scriptOutput = {}
		local mcp = buildMcpTable(op.scriptToken)
		local realPrint, realWarn = GLOBAL_ENV.print, GLOBAL_ENV.warn
		local function cap(real, kind)
			return function(...)
				local n = select("#", ...)
				local parts = (table.create and table.create(n)) or {}
				for i = 1, n do parts[i] = tostring((select(i, ...))) end
				local line = truncateText(table.concat(parts, "\t"), OUTPUT_MESSAGE_LIMIT)
				if #scriptOutput < SCRIPT_OUTPUT_LIMIT then
					scriptOutput[#scriptOutput + 1] = line
					-- Also push as a tagged frame so the dashboard can filter this run.
					if pushOutput then
						pushOutput({
							kind = kind,
							message = line,
							source = "script",
							scriptToken = op.scriptToken,
						})
					end
					if markRecentScript then markRecentScript(line) end
					pcall(real, ...)
				else
					scriptOutputDropped = scriptOutputDropped + 1
					if scriptOutputDropped == 1 then
						local notice = string.format("[connector] script output capped at %d lines", SCRIPT_OUTPUT_LIMIT)
						scriptOutput[SCRIPT_OUTPUT_LIMIT] = notice
						if pushOutput then
							pushOutput({ kind = "warn", message = notice, source = "script", scriptToken = op.scriptToken })
						end
						if markRecentScript then markRecentScript(notice) end
						pcall(real, notice)
					end
				end
			end
		end
		local runEnv = setmetatable(
			{ print = cap(realPrint, "print"), warn = cap(realWarn, "warn"), mcp = mcp },
			{ __index = baseEnv, __newindex = baseEnv }
		)
		pcall(function()
			if isCallable(setfenv) then setfenv(fn, runEnv) end
		end)
	-- Persistent VM: run inside the reusable sandbox so globals survive across runs.
	elseif op.env == "vm" then
		pcall(function()
			if isCallable(setfenv) then
				setfenv(fn, getVmEnv())
			end
		end)
	end

	local timeoutMs = op.timeoutMs
	local hasTimeout = typeof(timeoutMs) == "number" and timeoutMs > 0
	local deadline = hasTimeout and (os.clock() + timeoutMs / 1000) or nil

	-- Execute on a dedicated thread so a long-running op can be observed against
	-- the deadline and abandoned (cancelled) on timeout without blocking us.
	local finished = false
	local succeeded = false
	local firstValue = nil
	local runErr = nil

	local worker = task.spawn(function()
		applyThreadContext(op.threadContext)
		local ok, ret = pcall(function()
			-- Capture only the FIRST returned value, per the protocol contract.
			return (fn())
		end)
		succeeded = ok
		if ok then
			firstValue = ret
		else
			runErr = ret
		end
		finished = true
	end)

	if deadline then
		while not finished and os.clock() < deadline do
			if isConnectionAlive and not isConnectionAlive() then
				pcall(task.cancel, worker)
				return { ok = false, error = "bridge disconnected during execution.", kind = "runtime" }
			end
			task.wait(0.02)
		end
		if not finished then
			pcall(task.cancel, worker)
			return {
				ok = false,
				error = string.format("execution exceeded %dms timeout.", math.floor(timeoutMs)),
				kind = "timeout",
			}
		end
	else
		-- No deadline: yield until the worker resolves.
		while not finished do
			if isConnectionAlive and not isConnectionAlive() then
				pcall(task.cancel, worker)
				return { ok = false, error = "bridge disconnected during execution.", kind = "runtime" }
			end
			task.wait(0.02)
		end
	end

	if not succeeded then
		-- In script-tool mode, a runtime error is still returned as a regular value
		-- so the AI sees its captured output alongside the failure.
		if scriptOutput ~= nil then
			local pkOk, pkValue = pcall(encodeForJson, {
				error = "runtime error: " .. tostring(runErr),
				output = scriptOutput,
				outputDropped = scriptOutputDropped,
			})
			if pkOk then
				return { ok = true, value = pkValue }
			end
			-- Encode failed (e.g. weird output entry): keep error path so the AI
			-- sees the original failure rather than the encoder's complaint.
			return { ok = false, error = "runtime error: " .. tostring(runErr), kind = "runtime" }
		end
		return { ok = false, error = tostring(runErr), kind = "runtime" }
	end

	-- Script-tool mode: package the user's return value with the captured output.
	if scriptOutput ~= nil then
		local pkOk, pkValue = pcall(encodeForJson, {
			result = firstValue,
			output = scriptOutput,
			outputDropped = scriptOutputDropped,
		})
		if pkOk then
			return { ok = true, value = pkValue }
		end
		-- Result wasn't encodable; retry with just the output so the AI still
		-- gets its captured prints rather than a confusing string-of-error.
		local fbOk, fbValue = pcall(encodeForJson, { output = scriptOutput, encodeError = tostring(pkValue) })
		if fbOk then
			return { ok = true, value = fbValue }
		end
		return { ok = false, error = "failed to encode result: " .. tostring(pkValue), kind = "runtime" }
	end

	-- Encode the captured value defensively: a bad encoder/serializer must not
	-- turn a successful eval into a thrown error that kills the connector.
	local encodeOk, encoded = pcall(encodeForJson, firstValue)
	if not encodeOk then
		return { ok = false, error = "failed to encode result: " .. tostring(encoded), kind = "runtime" }
	end

	return { ok = true, value = encoded }
end

--==============================================================================--
-- Connection
--==============================================================================--

local function jsonEncode(value)
	local ok, encoded = pcall(function()
		return HttpService:JSONEncode(value)
	end)
	if ok then
		return encoded
	end
	return nil
end

local function jsonDecode(text)
	local ok, decoded = pcall(function()
		return HttpService:JSONDecode(text)
	end)
	if ok then
		return decoded
	end
	return nil
end

-- Open a WebSocket to the bridge with a bounded wait; returns the socket or nil.
local function connectSocket()
	if typeof(WebSocket) ~= "table" and typeof(WebSocket) ~= "userdata" then
		return nil, "Executor does not expose a WebSocket global."
	end
	if not isCallable(WebSocket.connect) then
		return nil, "WebSocket.connect is unavailable."
	end

	local url = "ws://" .. BridgeURL .. "/bridge"
	local socket = nil
	local connectErr = nil
	local done = false

	local thread = task.spawn(function()
		local ok, result = pcall(function()
			return WebSocket.connect(url)
		end)
		if ok then
			socket = result
		else
			connectErr = result
		end
		done = true
	end)

	local deadline = os.clock() + 5
	while not done and os.clock() < deadline do
		task.wait(0.05)
	end

	if not done then
		pcall(task.cancel, thread)
		return nil, "WebSocket connection timed out."
	end
	if socket == nil then
		return nil, "WebSocket connection failed: " .. tostring(connectErr)
	end
	return socket, nil
end

-- A live connection. Runs the hello handshake, dispatches inbound messages, and
-- returns once the socket closes so the outer loop can reconnect.
local function runConnection()
	local socket, err = connectSocket()
	if not socket then
		return false, err
	end

	local clientId = newGuid()
	local connected = true

	local function send(message)
		if not connected then
			return false
		end
		local payload = jsonEncode(message)
		if payload == nil then
			return false
		end
		local ok = pcall(function()
			socket:Send(payload)
		end)
		if not ok then
			connected = false
			return false
		end
		return true
	end
	-- Expose this connection's send to module-level features (mcp.* RPC).
	currentSend = send

	-- Bounded eval scheduler. Normal calls share a small worker pool; a parent
	-- script runs exclusively in the normal lane while one slot stays reserved
	-- for the nested mcp.* evals it is waiting on.
	local evalQueue = {}
	local evalQueuedBytes = 0
	local evalActive = 0
	local activeScriptParents = 0
	local pumpingEvals = false
	local pumpEvalQueue

	local function isScriptParent(job)
		return job.op.priority ~= "nested"
			and typeof(job.op.scriptToken) == "string"
			and job.op.scriptToken ~= ""
	end

	local function nextEvalIndex()
		if evalActive >= MAX_CONCURRENT_EVALS then return nil end
		for index, job in ipairs(evalQueue) do
			if job.op.priority == "nested" then return index end
		end
		if activeScriptParents > 0 then return nil end
		for index, job in ipairs(evalQueue) do
			if isScriptParent(job) then
				if evalActive <= MAX_CONCURRENT_EVALS - 2 then return index end
				return nil
			end
		end
		return #evalQueue > 0 and 1 or nil
	end

	pumpEvalQueue = function()
		if pumpingEvals or not connected then return end
		pumpingEvals = true
		while connected and evalActive < MAX_CONCURRENT_EVALS do
			local index = nextEvalIndex()
			if index == nil then break end
			local job = table.remove(evalQueue, index)
			if job == nil then break end
			evalQueuedBytes = math.max(0, evalQueuedBytes - job.sourceBytes)
			local elapsedMs = math.max(0, (os.clock() - job.enqueuedAt) * 1000)
			local originalTimeout = tonumber(job.op.timeoutMs) or 30000
			if elapsedMs >= originalTimeout then
				send({
					type = "result",
					id = job.id,
					result = { ok = false, error = "eval expired in connector queue", kind = "timeout" },
				})
			else
				job.op.timeoutMs = math.max(1, math.floor(originalTimeout - elapsedMs))
				evalActive = evalActive + 1
				local parent = isScriptParent(job)
				if parent then activeScriptParents = activeScriptParents + 1 end
				task.spawn(function()
					local ok, result = pcall(runEval, job.op, function() return connected end)
					if not ok then
						result = { ok = false, error = "connector eval guard: " .. tostring(result), kind = "runtime" }
					end
					if connected then send({ type = "result", id = job.id, result = result }) end
					evalActive = math.max(0, evalActive - 1)
					if parent then activeScriptParents = math.max(0, activeScriptParents - 1) end
					pumpEvalQueue()
				end)
			end
		end
		pumpingEvals = false
	end

	local function enqueueEval(id, op)
		local priority = op.priority == "nested" and "nested" or "normal"
		op.priority = priority
		local sourceBytes = typeof(op.source) == "string" and #op.source or 0
		local queueLimit = priority == "nested"
			and MAX_QUEUED_EVALS
			or math.max(1, MAX_QUEUED_EVALS - NESTED_QUEUE_RESERVE)
		local byteLimit = priority == "nested"
			and MAX_QUEUED_SOURCE_BYTES
			or math.floor(MAX_QUEUED_SOURCE_BYTES * 0.75)
		if #evalQueue >= queueLimit or evalQueuedBytes + sourceBytes > byteLimit then
			send({
				type = "result",
				id = id,
				result = {
					ok = false,
					error = string.format(
						"connector eval queue is full (%d active, %d queued); reduce parallel fan-out",
						evalActive,
						#evalQueue
					),
					kind = "overloaded",
				},
			})
			return
		end
		evalQueue[#evalQueue + 1] = {
			id = id,
			op = op,
			sourceBytes = sourceBytes,
			enqueuedAt = os.clock(),
		}
		evalQueuedBytes = evalQueuedBytes + sourceBytes
		pumpEvalQueue()
	end

	-- Pub/sub callbacks are user code and may yield forever, so dispatch them
	-- through another bounded pool instead of spawning one thread per callback.
	local pubsubQueue = {}
	local pubsubActive = 0
	local pumpingPubsub = false
	local pumpPubsub
	pumpPubsub = function()
		if pumpingPubsub or not connected then return end
		pumpingPubsub = true
		while connected and pubsubActive < MAX_PUBSUB_WORKERS and #pubsubQueue > 0 do
			local job = table.remove(pubsubQueue, 1)
			pubsubActive = pubsubActive + 1
			task.spawn(function()
				pcall(job.fn, job.payload, job.fromClientId)
				pubsubActive = math.max(0, pubsubActive - 1)
				pumpPubsub()
			end)
		end
		pumpingPubsub = false
	end
	local function enqueuePubsub(fn, payload, fromClientId)
		if #pubsubQueue >= MAX_PUBSUB_DISPATCH_QUEUE then return end
		pubsubQueue[#pubsubQueue + 1] = { fn = fn, payload = payload, fromClientId = fromClientId }
		pumpPubsub()
	end

	-- Dispatch one decoded inbound message. Always pcall-guarded by the caller.
	local function handleMessage(message)
		if typeof(message) ~= "table" or message.type == nil then
			return
		end

		local mtype = message.type

		if mtype == "welcome" then
			warn(string.format(
				"[connector] bridge ready (server %s, heartbeat %sms).",
				tostring(message.serverVersion),
				tostring(message.heartbeatIntervalMs)
			))
			return
		elseif mtype == "ping" then
			send({ type = "pong", id = message.id })
			return
		elseif mtype == "op" then
			local op = message.op
			local id = message.id
			if typeof(op) ~= "table" then
				send({ type = "result", id = id, result = { ok = false, error = "op missing body.", kind = "runtime" } })
				return
			end
			if op.kind == "eval" then
				enqueueEval(id, op)
			else
				send({
					type = "result",
					id = id,
					result = { ok = false, error = "unsupported op kind: " .. tostring(op.kind), kind = "runtime" },
				})
			end
			return
		elseif mtype == "rpc-result" then
			-- A script-in-flight is awaiting this id; resolve its pending entry.
			local pending = pendingRpc[message.id]
			if pending ~= nil then
				pending.value = message.result
				pending.done = true
			end
			return
		elseif mtype == "rpc-batch-result" then
			-- A script's mcp.all() is awaiting this batch; resolve it.
			local pending = pendingBatch[message.id]
			if pending ~= nil then
				pending.value = message.results
				pending.done = true
			end
			return
		elseif mtype == "pubsub-message" then
			-- Fanout through the bounded callback pool so user handlers cannot
			-- create an unbounded task storm.
			local frame = message.frame or {}
			local list = pubsubHandlers[frame.channel]
			if list ~= nil then
				for _, fn in ipairs(list) do
					enqueuePubsub(fn, frame.payload, frame.fromClientId)
				end
			end
			return
		end
		-- Unknown message types are ignored (forward-compatible).
	end

	-- Signal callbacks already run independently in Roblox. Handling is kept
	-- constant-time: evals and pub/sub user code are only enqueued here.
	pcall(function()
		socket.OnMessage:Connect(function(raw)
			if typeof(raw) == "string" and #raw > MAX_INBOUND_FRAME_BYTES then return end
			local decoded = jsonDecode(raw)
			if decoded == nil then return end
			pcall(handleMessage, decoded)
		end)
	end)

	pcall(function()
		socket.OnClose:Connect(function()
			connected = false
		end)
	end)

	-- Send the handshake immediately after wiring handlers.
	send({ type = "hello", protocolVersion = PROTOCOL_VERSION, client = buildHandshake(clientId) })

	-- Output streaming: tap LogService.MessageOut (captures every print/warn/error
	-- in the game, including from VM scripts) and flush batched lines to the server.
	-- Best-effort and fully guarded; a failure here never affects the connection.
	local outBuf = {}
	local outHead, outTail, outSize, outDropped = 1, 0, 0, 0
	local outConn = nil
	local streamOutput = RuntimeConfig.MCPStreamOutput ~= false
	local function appendOutput(entry)
		if not streamOutput or entry == nil then return end
		if outSize >= OUTPUT_BUFFER_LIMIT then
			outDropped = outDropped + 1
			return
		end
		entry.message = truncateText(entry.message or "", OUTPUT_MESSAGE_LIMIT)
		outTail = (outTail % OUTPUT_BUFFER_LIMIT) + 1
		outBuf[outTail] = entry
		outSize = outSize + 1
	end
	local function takeOutputBatch()
		local batch = {}
		local count = math.min(outSize, OUTPUT_BATCH_LIMIT)
		for _ = 1, count do
			batch[#batch + 1] = outBuf[outHead]
			outBuf[outHead] = nil
			outHead = (outHead % OUTPUT_BUFFER_LIMIT) + 1
			outSize = outSize - 1
		end
		return batch
	end
	-- Expose a module-visible appender so the per-script print/warn wrappers can
	-- also feed this buffer (with source="script" + scriptToken metadata).
	pushOutput = function(entry)
		appendOutput(entry)
	end
	-- Tiny rolling buffer of recently script-emitted lines, keyed by message
	-- text + os.clock(). The LogService tap fires for the real_print() that the
	-- script wrapper makes immediately after pushing its tagged frame, so we
	-- drop the LogService duplicate if it lands within a short window.
	local recentScript, recentTail = {}, 0
	markRecentScript = function(line)
		recentTail = recentTail + 1
		recentScript[recentTail] = { msg = line, t = os.clock() }
		-- Keep the buffer small; entries older than the dedup window are useless.
		if recentTail > 32 then
			local cutoff = recentTail - 32
			for k, _ in pairs(recentScript) do if k <= cutoff then recentScript[k] = nil end end
		end
	end
	wasRecentlyScripted = function(line)
		local now = os.clock()
		for k, e in pairs(recentScript) do
			if now - e.t > 0.5 then
				recentScript[k] = nil
			elseif e.msg == line then
				recentScript[k] = nil -- consume so identical-but-distinct lines aren't all eaten
				return true
			end
		end
		return false
	end
	pcall(function()
		if not streamOutput then return end
		local LogService = safeService("LogService")
		if LogService == nil then
			return
		end
		local kindOf = {}
		pcall(function()
			kindOf[Enum.MessageType.MessageOutput] = "print"
			kindOf[Enum.MessageType.MessageInfo] = "info"
			kindOf[Enum.MessageType.MessageWarning] = "warn"
			kindOf[Enum.MessageType.MessageError] = "error"
		end)
		-- Fallback when the Enum probe failed (kindOf empty): scan the Name so
		-- errors/warnings don't silently get tagged as "print".
		local function classify(messageType)
			local kind = kindOf[messageType]
			if kind then return kind end
			local ok, name = pcall(tostring, messageType)
			if ok and typeof(name) == "string" then
				if string.find(name, "Error") then return "error" end
				if string.find(name, "Warning") then return "warn" end
				if string.find(name, "Info") then return "info" end
			end
			return "print"
		end
		outConn = LogService.MessageOut:Connect(function(message, messageType)
			local text = truncateText(message, OUTPUT_MESSAGE_LIMIT)
			-- Skip the LogService duplicate when a script wrapper just emitted
			-- the same line as a tagged "script" frame.
			if wasRecentlyScripted and wasRecentlyScripted(text) then return end
			appendOutput({
				kind = classify(messageType),
				message = text,
				source = "game",
			})
		end)
	end)

	-- Block until the socket closes. Flush a fixed-size slice at a modest rate;
	-- a chatty game cannot monopolize JSON encoding or WebSocket bandwidth.
	while connected do
		task.wait(OUTPUT_FLUSH_SECONDS)
		if outSize > 0 or outDropped > 0 then
			local batch = takeOutputBatch()
			local dropped = outDropped
			outDropped = 0
			if not send({
				type = "event",
				channel = "output",
				data = { entries = batch, dropped = dropped },
			}) then
				break
			end
		end
	end

	pcall(function()
		if outConn then
			outConn:Disconnect()
		end
	end)

	-- Reject any RPC calls left in flight so awaiting scripts unblock instead of hanging.
	currentSend = nil
	pushOutput = nil
	markRecentScript = nil
	wasRecentlyScripted = nil
	evalQueue = {}
	pubsubQueue = {}
	-- Drop pubsub handlers so a reconnect starts clean and stale handlers do not
	-- fire against a different game.
	pubsubHandlers = {}
	-- Wake any mcp.all() awaiters with a clean disconnected outcome.
	for id, pending in pairs(pendingBatch) do
		pending.value = pending.value or {}
		pending.done = true
		pendingBatch[id] = nil
	end
	for id, pending in pairs(pendingRpc) do
		pending.value = { ok = false, error = "bridge disconnected" }
		pending.done = true
		pendingRpc[id] = nil
	end

	pcall(function()
		socket:Close()
	end)

	return true, nil
end

--==============================================================================--
-- Main loop: reconnect forever with capped exponential backoff + jitter.
--==============================================================================--

local function main()
	local delay = RECONNECT_BASE_DELAY
	while true do
		local ok, closedCleanly, connErr = pcall(runConnection)

		if ok and closedCleanly then
			-- Connected then closed: reset backoff and retry quickly.
			delay = RECONNECT_BASE_DELAY
		else
			local reason
			if not ok then
				reason = tostring(closedCleanly) -- pcall error payload
			else
				reason = tostring(connErr)
			end
			local jitter = math.random() * (delay * 0.25)
			local waitTime = delay + jitter
			warn(string.format(
				"[connector] not connected to bridge at %s/bridge — retrying in %.1fs. Reason: %s",
				BridgeURL,
				waitTime,
				reason
			))
			task.wait(waitTime)
			delay = math.min(delay * 2, RECONNECT_MAX_DELAY)
		end

		task.wait(0.25)
	end
end

main()
