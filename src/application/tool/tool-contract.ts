import { z } from "zod";

import type { ToolContract } from "./tool.js";

interface ContractInput {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly category: string;
  readonly input?: z.ZodTypeAny;
  readonly requiresClient?: boolean;
  readonly mutatesState?: boolean;
}

const unique = (values: readonly string[]): string[] => [...new Set(values.filter(Boolean))];

function fieldNames(schema: z.ZodTypeAny | undefined): string[] {
  if (!(schema instanceof z.ZodObject)) return [];
  return Object.keys((schema as z.ZodObject<z.ZodRawShape>).shape);
}

function consumedValue(field: string): string {
  const name = field.toLowerCase();
  if (name === "clientid" || name === "username") return "client-selection";
  if (name.includes("function") && (name.includes("path") || name.includes("expression"))) {
    return "function-reference";
  }
  if (name.includes("script") || name.includes("module")) return "script-or-module-reference";
  if (name.includes("path")) return "validated-target-path";
  if (name === "source" || name === "code") return "Luau-source";
  if (name.includes("query") || name === "search" || name === "keyword") return "search-intent";
  if (name === "arguments" || name === "args" || name.includes("value")) return "typed-values";
  if (name.includes("state")) return "state-reference";
  if (name === "action" || name === "operation") return "requested-operation";
  if (name === "confirm") return "mutation-approval";
  if (name === "limit" || name.startsWith("max") || name.includes("timeout")) {
    return "execution-budget";
  }
  if (name.startsWith("include") || name.startsWith("filter")) return "filter-options";
  if (name.endsWith("id") || name === "key" || name === "name") return "stable-identifier";
  return "validated-input";
}

function producedValues(name: string, category: string): string[] {
  const values: string[] = [];
  if (/plan|suggest|schema|agent-context|explain/.test(name)) values.push("agent-guidance");
  if (/monitor|watch|spy|trace/.test(name)) values.push("bounded-event-snapshot");
  if (/search|find|discover|list|scan|tree/.test(name)) values.push("bounded-candidates");
  if (/get|read|inspect|dump|decompile|disassemble|lookup|compare|check|is-/.test(name)) {
    values.push("structured-observation");
  }
  if (/create|clone|new-|connect/.test(name)) values.push("created-handle");
  if (/set|write|append|delete|destroy|clear|block|fire|invoke|call|execute|run|send/.test(name)) {
    values.push("operation-receipt");
  }
  if (category === "Diagnostics") values.push("diagnostic-report");
  if (category === "Intelligence") values.push("grounded-evidence");
  return unique(values.length > 0 ? values : ["structured-result"]);
}

function capabilityRequirements(name: string): string[] {
  const requirements: string[] = [];
  if (/virtual-input|press-key|type-text-box/.test(name)) requirements.push("VirtualInputManager");
  if (name.includes("actor")) requirements.push("getactors");
  if (name.includes("lua-state")) requirements.push("getluastate");
  if (name.includes("comm-channel")) requirements.push("create_comm_channel");
  if (/decompile|get-module-source|get-script-content/.test(name)) requirements.push("decompile");
  if (name.includes("bytecode")) requirements.push("getscriptbytecode");
  if (/gc-|getgc|closures-by|filter-gc/.test(name)) requirements.push("getgc");
  if (/closure|function-hash|function-proto|upvalue|constant/.test(name)) {
    requirements.push("debug closure primitives");
  }
  if (/metatable|metamethod/.test(name)) requirements.push("getrawmetatable");
  if (/connection|signal/.test(name)) requirements.push("getconnections");
  if (name === "click-button" || /fire-signal|replicate-signal/.test(name)) {
    requirements.push("firesignal");
  }
  if (name.includes("fire-click-detector")) requirements.push("fireclickdetector");
  if (name.includes("fire-proximity-prompt")) requirements.push("fireproximityprompt");
  if (/^read-file|^load-file|file-exists|list-files/.test(name)) requirements.push("readfile");
  if (/write-file|append-file|make-folder|delete-file|delete-folder/.test(name)) {
    requirements.push("executor filesystem");
  }
  if (/^draw-|list-drawings/.test(name)) requirements.push("Drawing");
  if (name.startsWith("ws-")) requirements.push("WebSocket");
  if (name.includes("http-request")) requirements.push("request");
  if (name.includes("packet")) requirements.push("RakNet packet APIs");
  return unique(requirements);
}

function verificationTools(name: string, mutates: boolean): string[] {
  const tools: string[] = [];
  if (
    /set-instance-property|set-attribute|set-properties-bulk|create-instance|clone-instance/.test(
      name,
    )
  ) {
    tools.push("get-instance-properties");
  }
  if (name.includes("destroy-instance")) tools.push("verify-path-exists");
  if (/set-gui-text|type-text-box|click-button/.test(name)) tools.push("get-gui-text");
  if (/write-file|append-file|make-folder|delete-file|delete-folder/.test(name)) {
    tools.push("file-exists");
  }
  if (name.includes("draw-")) tools.push("list-drawings");
  if (/hook|restore-function|set-stack-hidden/.test(name)) tools.push("is-function-hooked");
  if (/ws-connect|ws-close/.test(name)) tools.push("ws-list");
  if (/run-on-actor|execute-lua-state/.test(name)) tools.push("get-lua-state");
  if (mutates && tools.length === 0) tools.push("assert-state");
  return unique(tools);
}

