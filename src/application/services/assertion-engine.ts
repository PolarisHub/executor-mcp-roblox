export type AssertionScalar = string | number | boolean;

interface AssertionBase {
  readonly id: string;
}

export interface PathExistsAssertion extends AssertionBase {
  readonly kind: "path-exists" | "path-not-exists";
  readonly path: string;
}

export interface PropertyValueAssertion extends AssertionBase {
  readonly kind: "property-equals" | "property-not-equals";
  readonly path: string;
  readonly property: string;
  readonly expected: AssertionScalar;
}

export interface PropertyContainsAssertion extends AssertionBase {
  readonly kind: "property-contains";
  readonly path: string;
  readonly property: string;
  readonly expected: string;
  readonly caseSensitive?: boolean;
}

export interface PropertyNumericAssertion extends AssertionBase {
  readonly kind: "property-greater" | "property-less";
  readonly path: string;
  readonly property: string;
  readonly expected: number;
}

export interface AttributeEqualsAssertion extends AssertionBase {
  readonly kind: "attribute-equals";
  readonly path: string;
  readonly attribute: string;
  readonly expected: AssertionScalar;
}

export interface GuiStateAssertion extends AssertionBase {
  readonly kind: "gui-visible" | "gui-enabled";
  readonly path: string;
  readonly expected?: boolean;
  readonly effective?: boolean;
}

export interface ClassSelector {
  readonly by: "class";
  readonly value: string;
}

export interface TextSelector {
  readonly by: "name" | "text";
  readonly value: string;
  readonly match?: "equals" | "contains";
  readonly caseSensitive?: boolean;
}

export type DescendantSelector = ClassSelector | TextSelector;

export interface DescendantExistsAssertion extends AssertionBase {
  readonly kind: "descendant-exists";
  readonly path: string;
  readonly selector: DescendantSelector;
  readonly expected?: boolean;
}

export interface CharacterDistanceAssertion extends AssertionBase {
  readonly kind: "character-distance";
  readonly targetPath: string;
  readonly operator: "at-most" | "at-least";
  readonly distance: number;
  readonly playerName?: string;
  readonly characterPath?: string;
  readonly rootPath?: string;
}

export interface CameraFacingAssertion extends AssertionBase {
  readonly kind: "camera-facing";
  readonly targetPath: string;
  readonly maxAngleDegrees: number;
  readonly cameraPath?: string;
}

export interface CollectionCountAssertion extends AssertionBase {
  readonly kind: "collection-count";
  readonly path: string;
  readonly scope?: "children" | "descendants";
  readonly operator: "equals" | "not-equals" | "greater" | "less" | "at-least" | "at-most";
  readonly count: number;
  readonly selector?: DescendantSelector;
}

export type LiveAssertion =
  | PathExistsAssertion
  | PropertyValueAssertion
  | PropertyContainsAssertion
  | PropertyNumericAssertion
  | AttributeEqualsAssertion
  | GuiStateAssertion
  | DescendantExistsAssertion
  | CharacterDistanceAssertion
  | CameraFacingAssertion
  | CollectionCountAssertion;

export interface AssertionEngineLimits {
  readonly scanLimit: number;
  readonly readBudget: number;
}

export interface AssertionEvidence {
  readonly readSucceeded: boolean;
  readonly confidence?: number;
  readonly [key: string]: unknown;
}

export interface AssertionResult {
  readonly id: string;
  readonly kind: LiveAssertion["kind"];
  readonly status: "passed" | "failed";
  readonly passed: boolean;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly evidence: AssertionEvidence;
  readonly errors: readonly string[];
  readonly confidence: number;
}

export interface AssertionAggregate {
  readonly passed: boolean;
  readonly total: number;
  readonly passedCount: number;
  readonly failedCount: number;
  readonly readFailureCount: number;
  readonly passRatio: number;
  readonly confidence: number;
}

