-- Box ESP — draws a 2D box around every other player's character.
-- Re-running this script replaces the previous instance cleanly.
--
-- API (after running):
--   getgenv().BoxESP.Enabled = false     -- hide all boxes without unloading
--   getgenv().BoxESP.Color = Color3.new()-- change box color live
--   getgenv().BoxESP.MaxDistance = 500   -- studs; 0 = unlimited
--   getgenv().BoxESP.Unload()            -- disconnect + remove everything

if getgenv().BoxESP then
	pcall(getgenv().BoxESP.Unload)
end

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")

local LocalPlayer = Players.LocalPlayer

local ESP = {
	Enabled = true,
	Color = Color3.fromRGB(255, 64, 64),
	Thickness = 1.5,
	MaxDistance = 0, -- studs; 0 = unlimited
}

local boxes = {} -- [Player] = Drawing Square
local connections = {}

local function createBox(player)
	if boxes[player] then return end
	local box = Drawing.new("Square")
	box.Visible = false
	box.Color = ESP.Color
	box.Thickness = ESP.Thickness
	box.Filled = false
	boxes[player] = box
end

local function removeBox(player)
	local box = boxes[player]
	if box then
		boxes[player] = nil
		pcall(function() box:Remove() end)
	end
end

for _, player in ipairs(Players:GetPlayers()) do
	if player ~= LocalPlayer then
		createBox(player)
	end
end

table.insert(connections, Players.PlayerAdded:Connect(function(player)
	if player ~= LocalPlayer then
		createBox(player)
	end
end))

table.insert(connections, Players.PlayerRemoving:Connect(removeBox))

table.insert(connections, RunService.RenderStepped:Connect(function()
	local camera = workspace.CurrentCamera
	if not camera then return end

	for player, box in pairs(boxes) do
		local visible = false

		if ESP.Enabled then
			local character = player.Character
			local root = character and character:FindFirstChild("HumanoidRootPart")
			local humanoid = character and character:FindFirstChildOfClass("Humanoid")

			if root and humanoid and humanoid.Health > 0 then
				local rootPos, onScreen = camera:WorldToViewportPoint(root.Position)
				if onScreen then
					local distance = (camera.CFrame.Position - root.Position).Magnitude
					if ESP.MaxDistance <= 0 or distance <= ESP.MaxDistance then
						-- Project head-to-feet to size the box; width is half the height,
						-- which matches R6/R15 proportions closely enough for an outline.
						local top = camera:WorldToViewportPoint(root.Position + Vector3.new(0, 3, 0))
						local bottom = camera:WorldToViewportPoint(root.Position - Vector3.new(0, 3, 0))
						local height = math.abs(top.Y - bottom.Y)
						local width = height / 2

						box.Size = Vector2.new(width, height)
						box.Position = Vector2.new(rootPos.X - width / 2, top.Y)
						box.Color = ESP.Color
						box.Thickness = ESP.Thickness
						visible = true
					end
				end
			end
		end

		box.Visible = visible
	end
end))

function ESP.Unload()
	for _, connection in ipairs(connections) do
		pcall(function() connection:Disconnect() end)
	end
	table.clear(connections)
	for player in pairs(boxes) do
		removeBox(player)
	end
	getgenv().BoxESP = nil
end

getgenv().BoxESP = ESP
return ("Box ESP loaded — tracking %d players"):format((function()
	local n = 0
	for _ in pairs(boxes) do n += 1 end
	return n
end)())
