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

	-- Persistent VM: run inside the reusable sandbox so globals survive across runs.
	if op.env == "vm" then
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
		return { ok = false, error = tostring(runErr), kind = "runtime" }
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
		outConn = LogService.MessageOut:Connect(function(message, messageType)
			if #outBuf < 500 then
				outBuf[#outBuf + 1] = { kind = kindOf[messageType] or "print", message = tostring(message) }
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