export interface AssertionReport {
  readonly results: readonly AssertionResult[];
  readonly aggregate: AssertionAggregate;
  readonly passed: boolean;
  readonly passRatio: number;
  readonly confidence: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function expectedFor(assertion: LiveAssertion): unknown {
  switch (assertion.kind) {
    case "path-exists":
      return true;
    case "path-not-exists":
      return false;
    case "property-equals":
    case "property-not-equals":
    case "property-contains":
    case "property-greater":
    case "property-less":
    case "attribute-equals":
      return assertion.expected;
    case "gui-visible":
    case "gui-enabled":
    case "descendant-exists":
      return assertion.expected ?? true;
    case "character-distance":
      return { operator: assertion.operator, distance: assertion.distance };
    case "camera-facing":
      return { atMostDegrees: assertion.maxAngleDegrees };
    case "collection-count":
      return { operator: assertion.operator, count: assertion.count };
  }
}

/** A result only passes when the predicate passed and every required live read completed. */
export function assertionResultPassed(
  result: Pick<AssertionResult, "passed" | "errors" | "evidence">,
): boolean {
  return result.passed === true && result.errors.length === 0 && result.evidence.readSucceeded;
}

/** Alias with conventional predicate naming for orchestrators. */
export const isAssertionResultPassed = assertionResultPassed;

function resultConfidence(
  result: Pick<AssertionResult, "evidence" | "errors" | "confidence">,
): number {
  if (!result.evidence.readSucceeded) return 0;
  if (result.errors.length > 0) return Math.min(clamp(result.confidence, 0, 0.95), 0.5);
  return clamp(result.confidence, 0, 0.95);
}

/** Pure aggregation shared by assert-state and higher-level goal runners. */
export function aggregateAssertionResults(results: readonly AssertionResult[]): AssertionAggregate {
  const total = results.length;
  const passedCount = results.filter(assertionResultPassed).length;
  const readFailureCount = results.filter((result) => !result.evidence.readSucceeded).length;
  const passRatio = total === 0 ? 0 : round(passedCount / total);
  const confidence =
    total === 0 ? 0 : round(Math.min(...results.map((result) => resultConfidence(result))), 3);
  return {
    passed: total > 0 && passedCount === total && readFailureCount === 0,
    total,
    passedCount,
    failedCount: total - passedCount,
    readFailureCount,
    passRatio,
    confidence,
  };
}

/** Check an aggregate without trusting a caller-provided `passed` flag. */
export function assertionAggregatePassed(
  aggregate: AssertionAggregate,
  minimumPassRatio = 1,
): boolean {
  const threshold = clamp(minimumPassRatio, 0, 1);
  return (
    aggregate.total > 0 &&
    aggregate.readFailureCount === 0 &&
    aggregate.passRatio >= threshold &&
    (threshold < 1 || aggregate.passed)
  );
}

/** Aggregate and gate results in one pure call for smart-task style consumers. */
export function assertionResultsPassed(
  results: readonly AssertionResult[],
  minimumPassRatio = 1,
): boolean {
  return assertionAggregatePassed(aggregateAssertionResults(results), minimumPassRatio);
}

function normalizeErrors(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => (typeof entry === "string" ? entry : String(entry)));
}

function normalizeEvidence(raw: unknown): AssertionEvidence {
  if (!isRecord(raw)) return { readSucceeded: false, confidence: 0 };
  return {
    ...raw,
    readSucceeded: raw["readSucceeded"] === true,
    confidence:
      typeof raw["confidence"] === "number"
        ? clamp(raw["confidence"], 0, 0.95)
        : raw["readSucceeded"] === true
          ? 0.9
          : 0,
  };
}

/**
 * Convert the untrusted bridge payload into strict results. Missing/malformed data and
 * any incomplete read are forced to failure, even if the payload claims `passed=true`.
 */
export function normalizeAssertionReport(
  raw: unknown,
  assertions: readonly LiveAssertion[],
): AssertionReport {
  const root = isRecord(raw) ? raw : {};
  const rawResults = Array.isArray(root["results"]) ? root["results"] : [];
  const results = assertions.map<AssertionResult>((assertion, index) => {
    const item = isRecord(rawResults[index]) ? rawResults[index] : undefined;
    const errors = normalizeErrors(item?.["errors"]);
    if (!item) errors.push("The live assertion returned no result.");
    if (item && typeof item["passed"] !== "boolean") {
      errors.push("The live assertion returned no boolean pass state.");
    }
    const evidence = normalizeEvidence(item?.["evidence"]);
    if (!evidence.readSucceeded) {
      errors.push("A required live read failed or did not complete.");
    }
    if (!item || !hasOwn(item, "actual")) {
      errors.push("The live assertion returned no actual value.");
    }
    const declaredPassed = item?.["passed"] === true;
    const passed = declaredPassed && errors.length === 0 && evidence.readSucceeded;
    const confidence = resultConfidence({
      evidence,
      errors,
      confidence:
        typeof item?.["confidence"] === "number"
          ? clamp(item["confidence"], 0, 0.95)
          : (evidence.confidence ?? 0),
    });
    return {
      id: assertion.id,
      kind: assertion.kind,
      status: passed ? "passed" : "failed",
      passed,
      expected: item && hasOwn(item, "expected") ? item["expected"] : expectedFor(assertion),
      actual: item && hasOwn(item, "actual") ? item["actual"] : "<unavailable>",
      evidence,
      errors,
      confidence,
    };
  });
  const aggregate = aggregateAssertionResults(results);
  return {
    results,
    aggregate,
    passed: aggregate.passed,
    passRatio: aggregate.passRatio,
    confidence: aggregate.confidence,
  };
}

function quoteLuau(value: string): string {
  return JSON.stringify(value).replace(/\\u([0-9a-fA-F]{4})/g, "\\u{$1}");
}

