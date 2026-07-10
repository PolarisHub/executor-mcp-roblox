import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { q } from "../_shared/luau.js";

const vectorSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
});

export default defineTool({
  name: "camera-control",
  title: "Read or move the current camera",
  description:
    "WRITES LIVE GAME STATE. Read the active camera or set its CFrame, position/look-at target, FieldOfView, and " +
    "optional CameraType. Use this to reproduce camera movement and aim states in the local client. The tool only " +
    "changes the local CurrentCamera; it does not move the character or replicate a camera state to the server. " +
    "For a one-shot read, use action=get. For movement, action=setCFrame requires position and either lookAt or " +
    "rotation in degrees. Existing camera properties are returned so the change is auditable.",
  category: "GUI",
  mutatesState: true,
  input: z.object({
    action: z.enum(["get", "setCFrame", "setFov"]).describe("Camera operation."),
    position: vectorSchema.optional().describe("World position for setCFrame."),
    lookAt: vectorSchema
      .optional()
      .describe("World target for setCFrame; creates CFrame.lookAt(position, lookAt)."),
    rotation: z
      .object({ pitch: z.number().finite(), yaw: z.number().finite(), roll: z.number().finite() })
      .optional()
      .describe("Euler rotation in degrees for setCFrame when lookAt is not supplied."),
    fov: z
      .number()
      .finite()
      .min(1)
      .max(120)
      .optional()
      .describe("FieldOfView for setFov or alongside setCFrame."),
    cameraType: z
      .enum(["Fixed", "Attach", "Watch", "Track", "Follow", "Custom", "Scriptable", "Orbital"])
      .optional()
      .describe("Optional Enum.CameraType to apply after changing the CFrame."),
    threadContext: z.number().int().optional(),
  }),
  async execute({ action, position, lookAt, rotation, fov, cameraType, threadContext }, ctx) {
    const source = `
local camera = workspace.CurrentCamera
if camera == nil then return { ok = false, error = "workspace.CurrentCamera is unavailable" } end

local function vector(v)
  if v == nil then return nil end
  return Vector3.new(v.x, v.y, v.z)
end

local function snapshot()
  local cf = camera.CFrame
  return {
    ok = true,
    cameraType = tostring(camera.CameraType),
    fieldOfView = camera.FieldOfView,
    position = { x = cf.Position.X, y = cf.Position.Y, z = cf.Position.Z },
    lookVector = { x = cf.LookVector.X, y = cf.LookVector.Y, z = cf.LookVector.Z },
  }
end

local before = snapshot()
if ${q(action)} == "get" then return before end

if ${q(action)} == "setFov" then
  if ${fov === undefined ? "nil" : String(fov)} == nil then return { ok = false, error = "setFov requires fov" } end
  camera.FieldOfView = ${fov === undefined ? "0" : String(fov)}
elseif ${q(action)} == "setCFrame" then
  local pos = vector(${position ? `{ x = ${position.x}, y = ${position.y}, z = ${position.z} }` : "nil"})
  if pos == nil then return { ok = false, error = "setCFrame requires position" } end
  local cf
  if ${lookAt ? "true" : "false"} then
    cf = CFrame.lookAt(pos, vector({ x = ${lookAt?.x ?? 0}, y = ${lookAt?.y ?? 0}, z = ${lookAt?.z ?? 0} }))
  elseif ${rotation ? "true" : "false"} then
    cf = CFrame.new(pos) * CFrame.Angles(math.rad(${rotation?.pitch ?? 0}), math.rad(${rotation?.yaw ?? 0}), math.rad(${rotation?.roll ?? 0}))
  else
    return { ok = false, error = "setCFrame requires lookAt or rotation" }
  end
  camera.CFrame = cf
  if ${fov === undefined ? "nil" : String(fov)} ~= nil then camera.FieldOfView = ${fov === undefined ? "0" : String(fov)} end
  if ${cameraType ? "true" : "false"} then
    local okType, value = pcall(function() return Enum.CameraType[${q(cameraType ?? "")}] end)
    if not okType or typeof(value) ~= "EnumItem" then return { ok = false, error = "unknown Enum.CameraType" } end
    camera.CameraType = value
  end
else
  return { ok = false, error = "unsupported camera action" }
end

local after = snapshot()
after.before = before
return after
`;
    const data = await ctx.runLuau(source, { threadContext, timeoutMs: 20000 });
    return { data };
  },
});