function alternativeTools(name: string): string[] {
  if (name === "click-button") return ["virtual-input", "fire-signal"];
  if (name === "virtual-input" || name === "press-key") return ["click-button", "type-text-box"];
  if (/decompile|get-module-source/.test(name))
    return ["get-script-bytecode", "disassemble-function"];
  if (name.includes("search-instances")) return ["observe-world", "get-instance-tree"];
  if (name.includes("get-local-player-info")) return ["discover-character", "get-players"];
  if (/run-luau|^execute$/.test(name)) return ["script", "eval-expression"];
  if (name.includes("monitor-remote")) return ["ensure-remote-spy", "trace-remote-traffic"];
  return [];
}

function sideEffectsFor(tool: ContractInput): string[] {
  if (!tool.mutatesState) return [];
  const name = tool.name.toLowerCase();
  if (/file|folder|custom-asset/.test(name)) return ["writes executor workspace filesystem"];
  if (/http|ws-|packet/.test(name)) return ["performs external network or socket I/O"];
  if (name.includes("draw-")) return ["changes executor drawing overlay state"];
  if (/monitor|watch|spy|hook|capture/.test(name)) {
    return ["changes persistent executor-side observer or hook state"];
  }
  if (/playbook|session|agent-memory/.test(name))
    return ["changes server-side persisted/session state"];
  if (/run|execute|call-closure|invoke/.test(name))
    return ["executes caller-selected behavior in the live client"];
  return ["writes live game/client state"];
}

/** Conservative but complete defaults keep every tool useful to an AI without hand-authored metadata. */
export function inferToolContract(tool: ContractInput): ToolContract {
  const name = tool.name.toLowerCase();
  const fields = fieldNames(tool.input);
  const corpus = `${name} ${tool.title ?? ""} ${tool.description ?? ""}`.toLowerCase();
  const isOrchestration =
    /script|playbook|batch|fanout|agent-run|smart-task|teach-mode|transaction/.test(name);
  const isVerification = /(^|-)verify|diff|snapshot|diagnostic|capabilities|assert|audit/.test(
    name,
  );
  const phase = isOrchestration
    ? "orchestrate"
    : isVerification
      ? "verify"
      : tool.mutatesState
        ? "act"
        : "observe";

  const prerequisites: string[] = tool.requiresClient === false ? [] : ["active-client"];
  if (fields.some((field) => field.toLowerCase().includes("path")))
    prerequisites.push("resolved-target");
  if (tool.mutatesState) prerequisites.push("explicit-mutation-approval");
  if (fields.some((field) => field === "source" || field === "code")) {
    prerequisites.push("validated-source");
  }

  const consumes = unique(fields.map(consumedValue));
  if (consumes.length === 0) {
    consumes.push(
      tool.requiresClient === false ? "server-session-context" : "current-live-client-state",
    );
  }

  const produces = producedValues(name, tool.category);
  const verifiesWith = verificationTools(name, tool.mutatesState === true);
  const alternatives = alternativeTools(name);
  const requiresCapabilities = capabilityRequirements(name);
  const sideEffects = sideEffectsFor(tool);
  const failureRecovery = [
    "inspect tool-schema for exact fields, defaults, constraints, and an invocation example",
    ...(tool.requiresClient === false
      ? []
      : ["confirm agent-context reports readyForClientTools=true and re-resolve stale targets"]),
    ...(requiresCapabilities.length > 0
      ? ["run test-capabilities and choose a listed alternative when a primitive is unavailable"]
      : []),
    ...(fields.some((field) => /limit|max|timeout/i.test(field)) ||
    /scan|search|list|tree/.test(corpus)
      ? ["reduce limits or scope when the result is truncated, slow, or bridge-constrained"]
      : []),
    ...(tool.mutatesState
      ? ["do not repeat the same mutation blindly; verify the postcondition or use explain-failure"]
      : ["treat missing fields and capability warnings as unknown evidence, not success"]),
    ...(verifiesWith.length > 0 ? [`verify success with ${verifiesWith.join(" or ")}`] : []),
  ];

  return {
    phase,
    prerequisites: unique(prerequisites),
    consumes,
    produces,
    verifiesWith,
    alternatives,
    requiresCapabilities,
    sideEffects,
    failureRecovery: unique(failureRecovery),
  };
}

function mergeList(base: readonly string[], override: readonly string[] | undefined): string[] {
  return unique([...base, ...(override ?? [])]);
}

/** Merge author hints additively so an empty override cannot erase essential safety/recovery metadata. */
export function mergeToolContract(
  inferred: ToolContract,
  override: Partial<ToolContract> | undefined,
): ToolContract {
  if (!override) return inferred;
  return {
    phase: override.phase ?? inferred.phase,
    prerequisites: mergeList(inferred.prerequisites, override.prerequisites),
    consumes: mergeList(inferred.consumes, override.consumes),
    produces: mergeList(inferred.produces, override.produces),
    verifiesWith: mergeList(inferred.verifiesWith, override.verifiesWith),
    alternatives: mergeList(inferred.alternatives, override.alternatives),
    requiresCapabilities: mergeList(inferred.requiresCapabilities, override.requiresCapabilities),
    sideEffects: mergeList(inferred.sideEffects, override.sideEffects),
    failureRecovery: mergeList(inferred.failureRecovery, override.failureRecovery),
  };
}
