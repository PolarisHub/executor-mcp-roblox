import type { ToolContract } from "./tool.js";

interface ContractInput {
  readonly name: string;
  readonly category: string;
  readonly requiresClient?: boolean;
  readonly mutatesState?: boolean;
}

/** Conservative defaults keep all legacy tools usable without hand-authoring metadata for each one. */
export function inferToolContract(tool: ContractInput): ToolContract {
  const name = tool.name.toLowerCase();
  const isOrchestration = name === "script" || name.includes("playbook") || name.includes("batch");
  const isVerification = /(^|-)verify|diff|snapshot|diagnostic|test-capabilities/.test(name);
  const phase = isOrchestration
    ? "orchestrate"
    : isVerification
      ? "verify"
      : tool.mutatesState
        ? "act"
        : "observe";
  const prerequisites = tool.requiresClient === false ? [] : ["active-client"];
  const produces: string[] = [];
  if (/search|find|discover|list|tree/.test(name)) produces.push("candidates");
  if (/path|instance|gui|remote/.test(name)) produces.push("paths-or-targets");
  if (/player|value|stats|money/.test(name)) produces.push("player-values");
  const verifiesWith: string[] = [];
  if (
    name === "set-instance-property" ||
    name === "set-attribute" ||
    name === "set-properties-bulk"
  ) {
    verifiesWith.push("get-instance-properties");
  }
  if (name === "set-gui-text" || name === "type-text-box" || name === "click-button") {
    verifiesWith.push("get-gui-text");
  }
  const alternatives: string[] = [];
  const requiresCapabilities: string[] = [];
  if (name === "click-button") {
    requiresCapabilities.push("firesignal");
    alternatives.push("virtual-input");
  }
  if (name === "fire-click-detector") requiresCapabilities.push("fireclickdetector");
  if (name === "fire-proximity-prompt") requiresCapabilities.push("fireproximityprompt");
  if (name === "virtual-input" || name === "press-key") {
    requiresCapabilities.push("VirtualInputManager");
  }
  const sideEffects = tool.mutatesState ? ["writes live game/client state"] : [];
  const failureRecovery = [
    ...(tool.requiresClient === false
      ? []
      : ["confirm agent-context reports readyForClientTools=true"]),
    ...(requiresCapabilities.length > 0
      ? ["run test-capabilities and use an alternative if unavailable"]
      : []),
    ...(verifiesWith.length > 0 ? [`run ${verifiesWith[0]} after success`] : []),
    ...(tool.mutatesState && verifiesWith.length === 0
      ? ["use assert-state with an explicit goal predicate after the mutation"]
      : []),
  ];
  return {
    phase,
    prerequisites,
    consumes: produces.length > 0 ? ["goal or target selection"] : [],
    produces,
    verifiesWith,
    alternatives,
    requiresCapabilities,
    sideEffects,
    failureRecovery,
  };
}