/** Build one bounded Luau chunk containing every requested live assertion. */
export function buildAssertionLuau(
  assertions: readonly LiveAssertion[],
  limits: AssertionEngineLimits,
): string {
  const encodedAssertions = quoteLuau(JSON.stringify(assertions));
  const scanLimit = Math.floor(clamp(limits.scanLimit, 1, 5000));
  const readBudget = Math.floor(clamp(limits.readBudget, 1, 50000));
  return `
local HttpService = game:GetService("HttpService")
local assertions = HttpService:JSONDecode(${encodedAssertions})
local scanLimit = ${scanLimit}
local readBudget = ${readBudget}
local readCount = 0

local function consumeRead(amount)
  amount = amount or 1
  if readCount + amount > readBudget then return false end
  readCount = readCount + amount
  return true
end

local function encode(value, depth)
  depth = depth or 0
  local valueType = typeof(value)
  if value == nil then return "<nil>" end
  if valueType == "boolean" or valueType == "number" or valueType == "string" then return value end
  if valueType == "Instance" then
    local ok, fullName = pcall(function() return value:GetFullName() end)
    return { type = "Instance", className = value.ClassName, path = ok and fullName or tostring(value) }
  end
  if valueType == "table" then
    if depth >= 4 then return "<table:max-depth>" end
    local output = {}
    local ok = pcall(function()
      for key, entry in pairs(value) do output[tostring(key)] = encode(entry, depth + 1) end
    end)
    return ok and output or "<table:unreadable>"
  end
  local ok, text = pcall(function() return tostring(value) end)
  return { type = valueType, value = ok and text or "<unprintable>" }
end

local function fullName(instance)
  local ok, value = pcall(function() return instance:GetFullName() end)
  return ok and value or tostring(instance)
end

local function makeEvidence(fields)
  fields = fields or {}
  if fields.readSucceeded == nil then fields.readSucceeded = false end
  if fields.complete == nil then fields.complete = false end
  if fields.confidence == nil then fields.confidence = 0 end
  return fields
end

local function makeResult(assertion, passed, expected, actual, evidence, errors)
  errors = errors or {}
  evidence = makeEvidence(evidence)
  local safePassed = passed == true and evidence.readSucceeded == true and #errors == 0
  return {
    id = assertion.id,
    kind = assertion.kind,
    passed = safePassed,
    expected = encode(expected),
    actual = encode(actual),
    evidence = encode(evidence),
    errors = errors,
    confidence = math.min(0.95, tonumber(evidence.confidence) or 0),
  }
end

local function resolve(path)
  if type(path) ~= "string" or path == "" then
    return nil, "error", "Path must be a non-empty string."
  end
  local segments = {}
  for segment in string.gmatch(path, "[^%.]+") do segments[#segments + 1] = segment end
  if #segments == 0 then return nil, "error", "Path has no resolvable segments." end

  local current
  local first = segments[1]
  if first == "game" or first == "Game" then
    current = game
  elseif first == "workspace" or first == "Workspace" then
    current = workspace
  else
    if not consumeRead() then return nil, "error", "Read budget exhausted while resolving root." end
    local okService, service = pcall(function() return game:GetService(first) end)
    if okService and service then
      current = service
    else
      if not consumeRead() then return nil, "error", "Read budget exhausted while resolving root." end
      local okChild, child = pcall(function() return game:FindFirstChild(first) end)
      if not okChild then return nil, "error", "Failed to read game root: " .. tostring(child) end
      if child == nil then return nil, "missing", "Root segment '" .. first .. "' was not found." end
      current = child
    end
  end

  for index = 2, #segments do
    local name = segments[index]
    if not consumeRead() then return nil, "error", "Read budget exhausted while resolving path." end
    local okProperty, nextValue = pcall(function() return (current :: any)[name] end)
    if not okProperty or nextValue == nil then
      if typeof(current) ~= "Instance" then
        return nil, "error", "Cannot resolve segment '" .. name .. "' through a non-Instance value."
      end
      if not consumeRead() then return nil, "error", "Read budget exhausted while resolving path." end
      local okChild, child = pcall(function() return current:FindFirstChild(name) end)
      if not okChild then return nil, "error", "Failed to read segment '" .. name .. "': " .. tostring(child) end
      if child == nil then
        return nil, "missing", "Segment '" .. name .. "' was not found under '" .. fullName(current) .. "'."
      end
      nextValue = child
    end
    current = nextValue
  end
  if typeof(current) ~= "Instance" then
    return nil, "error", "Resolved path does not identify an Instance."
  end
  return current, "found", fullName(current)
end

local function readProperty(instance, property)
  if not consumeRead() then return false, nil, "Read budget exhausted before property read." end
  local ok, value = pcall(function() return (instance :: any)[property] end)
  if not ok then return false, nil, "Property '" .. tostring(property) .. "' could not be read: " .. tostring(value) end
  return true, value, nil
end

local function valuesEqual(actual, expected)
  if typeof(actual) == typeof(expected) then return actual == expected end
  if type(expected) == "string" then
    local actualType = typeof(actual)
    if actualType == "EnumItem" or actualType == "BrickColor" then
      local ok, text = pcall(function() return tostring(actual) end)
      return ok and text == expected
    end
  end
  return false
end

local function compareText(actual, expected, mode, caseSensitive)
  if type(actual) ~= "string" then return false, "Actual value is not text." end
  local left, right = actual, expected
  if caseSensitive == false then left, right = string.lower(left), string.lower(right) end
  if mode == "contains" then return string.find(left, right, 1, true) ~= nil, nil end
  return left == right, nil
end

local function compareCount(actual, expected, operator)
  if operator == "equals" then return actual == expected end
  if operator == "not-equals" then return actual ~= expected end
  if operator == "greater" then return actual > expected end
  if operator == "less" then return actual < expected end
  if operator == "at-least" then return actual >= expected end
  if operator == "at-most" then return actual <= expected end
  return false
end

local function selectorMatches(instance, selector)
  if selector == nil then return true, true, nil end
  if selector.by == "class" then
    if not consumeRead() then return false, false, "Read budget exhausted during class match." end
    local ok, matched = pcall(function() return instance:IsA(selector.value) end)
    if not ok then return false, false, "Class match failed: " .. tostring(matched) end
    return true, matched, nil
  end
  if selector.by == "name" then
    local ok, name, err = readProperty(instance, "Name")
    if not ok then return false, false, err end
    local matched, compareError = compareText(name, selector.value, selector.match or "equals", selector.caseSensitive)
    return compareError == nil, matched, compareError
  end
  if selector.by == "text" then
    if not consumeRead() then return false, false, "Read budget exhausted during text class check." end
    local okClass, isText = pcall(function()
      return instance:IsA("TextLabel") or instance:IsA("TextButton") or instance:IsA("TextBox")
    end)
    if not okClass then return false, false, "Text class check failed: " .. tostring(isText) end
    if not isText then return true, false, nil end
    local ok, textValue, err = readProperty(instance, "Text")
    if not ok then return false, false, err end
    local matched, compareError = compareText(textValue, selector.value, selector.match or "contains", selector.caseSensitive)
    return compareError == nil, matched, compareError
  end
  return false, false, "Unknown descendant selector."
end

local function initialChildren(root)
  if not consumeRead() then return nil, "Read budget exhausted before descendant scan." end
  local ok, children = pcall(function() return root:GetChildren() end)
  if not ok then return nil, "Could not enumerate children: " .. tostring(children) end
  return children, nil
end

local function scanDescendants(root, selector, stopAtFirst)
  local queue, queueError = initialChildren(root)
  if queue == nil then return nil, 0, false, nil, queueError end
  local head, scanned, count, firstMatch = 1, 0, 0, nil
  while head <= #queue and scanned < scanLimit do
    if not consumeRead() then
      return nil, scanned, false, firstMatch, "Read budget exhausted during descendant scan."
    end
    local instance = queue[head]
    head = head + 1
    scanned = scanned + 1
    local okMatch, matched, matchError = selectorMatches(instance, selector)
    if not okMatch then return nil, scanned, false, firstMatch, matchError end
    if matched then
      count = count + 1
      if firstMatch == nil then firstMatch = instance end
      if stopAtFirst then return count, scanned, true, firstMatch, nil end
    end
    local children, childError = initialChildren(instance)
    if children == nil then return nil, scanned, false, firstMatch, childError end
    for _, child in ipairs(children) do queue[#queue + 1] = child end
  end
  if head <= #queue then
    return count, scanned, false, firstMatch, "Scan limit reached before all descendants were read."
  end
  return count, scanned, true, firstMatch, nil
end

local rootNames = {
  HumanoidRootPart = 7,
  RootPart = 6,
  LowerTorso = 5,
  Torso = 4,
  UpperTorso = 3,
  Root = 2,
}
local rootNamePriority = { "HumanoidRootPart", "RootPart", "LowerTorso", "Torso", "UpperTorso", "Root" }

local function isBasePart(instance)
  if not consumeRead() then return false, "Read budget exhausted during BasePart check." end
  local ok, value = pcall(function() return instance:IsA("BasePart") end)
  if not ok then return false, "BasePart check failed: " .. tostring(value) end
  return value, nil
end

local function directModelRoot(model)
  for _, name in ipairs(rootNamePriority) do
    if not consumeRead() then return nil, nil, "Read budget exhausted during root discovery." end
    local ok, candidate = pcall(function() return model:FindFirstChild(name) end)
    if not ok then return nil, nil, "Character child read failed: " .. tostring(candidate) end
    if candidate then
      local base, baseError = isBasePart(candidate)
      if baseError then return nil, nil, baseError end
      if base then return candidate, name, nil end
    end
  end
  if not consumeRead() then return nil, nil, "Read budget exhausted during PrimaryPart read." end
  local okPrimary, primary = pcall(function() return model.PrimaryPart end)
  if okPrimary and primary then
    local base, baseError = isBasePart(primary)
    if baseError then return nil, nil, baseError end
    if base then return primary, "PrimaryPart", nil end
  end
  return nil, nil, nil
end

local function findRootInModel(model)
  local base, baseError = isBasePart(model)
  if baseError then return nil, nil, false, baseError end
  if base then return model, "explicit BasePart", true, nil end
  local direct, method, directError = directModelRoot(model)
  if directError then return nil, nil, false, directError end
  if direct then return direct, method, true, nil end

  local queue, queueError = initialChildren(model)
  if queue == nil then return nil, nil, false, queueError end
  local head, scanned, best, bestRank = 1, 0, nil, -1
  while head <= #queue and scanned < scanLimit do
    local instance = queue[head]
    head = head + 1
    scanned = scanned + 1
    local okName, name, nameError = readProperty(instance, "Name")
    if not okName then return nil, nil, false, nameError end
    local rank = rootNames[name]
    if rank then
      local candidateIsBase, candidateError = isBasePart(instance)
      if candidateError then return nil, nil, false, candidateError end
      if candidateIsBase and rank > bestRank then best, bestRank = instance, rank end
    end
    local children, childError = initialChildren(instance)
    if children == nil then return nil, nil, false, childError end
    for _, child in ipairs(children) do queue[#queue + 1] = child end
  end
  if best then return best, "custom named root", true, nil end
  if head <= #queue then return nil, nil, false, "Character root scan reached its limit." end
  return nil, nil, true, nil
end

local function playerFor(name)
  if not consumeRead() then return nil, "Read budget exhausted before Players read." end
  local okPlayers, Players = pcall(function() return game:GetService("Players") end)
  if not okPlayers then return nil, "Players service read failed: " .. tostring(Players) end
  if name then
    if not consumeRead() then return nil, "Read budget exhausted before player lookup." end
    local okPlayer, player = pcall(function() return Players:FindFirstChild(name) end)
    if not okPlayer then return nil, "Player lookup failed: " .. tostring(player) end
    if not player then return nil, "Player '" .. name .. "' was not found." end
    return player, nil
  end
  local okLocal, localPlayer, localError = readProperty(Players, "LocalPlayer")
  if not okLocal then return nil, localError end
  if not localPlayer then return nil, "LocalPlayer is unavailable." end
  return localPlayer, nil
end

local function modelScore(model, player)
  local score = 0
  local okModelName, modelName = readProperty(model, "Name")
  if okModelName then
    local okPlayerName, playerName = readProperty(player, "Name")
    if okPlayerName and modelName == playerName then score = score + 100 end
  end
  if consumeRead() then
    local okAttribute, attribute = pcall(function() return model:GetAttribute("PlayerName") end)
    local okPlayerName, playerName = readProperty(player, "Name")
    if okAttribute and okPlayerName and attribute == playerName then score = score + 80 end
  end
  if consumeRead() then
    local okAttribute, attribute = pcall(function() return model:GetAttribute("UserId") end)
    local okUserId, userId = readProperty(player, "UserId")
    if okAttribute and okUserId and tonumber(attribute) == tonumber(userId) then score = score + 80 end
  end
  return score
end

local function searchCustomRoot(player)
  local queue, queueError = initialChildren(workspace)
  if queue == nil then return nil, nil, false, queueError end
  local head, scanned, bestRoot, bestScore, bestMethod = 1, 0, nil, 0, nil
  while head <= #queue and scanned < scanLimit do
    local instance = queue[head]
    head = head + 1
    scanned = scanned + 1
    if not consumeRead() then return nil, nil, false, "Read budget exhausted during custom character scan." end
    local okModel, isModel = pcall(function() return instance:IsA("Model") end)
    if not okModel then return nil, nil, false, "Model check failed: " .. tostring(isModel) end
    if isModel then
      local score = modelScore(instance, player)
      if score > bestScore then
        local root, method, _, rootError = findRootInModel(instance)
        if rootError then return nil, nil, false, rootError end
        if root then bestRoot, bestScore, bestMethod = root, score, method end
      end
    end
    local children, childError = initialChildren(instance)
    if children == nil then return nil, nil, false, childError end
    for _, child in ipairs(children) do queue[#queue + 1] = child end
  end
  if bestRoot then return bestRoot, "Workspace custom model (" .. tostring(bestMethod) .. ")", true, nil end
  if head <= #queue then return nil, nil, false, "Custom character scan reached its limit." end
  return nil, nil, true, nil
end

local function characterRoot(assertion)
  if assertion.rootPath then
    local explicit, state, detail = resolve(assertion.rootPath)
    if state ~= "found" then return nil, nil, 0, "Explicit root path failed: " .. detail end
    local base, baseError = isBasePart(explicit)
    if baseError then return nil, nil, 0, baseError end
    if not base then return nil, nil, 0, "Explicit root path is not a BasePart." end
    return explicit, "explicit rootPath", 0.95, nil
  end
  if assertion.characterPath then
    local character, state, detail = resolve(assertion.characterPath)
    if state ~= "found" then return nil, nil, 0, "Explicit character path failed: " .. detail end
    local root, method, _, rootError = findRootInModel(character)
    if rootError then return nil, nil, 0, rootError end
    if not root then return nil, nil, 0, "No root part was found in the explicit character model." end
    return root, "explicit characterPath (" .. tostring(method) .. ")", 0.92, nil
  end

  local player, playerError = playerFor(assertion.playerName)
  if not player then return nil, nil, 0, playerError end
  local okCharacter, character, characterError = readProperty(player, "Character")
  if not okCharacter then return nil, nil, 0, characterError end
  if character then
    local root, method, _, rootError = findRootInModel(character)
    if rootError then return nil, nil, 0, rootError end
    if root then return root, "Player.Character (" .. tostring(method) .. ")", 0.95, nil end
  end
  local customRoot, method, _, customError = searchCustomRoot(player)
  if customError then return nil, nil, 0, customError end
  if customRoot then return customRoot, method, 0.8, nil end
  return nil, nil, 0, "No standard or confidently matched custom character root was found."
end

local function positionOf(instance)
  if not consumeRead() then return nil, "Read budget exhausted before position read." end
  local okBase, isPart = pcall(function() return instance:IsA("BasePart") end)
  if not okBase then return nil, "BasePart check failed: " .. tostring(isPart) end
  if isPart then
    local ok, position, err = readProperty(instance, "Position")
    if not ok then return nil, err end
    if typeof(position) ~= "Vector3" then return nil, "BasePart Position was not a Vector3." end
    return position, nil
  end
  if not consumeRead() then return nil, "Read budget exhausted before attachment check." end
  local okAttachment, isAttachment = pcall(function() return instance:IsA("Attachment") end)
  if not okAttachment then return nil, "Attachment check failed: " .. tostring(isAttachment) end
  if isAttachment then
    local ok, position, err = readProperty(instance, "WorldPosition")
    if not ok then return nil, err end
    if typeof(position) ~= "Vector3" then return nil, "Attachment WorldPosition was not a Vector3." end
    return position, nil
  end
  if not consumeRead() then return nil, "Read budget exhausted before model check." end
  local okModel, isModel = pcall(function() return instance:IsA("Model") end)
  if not okModel then return nil, "Model check failed: " .. tostring(isModel) end
  if isModel then
    if not consumeRead() then return nil, "Read budget exhausted before model pivot read." end
    local okPivot, pivot = pcall(function() return instance:GetPivot() end)
    if not okPivot or typeof(pivot) ~= "CFrame" then return nil, "Model pivot could not be read." end
    return pivot.Position, nil
  end
  return nil, "Target must be a BasePart, Attachment, or Model."
end

local function evaluatePath(assertion)
  local instance, state, detail = resolve(assertion.path)
  local expected = assertion.kind == "path-exists"
  if state == "error" then
    return makeResult(assertion, false, expected, "<unavailable>", {
      path = assertion.path, readSucceeded = false, complete = false, confidence = 0,
    }, { detail })
  end
  local actual = instance ~= nil
  return makeResult(assertion, actual == expected, expected, actual, {
    path = assertion.path,
    resolvedPath = instance and fullName(instance) or nil,
    detail = detail,
    readSucceeded = true,
    complete = true,
    confidence = 0.95,
  }, {})
end

local function evaluateProperty(assertion)
  local instance, state, detail = resolve(assertion.path)
  if state ~= "found" then
    return makeResult(assertion, false, assertion.expected, "<unavailable>", {
      path = assertion.path, property = assertion.property, readSucceeded = false, confidence = 0,
    }, { "Property target could not be resolved: " .. detail })
  end
  local ok, actual, readError = readProperty(instance, assertion.property)
  if not ok then
    return makeResult(assertion, false, assertion.expected, "<unavailable>", {
      path = assertion.path, resolvedPath = fullName(instance), property = assertion.property,
      readSucceeded = false, confidence = 0,
    }, { readError })
  end

  local passed, compareError = false, nil
  if assertion.kind == "property-equals" then passed = valuesEqual(actual, assertion.expected)
  elseif assertion.kind == "property-not-equals" then passed = not valuesEqual(actual, assertion.expected)
  elseif assertion.kind == "property-contains" then
    passed, compareError = compareText(actual, assertion.expected, "contains", assertion.caseSensitive)
  elseif assertion.kind == "property-greater" then
    if type(actual) ~= "number" then compareError = "Actual property is not numeric."
    else passed = actual > assertion.expected end
  elseif assertion.kind == "property-less" then
    if type(actual) ~= "number" then compareError = "Actual property is not numeric."
    else passed = actual < assertion.expected end
  end
  local errors = {}
  if compareError then errors[#errors + 1] = compareError end
  return makeResult(assertion, passed, assertion.expected, actual, {
    path = assertion.path, resolvedPath = fullName(instance), property = assertion.property,
    actualType = typeof(actual), readSucceeded = true, complete = true, confidence = compareError and 0.5 or 0.95,
  }, errors)
end

local function evaluateAttribute(assertion)
  local instance, state, detail = resolve(assertion.path)
  if state ~= "found" then
    return makeResult(assertion, false, assertion.expected, "<unavailable>", {
      path = assertion.path, attribute = assertion.attribute, readSucceeded = false, confidence = 0,
    }, { "Attribute target could not be resolved: " .. detail })
  end
  if not consumeRead() then
    return makeResult(assertion, false, assertion.expected, "<unavailable>", {
      path = assertion.path, attribute = assertion.attribute, readSucceeded = false, confidence = 0,
    }, { "Read budget exhausted before attribute read." })
  end
  local ok, actual = pcall(function() return instance:GetAttribute(assertion.attribute) end)
  if not ok then
    return makeResult(assertion, false, assertion.expected, "<unavailable>", {
      path = assertion.path, attribute = assertion.attribute, readSucceeded = false, confidence = 0,
    }, { "Attribute could not be read: " .. tostring(actual) })
  end
  return makeResult(assertion, valuesEqual(actual, assertion.expected), assertion.expected, actual, {
    path = assertion.path, resolvedPath = fullName(instance), attribute = assertion.attribute,
    actualType = typeof(actual), readSucceeded = true, complete = true, confidence = 0.95,
  }, {})
end

local function evaluateGui(assertion)
  local instance, state, detail = resolve(assertion.path)
  local expected = assertion.expected
  if expected == nil then expected = true end
  if state ~= "found" then
    return makeResult(assertion, false, expected, "<unavailable>", {
      path = assertion.path, readSucceeded = false, confidence = 0,
    }, { "GUI target could not be resolved: " .. detail })
  end
  local property = assertion.kind == "gui-visible" and "Visible" or "Enabled"
  if assertion.kind == "gui-visible" then
    if not consumeRead() then
      return makeResult(assertion, false, expected, "<unavailable>", { readSucceeded = false }, { "Read budget exhausted before GUI class check." })
    end
    local okClass, isGui = pcall(function() return instance:IsA("GuiObject") end)
    if not okClass or not isGui then
      return makeResult(assertion, false, expected, "<unavailable>", {
        path = assertion.path, readSucceeded = okClass, confidence = okClass and 0.5 or 0,
      }, { okClass and "Target is not a GuiObject." or "GuiObject class check failed." })
    end
  end
  local ok, direct, readError = readProperty(instance, property)
  if not ok or type(direct) ~= "boolean" then
    return makeResult(assertion, false, expected, "<unavailable>", {
      path = assertion.path, property = property, readSucceeded = false, confidence = 0,
    }, { readError or (property .. " did not return a boolean.") })
  end

  local actual, blocker = direct, nil
  if assertion.kind == "gui-visible" and assertion.effective ~= false and direct then
    local current = instance
    for _ = 1, 64 do
      local okParent, parent, parentError = readProperty(current, "Parent")
      if not okParent then
        return makeResult(assertion, false, expected, "<unavailable>", {
          path = assertion.path, property = property, readSucceeded = false, confidence = 0,
        }, { parentError })
      end
      current = parent
      if current == nil or current == game then break end
      if not consumeRead() then
        return makeResult(assertion, false, expected, "<unavailable>", { readSucceeded = false }, { "Read budget exhausted during effective visibility check." })
      end
      local okGui, isGui = pcall(function() return current:IsA("GuiObject") end)
      if not okGui then
        return makeResult(assertion, false, expected, "<unavailable>", { readSucceeded = false }, { "Ancestor GUI class check failed." })
      end
      if isGui then
        local visibleOk, visible, visibleError = readProperty(current, "Visible")
        if not visibleOk then
          return makeResult(assertion, false, expected, "<unavailable>", { readSucceeded = false }, { visibleError })
        end
        if not visible then actual, blocker = false, fullName(current) .. ".Visible"; break end
      end
      if not consumeRead() then
        return makeResult(assertion, false, expected, "<unavailable>", { readSucceeded = false }, { "Read budget exhausted during LayerCollector check." })
      end
      local okLayer, isLayer = pcall(function() return current:IsA("LayerCollector") end)
      if not okLayer then
        return makeResult(assertion, false, expected, "<unavailable>", { readSucceeded = false }, { "LayerCollector class check failed." })
      end
      if isLayer then
        local enabledOk, enabled, enabledError = readProperty(current, "Enabled")
        if not enabledOk then
          return makeResult(assertion, false, expected, "<unavailable>", { readSucceeded = false }, { enabledError })
        end
        if not enabled then actual, blocker = false, fullName(current) .. ".Enabled"; break end
      end
    end
  end
  return makeResult(assertion, actual == expected, expected, actual, {
    path = assertion.path, resolvedPath = fullName(instance), property = property,
    direct = direct, effective = assertion.kind == "gui-visible" and assertion.effective ~= false,
    blocker = blocker, readSucceeded = true, complete = true, confidence = 0.95,
  }, {})
end

local function evaluateDescendant(assertion)
  local root, state, detail = resolve(assertion.path)
  local expected = assertion.expected
  if expected == nil then expected = true end
  if state ~= "found" then
    return makeResult(assertion, false, expected, "<unavailable>", {
      path = assertion.path, readSucceeded = false, confidence = 0,
    }, { "Descendant root could not be resolved: " .. detail })
  end
  local count, scanned, complete, match, scanError = scanDescendants(root, assertion.selector, true)
  if count == nil then
    return makeResult(assertion, false, expected, "<unavailable>", {
      path = assertion.path, scanned = scanned, readSucceeded = false, complete = false, confidence = 0,
    }, { scanError })
  end
  local exists = count > 0
  local proofComplete = exists or complete
  local errors = {}
  if not proofComplete then errors[#errors + 1] = scanError or "Descendant scan was incomplete." end
  return makeResult(assertion, proofComplete and exists == expected, expected, exists, {
    path = assertion.path, resolvedPath = fullName(root), selector = assertion.selector,
    match = match and fullName(match) or nil, scanned = scanned, readSucceeded = proofComplete,
    complete = proofComplete, confidence = proofComplete and 0.9 or 0,
  }, errors)
end

local function evaluateDistance(assertion)
  local target, state, detail = resolve(assertion.targetPath)
  if state ~= "found" then
    return makeResult(assertion, false, { operator = assertion.operator, distance = assertion.distance }, "<unavailable>", {
      targetPath = assertion.targetPath, readSucceeded = false, confidence = 0,
    }, { "Distance target could not be resolved: " .. detail })
  end
  local root, method, rootConfidence, rootError = characterRoot(assertion)
  if not root then
    return makeResult(assertion, false, { operator = assertion.operator, distance = assertion.distance }, "<unavailable>", {
      targetPath = assertion.targetPath, readSucceeded = false, confidence = 0,
    }, { rootError })
  end
  local rootPosition, rootPositionError = positionOf(root)
  local targetPosition, targetPositionError = positionOf(target)
  if not rootPosition or not targetPosition then
    return makeResult(assertion, false, { operator = assertion.operator, distance = assertion.distance }, "<unavailable>", {
      targetPath = assertion.targetPath, rootPath = fullName(root), readSucceeded = false, confidence = 0,
    }, { rootPositionError or targetPositionError })
  end
  local distance = (rootPosition - targetPosition).Magnitude
  local passed = assertion.operator == "at-most" and distance <= assertion.distance or distance >= assertion.distance
  return makeResult(assertion, passed, { operator = assertion.operator, distance = assertion.distance }, math.floor(distance * 1000 + 0.5) / 1000, {
    targetPath = fullName(target), rootPath = fullName(root), rootMethod = method,
    readSucceeded = true, complete = true, confidence = rootConfidence,
  }, {})
end

local function evaluateCamera(assertion)
  local target, state, detail = resolve(assertion.targetPath)
  if state ~= "found" then
    return makeResult(assertion, false, { atMostDegrees = assertion.maxAngleDegrees }, "<unavailable>", {
      targetPath = assertion.targetPath, readSucceeded = false, confidence = 0,
    }, { "Camera target could not be resolved: " .. detail })
  end
  local camera
  if assertion.cameraPath then
    local cameraState, cameraDetail
    camera, cameraState, cameraDetail = resolve(assertion.cameraPath)
    if cameraState ~= "found" then
      return makeResult(assertion, false, { atMostDegrees = assertion.maxAngleDegrees }, "<unavailable>", {
        cameraPath = assertion.cameraPath, readSucceeded = false, confidence = 0,
      }, { "Camera path could not be resolved: " .. cameraDetail })
    end
  else
    local ok, current, cameraError = readProperty(workspace, "CurrentCamera")
    if not ok or current == nil then
      return makeResult(assertion, false, { atMostDegrees = assertion.maxAngleDegrees }, "<unavailable>", {
        cameraPath = "workspace.CurrentCamera", readSucceeded = false, confidence = 0,
      }, { cameraError or "CurrentCamera is unavailable." })
    end
    camera = current
  end
  local targetPosition, targetError = positionOf(target)
  local okCFrame, cameraCFrame, cframeError = readProperty(camera, "CFrame")
  if not targetPosition or not okCFrame or typeof(cameraCFrame) ~= "CFrame" then
    return makeResult(assertion, false, { atMostDegrees = assertion.maxAngleDegrees }, "<unavailable>", {
      cameraPath = fullName(camera), targetPath = fullName(target), readSucceeded = false, confidence = 0,
    }, { targetError or cframeError or "Camera CFrame is unavailable." })
  end
  local delta = targetPosition - cameraCFrame.Position
  local angle = 0
  if delta.Magnitude > 0.0001 then
    local dot = math.clamp(cameraCFrame.LookVector:Dot(delta.Unit), -1, 1)
    angle = math.deg(math.acos(dot))
  end
  angle = math.floor(angle * 1000 + 0.5) / 1000
  return makeResult(assertion, angle <= assertion.maxAngleDegrees, { atMostDegrees = assertion.maxAngleDegrees }, angle, {
    cameraPath = fullName(camera), targetPath = fullName(target), readSucceeded = true,
    complete = true, confidence = 0.95,
  }, {})
end

local function evaluateCollection(assertion)
  local root, state, detail = resolve(assertion.path)
  local expected = { operator = assertion.operator, count = assertion.count }
  if state ~= "found" then
    return makeResult(assertion, false, expected, "<unavailable>", {
      path = assertion.path, readSucceeded = false, confidence = 0,
    }, { "Collection root could not be resolved: " .. detail })
  end
  local count, scanned, complete, firstMatch, scanError = 0, 0, true, nil, nil
  if (assertion.scope or "children") == "descendants" then
    count, scanned, complete, firstMatch, scanError = scanDescendants(root, assertion.selector, false)
    if count == nil then complete = false end
  else
    local children, childError = initialChildren(root)
    if children == nil then
      count, complete, scanError = nil, false, childError
    else
      scanned = #children
      for _, child in ipairs(children) do
        local okMatch, matched, matchError = selectorMatches(child, assertion.selector)
        if not okMatch then count, complete, scanError = nil, false, matchError; break end
        if matched then count = count + 1 end
      end
    end
  end
  if count == nil or not complete then
    return makeResult(assertion, false, expected, count or "<unavailable>", {
      path = assertion.path, scope = assertion.scope or "children", scanned = scanned,
      readSucceeded = false, complete = false, confidence = 0,
    }, { scanError or "Collection scan was incomplete." })
  end
  return makeResult(assertion, compareCount(count, assertion.count, assertion.operator), expected, count, {
    path = assertion.path, resolvedPath = fullName(root), scope = assertion.scope or "children",
    selector = assertion.selector, scanned = scanned, readSucceeded = true, complete = true, confidence = 0.9,
  }, {})
end

local function evaluate(assertion)
  if assertion.kind == "path-exists" or assertion.kind == "path-not-exists" then return evaluatePath(assertion) end
  if string.sub(assertion.kind, 1, 9) == "property-" then return evaluateProperty(assertion) end
  if assertion.kind == "attribute-equals" then return evaluateAttribute(assertion) end
  if assertion.kind == "gui-visible" or assertion.kind == "gui-enabled" then return evaluateGui(assertion) end
  if assertion.kind == "descendant-exists" then return evaluateDescendant(assertion) end
  if assertion.kind == "character-distance" then return evaluateDistance(assertion) end
  if assertion.kind == "camera-facing" then return evaluateCamera(assertion) end
  if assertion.kind == "collection-count" then return evaluateCollection(assertion) end
  return makeResult(assertion, false, "known assertion kind", assertion.kind, {
    readSucceeded = false, complete = false, confidence = 0,
  }, { "Unknown assertion kind." })
end

local results = {}
for index, assertion in ipairs(assertions) do
  local ok, result = pcall(function() return evaluate(assertion) end)
  if ok then
    results[index] = result
  else
    results[index] = makeResult(assertion, false, "successful live read", "<unavailable>", {
      readSucceeded = false, complete = false, confidence = 0,
    }, { "Assertion execution failed: " .. tostring(result) })
  end
end

return { results = results, reads = readCount, readBudget = readBudget, scanLimit = scanLimit }
`;
}
