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
		- Every inbound op runs inside pcall on its own task.spawn'd thread, so one bad
		  op can never kill the socket or block sibling ops.
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

local BridgeURL = getgenv().BridgeURL or "localhost:16384"
-- Optional shared secret. When the server is started with
-- ROBLOX_MCP_BRIDGE_TOKEN set, the connector must send this exact string or the
-- bridge closes the socket. Leave nil/empty when the server runs unauthenticated.
local BridgeToken = getgenv().BridgeToken
local PROTOCOL_VERSION = 1

-- Reconnect backoff bounds (seconds).
local RECONNECT_BASE_DELAY = 1
local RECONNECT_MAX_DELAY = 30

-- Value-encoding guards: keep a pathological return value from producing a giant
-- or infinite payload.
local ENCODE_MAX_DEPTH = 6
local ENCODE_MAX_TABLE_ENTRIES = 1000
local ENCODE_MAX_STRING_LENGTH = 50000

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
	"getnilinstances",
	"getloadedmodules",
	"getrunningscripts",
	"getscripts",
	"getconnections",
	"getcallbackvalue",
	"hookfunction",
	"hookmetamethod",
	"newcclosure",
	"checkcaller",
	"clonefunction",
	"getfunctionhash",
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
	"firesignal",
	"fireclickdetector",
	"fireproximityprompt",
	"firetouchinterest",
	"getscriptbytecode",
	"getscriptclosure",
	"decompile",
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
	pcall(function()
		placeId = game.PlaceId
		jobId = game.JobId
	end)

	return {
		clientId = clientId,
		userId = userId,
		username = username,
		displayName = displayName,
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

local function encodeValue(value, depth, seen)
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
		if #value > ENCODE_MAX_STRING_LENGTH then
			return string.sub(value, 1, ENCODE_MAX_STRING_LENGTH) .. "… (truncated)"
		end
		return value
	elseif kind == "Instance" then
		local ok, full = pcall(function()
			return value:GetFullName()
		end)
		return "Instance: " .. (ok and full or tostring(value))
	elseif kind == "function" then
		return "function: " .. tostring(value)
	elseif kind == "thread" then
		return "thread: " .. tostring(value)
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
				result[i] = encodeValue(value[i], depth + 1, seen)
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
					key = k
				else
					key = tostring(k)
				end
				result[key] = encodeValue(v, depth + 1, seen)
				entries += 1
			end
		end

		seen[value] = nil
		return result
	else
		-- Vector3, CFrame, Color3, UDim2, EnumItem, BrickColor, etc.
		return tostring(value)
	end
end

local function encodeForJson(value)
	return encodeValue(value, 0, {})
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
	local function call(name, args)
		if currentSend == nil then
			error("mcp." .. tostring(name) .. ": bridge socket is not connected.", 0)
		end
		if name == "script" then
			error("mcp.script is disabled (no recursion).", 0)
		end
		rpcCounter = rpcCounter + 1
		local id = "r" .. tostring(rpcCounter)
		pendingRpc[id] = { done = false, value = nil }
		local ok, sendErr = pcall(function()
			currentSend({ type = "rpc-call", id = id, token = token, tool = name, args = args or {} })
		end)
		if not ok then
			pendingRpc[id] = nil
			error("mcp." .. tostring(name) .. ": send failed: " .. tostring(sendErr), 0)
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

		rpcCounter = rpcCounter + 1
		local id = "b" .. tostring(rpcCounter)
		pendingBatch[id] = { done = false, value = nil }
		local ok, sendErr = pcall(function()
			currentSend({ type = "rpc-batch", id = id, token = token, calls = calls })
		end)
		if not ok then
			pendingBatch[id] = nil
			error("mcp.all: send failed: " .. tostring(sendErr), 0)
		end
		local outcome = awaitBatch(id, 60000)
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

	-- Cross-game pub/sub: publish a payload to every OTHER client subscribed to
	-- the channel. Sender does NOT receive its own message.
	local function publish(channel, payload)
		if type(channel) ~= "string" or channel == "" then
			error("mcp.publish: channel must be a non-empty string.", 0)
		end
		if currentSend == nil then
			error("mcp.publish: bridge socket is not connected.", 0)
		end
		currentSend({ type = "pubsub-publish", channel = channel, payload = payload })
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

	return setmetatable({
		call = function(name, args) return call(name, args) end,
		all = all,
		parallel = all, -- ergonomic alias
		defer = defer,
		publish = publish,
		subscribe = subscribe,
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
local function runEval(op)
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
				local line = table.concat(parts, "\t")
				if #scriptOutput < 1000 then
					scriptOutput[#scriptOutput + 1] = line
				end
				-- Also push as a tagged frame so the dashboard Output tab can
				-- filter to this specific script run (scriptToken-scoped). The
				-- LogService tap below will fire for the real_print call we make
				-- on the next line — markRecentScript marks this exact message
				-- so the tap can skip the duplicate.
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
			task.wait(0.02)
		end
	end

	if not succeeded then
		-- In script-tool mode, a runtime error is still returned as a regular value
		-- so the AI sees its captured output alongside the failure.
		if scriptOutput ~= nil then
			local pkOk, pkValue = pcall(encodeForJson, { error = "runtime error: " .. tostring(runErr), output = scriptOutput })
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
		local pkOk, pkValue = pcall(encodeForJson, { result = firstValue, output = scriptOutput })
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
			return
		end
		local payload = jsonEncode(message)
		if payload == nil then
			return
		end
		pcall(function()
			socket:Send(payload)
		end)
	end
	-- Expose this connection's send to module-level features (mcp.* RPC).
	currentSend = send

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
				local result = runEval(op)
				send({ type = "result", id = id, result = result })
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
			-- Fanout to every handler registered on this channel; each runs on
			-- its own task.spawn so a slow/blocking handler can't stall the
			-- socket reader or other handlers.
			local frame = message.frame or {}
			local list = pubsubHandlers[frame.channel]
			if list ~= nil then
				for _, fn in ipairs(list) do
					task.spawn(function() pcall(fn, frame.payload, frame.fromClientId) end)
				end
			end
			return
		end
		-- Unknown message types are ignored (forward-compatible).
	end

	-- Wire up message handling: each message runs on its own thread so handling
	-- is concurrent and a slow/blocking op never stalls the socket reader.
	pcall(function()
		socket.OnMessage:Connect(function(raw)
			task.spawn(function()
				local decoded = jsonDecode(raw)
				if decoded == nil then
					return
				end
				pcall(handleMessage, decoded)
			end)
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
	local outConn = nil
	-- Expose a module-visible appender so the per-script print/warn wrappers can
	-- also feed this buffer (with source="script" + scriptToken metadata).
	pushOutput = function(entry)
		if entry and #outBuf < 500 then
			outBuf[#outBuf + 1] = entry
		end
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
			local text = tostring(message)
			-- Skip the LogService duplicate when a script wrapper just emitted
			-- the same line as a tagged "script" frame.
			if wasRecentlyScripted and wasRecentlyScripted(text) then return end
			if #outBuf < 500 then
				outBuf[#outBuf + 1] = {
					kind = classify(messageType),
					message = text,
					source = "game",
				}
			end
		end)
	end)

	-- Block until the socket closes, flushing buffered output ~10x/second.
	while connected do
		task.wait(0.1)
		if #outBuf > 0 then
			local batch = outBuf
			outBuf = {}
			send({ type = "event", channel = "output", data = { entries = batch } })
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
	-- Drop pubsub handlers so a reconnect starts clean and stale handlers do not
	-- fire against a different game.
	pubsubHandlers = {}
	-- Wake any mcp.all() awaiters with a clean disconnected outcome.
	for _, pending in pairs(pendingBatch) do
		pending.value = pending.value or {}
		pending.done = true
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
