/**
 * Tiny, pure string helpers for building Luau source from a tool. Tools that
 * interpolate user-supplied strings into a chunk MUST funnel them through
 * {@link q} so a stray quote, newline, or control character can never break the
 * chunk (or worse, inject Luau). These are deliberately dependency-free and
 * trivially unit-testable.
 */

/**
 * Quote an arbitrary string as a Luau string literal.
 *
 * `JSON.stringify` already produces a double-quoted literal with the exact escape
 * set Luau understands (`\"`, `\\`, `\n`, `\t`, `\r`, `\b`, `\f`), so it is a
 * sound base. The one mismatch is control characters, which JSON escapes as
 * `\uXXXX` (four hex digits, no braces) — a form Luau does NOT accept. Luau spells
 * the same code point `\u{XXXX}` (braced). We rewrite every `\uXXXX` to `\u{XXXX}`
 * so control chars survive intact instead of producing a malformed chunk.
 *
 * @example q('a"b\n')  // => "\"a\\\"b\\n\""  (a valid Luau literal)
 */
export function q(value: string): string {
  return JSON.stringify(value).replace(/\\u([0-9a-fA-F]{4})/g, "\\u{$1}");
}

/**
 * Shared Luau prelude exposing a single safe helper, `__encode`, that turns any
 * Luau value into a stable, JSON-friendly form before it is returned. The bridge
 * JSON-encodes the first returned value, but raw Roblox types (Instance, Vector3,
 * CFrame, functions, …) are not JSON-serializable; `__encode` flattens them to
 * strings / plain tables so results never silently drop fields. Every read is
 * pcall-guarded, so a misbehaving __tostring metamethod can't abort the chunk.
 *
 * Prepend this to a chunk, then call `__encode(value)` on anything you return.
 */
export const PRELUDE = `
local function __encode(value, depth)
  depth = depth or 0
  local t = typeof(value)
  if t == "nil" or t == "boolean" or t == "number" or t == "string" then
    return value
  elseif t == "Instance" then
    local ok, full = pcall(function() return value:GetFullName() end)
    return { __type = "Instance", className = value.ClassName, path = ok and full or tostring(value) }
  elseif t == "EnumItem" then
    return { __type = "EnumItem", value = tostring(value) }
  elseif t == "table" then
    if depth >= 5 then return "<table:max-depth>" end
    local out = {}
    local okIter = pcall(function()
      for k, v in pairs(value) do
        out[tostring(k)] = __encode(v, depth + 1)
      end
    end)
    if not okIter then return "<table:unreadable>" end
    return out
  else
    local ok, s = pcall(function() return tostring(value) end)
    return { __type = t, value = ok and s or "<unprintable>" }
  end
end
`;

/**
 * Resolver prelude: defines `__resolve(path)` which walks a dotted instance path
 * (e.g. `game.Workspace.Part`) from a sensible root (game / workspace / a service)
 * and returns `(instance, err)`. Every hop is pcall-guarded and falls back to
 * `FindFirstChild`, so a missing segment yields a precise error string instead of
 * throwing. Used by the inspection tools. Depends on nothing else.
 */
export const RESOLVE_PRELUDE = `
local function __resolve(p)
  local segments = {}
  for seg in string.gmatch(p, "[^%.]+") do
    segments[#segments + 1] = seg
  end
  if #segments == 0 then return nil, "Empty path" end

  local first = segments[1]
  local current
  if first == "game" or first == "Game" then
    current = game
  elseif first == "workspace" or first == "Workspace" then
    current = workspace
  else
    local ok, svc = pcall(function() return game:GetService(first) end)
    if ok and svc then
      current = svc
    else
      local ok2, child = pcall(function() return game:FindFirstChild(first) end)
      if ok2 and child then current = child end
    end
  end
  if not current then
    return nil, "Could not resolve root segment '" .. tostring(first) .. "'"
  end

  for i = 2, #segments do
    local name = segments[i]
    local ok, nxt = pcall(function() return (current :: any)[name] end)
    if not ok or nxt == nil then
      local ok2, child = pcall(function() return current:FindFirstChild(name) end)
      if ok2 and child then
        nxt = child
      else
        return nil, "Path segment '" .. tostring(name) .. "' not found under '" .. tostring(current) .. "'"
      end
    end
    current = nxt
  end
  return current
end
`;
