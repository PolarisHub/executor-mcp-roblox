interface DiscoveryTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly mutatesState?: boolean;
  readonly requiresClient?: boolean;
}

export interface RankedTool<T extends DiscoveryTool = DiscoveryTool> {
  readonly tool: T;
  readonly score: number;
  readonly matchedTerms: readonly string[];
  readonly why: string;
}

export interface WorkflowStep {
  readonly tool: string;
  readonly why: string;
  readonly phase: "discover" | "act" | "verify" | "recover";
}

export interface WorkflowMatch {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly steps: readonly WorkflowStep[];
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "can",
  "do",
  "for",
  "from",
  "how",
  "i",
  "in",
  "into",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "please",
  "the",
  "this",
  "to",
  "with",
  "you",
]);

/** Natural-language aliases that occur often in Roblox debugging requests. */
const ALIAS_GROUPS: readonly string[][] = [
  ["inspect", "examine", "look", "read", "check", "show"],
  ["find", "search", "locate", "where", "discover"],
  ["instance", "object", "part", "model", "component"],
  ["gui", "ui", "interface", "button", "menu", "screen"],
  ["click", "tap", "press", "input", "mouse", "keyboard", "touch"],
  ["camera", "view", "aim", "lookat", "fov"],
  ["script", "source", "code", "module", "bytecode", "decompile"],
  ["remote", "remotes", "network", "event", "fire", "invoke", "rpc"],
  ["player", "character", "user", "account"],
  ["money", "cash", "coins", "currency", "score", "xp", "value", "stats"],
  ["hook", "trace", "monitor", "log", "spy", "connection", "signal"],
  ["memory", "gc", "garbage", "closure", "upvalue", "constant"],
  ["performance", "fps", "latency", "lag", "render", "diagnostic", "health"],
  ["set", "change", "write", "edit", "modify", "update", "create", "destroy"],
  ["observe", "perceive", "scan", "world", "scene", "nearby", "visible"],
  ["verify", "assert", "prove", "confirm", "validate"],
  ["recover", "fallback", "repair", "failure", "error"],
  ["teach", "record", "demonstrate", "learn", "playbook", "macro"],
];

const ALIAS_INDEX = new Map<string, readonly string[]>();
for (const group of ALIAS_GROUPS) {
  for (const term of group) ALIAS_INDEX.set(term, group);
}

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function toolText(tool: DiscoveryTool): {
  name: string;
  title: string;
  category: string;
  description: string;
} {
  return {
    name: tool.name.toLowerCase(),
    title: tool.title.toLowerCase(),
    category: tool.category.toLowerCase(),
    description: tool.description.toLowerCase(),
  };
}

function matchesTerm(term: string, field: string, fieldTokens: readonly string[]): boolean {
  return fieldTokens.includes(term) || field.includes(term);
}

/**
 * Rank tools against a natural-language goal. Exact tool-name hits dominate,
 * while the small alias vocabulary makes requests such as "find my cash" land
 * on player-value discovery tools instead of requiring the word "currency".
 */
