import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import type { SemanticDocument } from "../../application/ports/semantic-index.js";

/**
 * Luau that harvests a lightweight "document" per loaded/GC script for indexing.
 * Because the clean protocol does not expose decompiled source, each document is
 * the script's full path + name + class, plus the string constants reachable from
 * its closure (via getscriptclosure/debug.getconstants) — capped to keep payloads
 * small. Everything is pcall-guarded so one bad script never sinks the batch.
 */
function harvestLuau(maxScripts: number): string {
  return `
local __ok, __result = pcall(function()
  local docs = {}
  local seen = {}
  local maxScripts = ${maxScripts}
  local maxConstChars = 4000

  local getscripts = rawget(getfenv(), "getscripts") or getscripts
  local getgc = rawget(getfenv(), "getgc") or getgc
  local getscriptclosure = rawget(getfenv(), "getscriptclosure")
    or rawget(getfenv(), "getscriptfunction")

  local function collectConstants(closure)
    if type(closure) ~= "function" then return "" end
    local okC, consts = pcall(function()
      return debug.getconstants(closure)
    end)
    if not okC or type(consts) ~= "table" then return "" end
    local parts = {}
    local total = 0
    for _, value in pairs(consts) do
      if type(value) == "string" and #value > 1 then
        parts[#parts + 1] = value
        total = total + #value
        if total >= maxConstChars then break end
      end
    end
    return table.concat(parts, " ")
  end

  local function addScript(inst)
    if typeof(inst) ~= "Instance" then return end
    if not inst:IsA("LuaSourceContainer") then return end
    if seen[inst] then return end
    seen[inst] = true
    if #docs >= maxScripts then return end

    local okPath, path = pcall(function() return inst:GetFullName() end)
    if not okPath then path = tostring(inst) end
    local className = inst.ClassName
    local name = inst.Name

    local constants = ""
    if getscriptclosure then
      local okClosure, closure = pcall(getscriptclosure, inst)
      if okClosure then
        constants = collectConstants(closure)
      end
    end

    local text = path .. " " .. name .. " " .. className
    if #constants > 0 then
      text = text .. " " .. constants
    end
    docs[#docs + 1] = { path = path, text = text }
  end

  if type(getscripts) == "function" then
    local okS, scripts = pcall(getscripts)
    if okS and type(scripts) == "table" then
      for _, inst in ipairs(scripts) do
        addScript(inst)
        if #docs >= maxScripts then break end
      end
    end
  end

  if #docs < maxScripts and type(getgc) == "function" then
    local okG, objects = pcall(getgc, false)
    if okG and type(objects) == "table" then
      for _, obj in ipairs(objects) do
        if #docs >= maxScripts then break end
        addScript(obj)
      end
    end
  end

  return docs
end)

if __ok then
  return __result
end
return {}
`;
}

export default defineTool({
  name: "semantic-search-scripts",
  title: "Semantic search over loaded scripts",
  description:
    "Rank the active client's loaded/GC scripts by semantic relevance to a natural-language query. " +
    "NOTE: full decompiled source is NOT available in the clean protocol, so each script is indexed over its " +
    "GetFullName() path + Name + ClassName + the string constants reachable from its closure (capped per script) " +
    "— think of it as 'find the script most likely about X', not a full-text code search. The first call embeds " +
    "and caches every script (locally or via the configured embeddings endpoint); later calls reuse the cache for " +
    "unchanged scripts. Returns { hits: [{ path, score, snippet }], model } sorted by descending cosine similarity.",
  category: "Semantic Search",
  input: z.object({
    query: z
      .string()
      .min(1)
      .describe("Natural-language description of the script you are looking for."),
    limit: z
      .number()
      .int()
      .optional()
      .default(10)
      .describe("Maximum number of ranked hits to return."),
    maxScripts: z
      .number()
      .int()
      .optional()
      .default(400)
      .describe("Cap on how many scripts to harvest and index from the client."),
  }),
  requiresClient: true,
  async execute({ query, limit, maxScripts }, ctx) {
    const raw = await ctx.runLuau(harvestLuau(maxScripts));
    const documents = toDocuments(raw);
    const clientId = ctx.client!.id;
    const hits = await ctx.semantic.search(clientId, query, limit, documents);
    const model = ctx.semantic.stats(clientId).model;
    return {
      data: { hits, model },
      summary: `${hits.length} hit(s) over ${documents.length} indexed script(s).`,
    };
  },
});

/** Coerce the Luau harvest result into a clean, typed document list. */
function toDocuments(raw: unknown): SemanticDocument[] {
  if (!Array.isArray(raw)) return [];
  const documents: SemanticDocument[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as { path?: unknown; text?: unknown };
    if (typeof record.path !== "string" || typeof record.text !== "string") continue;
    documents.push({ path: record.path, text: record.text });
  }
  return documents;
}
