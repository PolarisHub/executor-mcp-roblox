import { describe, expect, it } from "vitest";

import type { LuauOptions, ToolContext } from "../../../src/application/tool/tool.js";
import executionFootprintAudit from "../../../src/tools/diagnostics/execution-footprint-audit.js";
import { silentLogger } from "../../helpers/fakes.js";

function mockContext(
  returnValue: unknown = { risk: { score: 12, band: "low", confidence: "medium" } },
): {
  ctx: ToolContext;
  calls: Array<{ source: string; options?: LuauOptions }>;
} {
  const calls: Array<{ source: string; options?: LuauOptions }> = [];
  const ctx = {
    logger: silentLogger(),
    signal: new AbortController().signal,
    async runLuau(source: string, options?: LuauOptions) {
      calls.push({ source, options });
      return returnValue;
    },
  } as unknown as ToolContext;
  return { ctx, calls };
}

async function generatedSource(input: Record<string, unknown> = {}) {
  const parsed = executionFootprintAudit.input.parse(input);
  const { ctx, calls } = mockContext();
  const result = await executionFootprintAudit.execute(parsed, ctx);
  return { source: calls[0]?.source ?? "", options: calls[0]?.options, result, calls };
}

describe("execution-footprint-audit", () => {
  it("is a client-bound, read-only Diagnostics tool with an honest detection boundary", () => {
    expect(executionFootprintAudit.name).toBe("execution-footprint-audit");
    expect(executionFootprintAudit.category).toBe("Diagnostics");
    expect(executionFootprintAudit.requiresClient).toBe(true);
    expect(executionFootprintAudit.mutatesState).toBe(false);
    expect(executionFootprintAudit.description).toContain("READ-ONLY");
    expect(executionFootprintAudit.description).toContain("does NOT prove");
    expect(executionFootprintAudit.description).toContain("not an undetectability guarantee");
  });

  it("generates one concrete bounded Luau call with safe defaults", async () => {
    const { source, options, calls, result } = await generatedSource({ threadContext: 7 });
    expect(calls).toHaveLength(1);
    expect(options).toEqual({ threadContext: 7, timeoutMs: 30000 });
    expect(source).not.toContain("undefined");
    expect(source).toContain("maxStackFrames = 8");
    expect(source).toContain("maxEvidence = 100");
    expect(source).toContain("maxEnvironmentKeys = 120");
    expect(source).toContain("maxSourceChars = 60000");
    expect(source).toContain("maxConstants = 96");
    expect(source).toContain("maxUpvalues = 64");
    expect(result.summary).toContain("12/100 (low, medium confidence)");
  });

  it("quotes target expressions and never invokes the selected target closure", async () => {
    const { source } = await generatedSource({
      scriptPath: 'game.Players.LocalPlayer.PlayerScripts["MainScript"]',
      functionPath: 'getsenv(game.Players.LocalPlayer.PlayerScripts.Main)["run"]',
    });
    expect(source).toContain(
      String.raw`scriptExpression = "game.Players.LocalPlayer.PlayerScripts[\"MainScript\"]"`,
    );
    expect(source).toContain(
      String.raw`functionExpression = "getsenv(game.Players.LocalPlayer.PlayerScripts.Main)[\"run\"]"`,
    );
    expect(source).toContain('evaluateExpression(CONFIG.functionExpression, "function")');
    expect(source).not.toContain("pcall(selectedClosure");
    expect(source).not.toContain("pcall(explicitFunction");
    expect(source).not.toContain("selectedClosure(");
  });

  it("does not send virtual input, scan descendants/GC, hook, or create a frame loop", async () => {
    const { source } = await generatedSource();
    expect(source).not.toContain("GetDescendants");
    expect(source).not.toContain("getgc(");
    expect(source).not.toContain("RenderStepped:Connect");
    expect(source).not.toContain("Heartbeat:Connect");
    expect(source).not.toContain("hookfunction(");
    expect(source).not.toContain("hookmetamethod(");
    for (const primitive of [
      "keypress",
      "keyrelease",
      "keyclick",
      "mouse1click",
      "mouse2click",
      "mousemoveabs",
      "mousemoverel",
      "mousescroll",
    ]) {
      expect(source).not.toContain(`${primitive}(`);
    }
    expect(source).toContain("noInputSent = true");
    expect(source).toContain("noTargetInvocation = true");
  });

  it("audits complete Volt input provenance and direct versus alternate Instance references", async () => {
    const { source } = await generatedSource();
    for (const primitive of [
      "iswindowactive",
      "keypress",
      "keyrelease",
      "keyclick",
      "mouse1press",
      "mouse1release",
      "mouse1click",
      "mouse2press",
      "mouse2release",
      "mouse2click",
      "mousescroll",
      "mousemoverel",
      "mousemoveabs",
    ]) {
      expect(source).toContain(`"${primitive}"`);
    }
    expect(source).toContain('"VirtualInputManager", "VirtualUser", "UserInputService"');
    expect(source).toContain("service.CreateVirtualInput");
    expect(source).toContain('return "direct"');
    expect(source).toContain('return "cloned-or-alternate"');
    expect(source).toContain("pcall(F.compareinstances, value, rawService)");
    expect(source).not.toContain("pcall(F.cloneref");
  });

  it("compares functions with one bounded retained-registry snapshot without exposing keys", async () => {
    const { source } = await generatedSource({ maxEnvironmentKeys: 40 });
    expect(source).toContain("genv.__mcp_closure_refs");
    expect(source).toContain("local retainedEntries = {}");
    expect(source).toContain("if scanned >= CONFIG.maxRetainedRefs then");
    expect(source).toContain("candidate.fn == fn");
    expect(source).toContain("candidate.hash == hash");
    expect(source).toContain('matchKind = "identity"');
    expect(source).toContain('matchKind = "hash"');
    expect(source).toContain("ordinal = candidate.ordinal");
    expect(source).not.toContain("registryKey");
    expect(source).toContain("cloning is not a safety recommendation");
  });

  it("bounds getfenv/getsenv leak checks and returns names/types rather than captured values", async () => {
    const { source } = await generatedSource({
      maxStackFrames: 5,
      maxEnvironmentKeys: 25,
      maxUpvalues: 20,
    });
    expect(source).toContain("for level = 0, CONFIG.maxStackFrames - 1 do");
    expect(source).toContain("if output.keyCount >= CONFIG.maxEnvironmentKeys then");
    expect(source).toContain('inspectEnvironment("target-script-getsenv"');
    expect(source).toContain('inspectEnvironment("target-function-getfenv"');
    expect(source).toContain("valueType = typeof(value)");
    expect(source).toContain("redactedSensitiveKeyNames");
    expect(source).toContain("<redacted-sensitive-key-name>");
    expect(source).toContain("sameAsGetgenv");
    expect(source).toContain("sameAsGetrenv");
    expect(source).toContain("reusedAcrossFrames");
    expect(source).toContain("currentStackReuseCount");
    expect(source).toContain("getfenv reads can deoptimize");
    expect(source).not.toContain("capturedValue");
    expect(source).not.toContain("environmentValues");
  });

  it("guards and bounds closure identity, hook, constant, and upvalue checks", async () => {
    const { source } = await generatedSource({ maxConstants: 17, maxUpvalues: 9 });
    for (const capability of [
      "iscclosure",
      "islclosure",
      "isexecutorclosure",
      "isnewcclosure",
      "isfunctionhooked",
      "getfunctionhash",
      "getconstants",
      "getupvalues",
      "getinfo",
    ]) {
      expect(source).toContain(`${capability} =`);
    }
    expect(source).toContain("isFunctionHooked = safePredicate(F.isfunctionhooked, fn)");
    expect(source).toContain('"input-global-hooked-" .. name');
    expect(source).toContain("if seen >= CONFIG.maxConstants then");
    expect(source).toContain("if scanned >= CONFIG.maxUpvalues then");
    expect(source).toContain("maxConstants = 17");
    expect(source).toContain("maxUpvalues = 9");
  });

  it("uses privacy-safe bounded source indicators and explicit heuristic findings", async () => {
    const { source } = await generatedSource({ maxEvidence: 30, maxSourceChars: 4000 });
    expect(source).toContain(
      "sourceEvidenceLimit = math.max(1, math.floor(CONFIG.maxEvidence / 2))",
    );
    expect(source).toContain("string.sub(sourceText, 1, CONFIG.maxSourceChars)");
    expect(source).toContain("redactSnippet(rawText)");
    expect(source).toContain("<url:redacted>");
    expect(source).toContain("<redacted:string>");
    expect(source).toContain("<redacted:matching-string-constant>");
    expect(source).toContain(String.raw`string.gmatch(sourceText .. "\n", "([^\r\n]*)\r?\n")`);
    expect(source).toContain("evidenceCount >= CONFIG.maxEvidence");
    expect(source).toContain('"heuristic"');
    expect(source).toContain('id = "executor-fingerprint"');
    expect(source).toContain("detectionProven = false");
    expect(source).toContain("cleanReportGuaranteesUndetected = false");
  });

  it("clamps direct execute calls even when they bypass schema parsing", async () => {
    const { ctx, calls } = mockContext();
    await executionFootprintAudit.execute(
      {
        includeSourceScan: true,
        includeStackEnvironments: true,
        maxStackFrames: 999,
        maxEvidence: 999,
        maxEnvironmentKeys: 999,
        maxSourceChars: 999999,
        maxConstants: 999,
        maxUpvalues: 999,
      },
      ctx,
    );
    const source = calls[0]?.source ?? "";
    expect(source).toContain("maxStackFrames = 32");
    expect(source).toContain("maxEvidence = 250");
    expect(source).toContain("maxEnvironmentKeys = 400");
    expect(source).toContain("maxSourceChars = 200000");
    expect(source).toContain("maxConstants = 256");
    expect(source).toContain("maxUpvalues = 128");
  });

  it("can disable optional source and stack probing while keeping the audit concrete", async () => {
    const { source } = await generatedSource({
      includeSourceScan: false,
      includeStackEnvironments: false,
      maxStackFrames: 0,
    });
    expect(source).toContain("includeSourceScan = false");
    expect(source).toContain("includeStackEnvironments = false");
    expect(source).toContain("maxStackFrames = 0");
    expect(source).not.toContain("undefined");
  });
});
