import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import { preflightScript } from "../../application/services/script-preflight.js";

/**
 * Load a saved playbook, substitute its `${param}` placeholders, and run it
 * through the same scripting bridge `script` uses (so `mcp.*`, `mcp.all()`,
 * the persistent VM, the per-script RPC budget, output capture, and pre-flight
 * all apply identically).
 */
export default defineTool({
  name: "playbook-run",
  title: "Run a Saved Luau Playbook by Name",
  description:
    "Load a saved playbook from ~/.executor-mcp/playbooks/<name>.json, replace any ${param} placeholders with " +
    "the values from `params`, then run through the same scripting surface as the `script` tool — `mcp.*` " +
    "calls, `mcp.all()`, the persistent VM, per-script RPC budget, output capture, and pre-flight ALL apply " +
    "identically. Returns `{ result, output }` or `{ error, output }` from the run.",
  category: "Execution",
  mutatesState: true,
  input: z.object({
    name: z.string().min(1).describe("The saved playbook's name."),
    params: z
      .record(z.string(), z.string())
      .optional()
      .describe("Key/value substitutions for ${param} placeholders in the source."),
    persistent: z
      .boolean()
      .optional()
      .describe("Use the persistent VM (default true). Same semantics as script.persistent."),
    timeoutMs: z.number().int().positive().optional(),
    rpcBudget: z.number().int().positive().max(10000).optional(),
    threadContext: z.number().int().optional(),
  }),
  async execute({ name, params, persistent, timeoutMs, rpcBudget, threadContext }, ctx) {
    const playbook = await ctx.playbooks.get(name);
    if (!playbook) {
      return { data: { error: `No playbook named "${name}".` }, isError: true };
    }
    if (!ctx.scripting) {
      return {
        data: { error: "The scripting bridge is not available on this server." },
        isError: true,
      };
    }

    // ${param} substitution; missing keys are left in-place so the user sees the
    // failure rather than silent empty strings. $$ escapes a literal dollar sign.
    const substituted = playbook.source.replace(/\$\$|\$\{([^}]+)\}/g, (m, key: string | undefined) => {
      if (m === "$$") return "$";
      if (params && Object.hasOwn(params, key!)) {
        return String(params[key!]);
      }
      return m;
    });

    const preflight = preflightScript(substituted, ctx.scripting.knownTools);
    if (preflight.errors.length > 0) {
      return {
        data: {
          error:
            "preflight: " +
            preflight.errors.length +
            " unknown mcp.* tool" +
            (preflight.errors.length === 1 ? "" : "s") +
            " in playbook \"" +
            name +
            "\" — fix the playbook source.",
          unknownTools: preflight.errors.map((f) => ({
            name: f.name,
            writtenAs: f.written,
            occurrences: f.occurrences,
            didYouMean: f.suggestions,
          })),
        },
        isError: true,
      };
    }

    const { token, dispose } = ctx.scripting.mint(
      rpcBudget !== undefined ? { budget: rpcBudget } : undefined,
    );
    try {
      const data = await ctx.runLuau(substituted, {
        timeoutMs: timeoutMs ?? 120000,
        env: persistent === false ? "fresh" : "vm",
        scriptToken: token,
        ...(threadContext !== undefined ? { threadContext } : {}),
      });
      return { data };
    } finally {
      dispose();
    }
  },
});