export function rankTools<T extends DiscoveryTool>(
  query: string,
  tools: readonly T[],
  limit = 10,
): readonly RankedTool<T>[] {
  const queryTerms = [...new Set(tokens(query))];
  const queryLower = query.toLowerCase();
  return tools
    .map((tool) => {
      const fields = toolText(tool);
      const nameTokens = tokens(fields.name.replace(/-/g, " "));
      const titleTokens = tokens(fields.title);
      const categoryTokens = tokens(fields.category.replace(/&/g, " "));
      const descriptionTokens = tokens(fields.description);
      const matched = new Set<string>();
      let score = 0;

      if (queryLower.includes(fields.name)) score += 80;
      for (const term of queryTerms) {
        if (matchesTerm(term, fields.name, nameTokens)) {
          score += 28;
          matched.add(term);
        } else if (matchesTerm(term, fields.title, titleTokens)) {
          score += 18;
          matched.add(term);
        } else if (matchesTerm(term, fields.category, categoryTokens)) {
          score += 12;
          matched.add(term);
        } else if (matchesTerm(term, fields.description, descriptionTokens)) {
          score += 7;
          matched.add(term);
        }

        const aliases = ALIAS_INDEX.get(term);
        if (aliases) {
          const aliasHit = aliases.find(
            (alias) =>
              matchesTerm(alias, fields.name, nameTokens) ||
              matchesTerm(alias, fields.title, titleTokens) ||
              matchesTerm(alias, fields.category, categoryTokens) ||
              matchesTerm(alias, fields.description, descriptionTokens),
          );
          if (aliasHit && !matched.has(term)) {
            score += 4;
            matched.add(`${term}→${aliasHit}`);
          }
        }
      }

      const matchedTerms = [...matched];
      const why = matchedTerms.length
        ? `Matched ${matchedTerms.slice(0, 5).join(", ")}.`
        : "Broad catalog candidate; inspect its schema before calling.";
      return { tool, score, matchedTerms, why };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, Math.max(1, Math.min(limit, 50)));
}

const WORKFLOWS: readonly (WorkflowMatch & { readonly patterns: readonly RegExp[] })[] = [
  {
    id: "inspect-instance",
    title: "Find and understand an in-game object",
    description:
      "Locate the target first, inspect its properties, then verify the exact path or subtree before editing it.",
    patterns: [
      /\b(inspect|examine|find|locate|where|property|properties|instance|object|part|model)\b/i,
    ],
    steps: [
      {
        tool: "observe-world",
        phase: "discover",
        why: "Build one compact world, character, camera, GUI, and interactable snapshot.",
      },
      {
        tool: "search-instances",
        phase: "discover",
        why: "Find likely instances by class/name/property.",
      },
      {
        tool: "get-instance-properties",
        phase: "discover",
        why: "Read the target's common properties and attributes.",
      },
      {
        tool: "get-instance-tree",
        phase: "verify",
        why: "Confirm surrounding structure and child paths.",
      },
    ],
  },
  {
    id: "interact-with-client",
    title: "Drive the local game like a player",
    description:
      "Discover UI targets, use the most specific interaction, then verify the resulting state.",
    patterns: [
      /\b(click|tap|press|type|input|mouse|keyboard|touch|camera|gui|ui|menu|button|move)\b/i,
    ],
    steps: [
      {
        tool: "observe-world",
        phase: "discover",
        why: "Ground the task in visible GUI, nearby 3D targets, and the current custom character.",
      },
      {
        tool: "list-gui-elements",
        phase: "discover",
        why: "Enumerate visible GUI targets and paths.",
      },
      {
        tool: "click-button",
        phase: "act",
        why: "Use semantic button activation when the target is a GuiButton.",
      },
      {
        tool: "virtual-input",
        phase: "act",
        why: "Use low-level keyboard, mouse, touch, or gamepad input when needed.",
      },
      {
        tool: "camera-control",
        phase: "act",
        why: "Read or move the local camera when the task involves view or aim.",
      },
      {
        tool: "assert-state",
        phase: "verify",
        why: "Prove the intended game or UI state changed after the interaction.",
      },
    ],
  },
  {
    id: "adaptive-goal",
    title: "Run a bounded, self-correcting game task",
    description:
      "Observe current state, execute an approved adaptive plan, prove the outcome, and classify failures instead of retrying blindly.",
    patterns: [
      /\b(goal|task|workflow|autopilot|automatic|adapt|replan|recover|verify|assert|prove)\b/i,
    ],
    steps: [
      {
        tool: "observe-world",
        phase: "discover",
        why: "Create grounded semantic targets and a compact state baseline.",
      },
      {
        tool: "smart-task",
        phase: "act",
        why: "Execute explicit steps under call, time, mutation, and loop budgets.",
      },
      {
        tool: "assert-state",
        phase: "verify",
        why: "Evaluate actual success predicates rather than tool-return status.",
      },
      {
        tool: "explain-failure",
        phase: "recover",
        why: "Classify failed evidence and select a non-repeating fallback.",
      },
    ],
  },
  {
    id: "teach-workflow",
    title: "Learn a reusable workflow from a demonstration",
    description:
      "Record bounded input and game events, then generate a conservative semantic playbook for review.",
    patterns: [
      /\b(teach|record|demonstrate|demonstration|learn|macro|repeat what i do|playback)\b/i,
    ],
    steps: [
      {
        tool: "teach-mode",
        phase: "discover",
        why: "Capture the demonstration and infer guarded semantic actions.",
      },
      {
        tool: "assert-state",
        phase: "verify",
        why: "Attach explicit success checks before replaying the learned playbook.",
      },
    ],
  },
  {
    id: "understand-remote",
    title: "Understand or safely exercise a remote",
    description:
      "Inventory remotes, infer the signature, observe traffic, and only then invoke the remote if necessary.",
    patterns: [/\b(remote|remotes|network|rpc|fire|invoke|spy|traffic|listener)\b/i],
    steps: [
      {
        tool: "list-remotes",
        phase: "discover",
        why: "Inventory RemoteEvent and RemoteFunction targets.",
      },
      {
        tool: "get-remote-signature",
        phase: "discover",
        why: "Inspect callback/signature clues before constructing arguments.",
      },
      {
        tool: "monitor-remote",
        phase: "discover",
        why: "Capture live calls when the signature is unclear.",
      },
      {
        tool: "fire-remote",
        phase: "act",
        why: "Invoke the selected remote only after the target and arguments are understood.",
      },
    ],
  },
  {
    id: "reverse-engineer",
    title: "Trace code from a behavior or symbol",
    description:
      "Search source/instances first, then inspect module source, bytecode, closures, or cross-references as needed.",
    patterns: [
      /\b(script|source|code|module|bytecode|decompile|function|constant|upvalue|closure|reverse|trace)\b/i,
    ],
    steps: [
      { tool: "search-instances", phase: "discover", why: "Locate candidate scripts or modules." },
      {
        tool: "script-grep",
        phase: "discover",
        why: "Search script text for names, strings, or behavior.",
      },
      {
        tool: "get-script-content",
        phase: "discover",
        why: "Read the relevant source or recovered content.",
      },
      {
        tool: "search-bytecode",
        phase: "verify",
        why: "Use bytecode/xref analysis when source is absent or misleading.",
      },
    ],
  },
  {
    id: "find-player-value",
    title: "Find a player's money, score, XP, or similar value",
    description:
      "Use the value-discovery heuristic, inspect the winning path, then read or write only the confirmed value.",
    patterns: [
      /\b(money|cash|coins|currency|score|xp|experience|health|stats|value|player|character)\b/i,
    ],
    steps: [
      {
        tool: "discover-player-values",
        phase: "discover",
        why: "Rank likely player-value paths using a live heuristic walk.",
      },
      {
        tool: "get-instance-properties",
        phase: "verify",
        why: "Confirm the winning path and its current type/value.",
      },
      {
        tool: "read-path-value",
        phase: "verify",
        why: "Read the exact path in a compact, auditable form.",
      },
      {
        tool: "write-path-value",
        phase: "act",
        why: "Only use after confirming the target and intended mutation.",
      },
    ],
  },
];

export function matchWorkflows(
  goal: string,
  availableTools: ReadonlySet<string>,
): readonly WorkflowMatch[] {
  const moneyGoal = /\b(money|cash|coins|currency|score|xp|experience|stats)\b/i.test(goal);
  return WORKFLOWS.filter((workflow) => {
    if (moneyGoal && workflow.id === "find-player-value") return true;
    return workflow.patterns.some((pattern) => pattern.test(goal));
  })
    .map((workflow) => ({
      id: workflow.id,
      title: workflow.title,
      description: workflow.description,
      steps: workflow.steps.filter((step) => availableTools.has(step.tool)),
    }))
    .filter((workflow) => workflow.steps.length > 0);
}

export function matchWorkflow(
  goal: string,
  availableTools: ReadonlySet<string>,
): WorkflowMatch | null {
  return matchWorkflows(goal, availableTools)[0] ?? null;
}
