import { z } from "zod";
import { defineTool } from "../../application/tool/define-tool.js";
import {
  describeInputFields,
  inputSignature,
} from "../../application/services/schema-introspect.js";

function kebabToCamel(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  const prev = new Array<number>(m + 1).fill(0);
  const curr = new Array<number>(m + 1).fill(0);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    for (let j = 0; j <= m; j++) prev[j] = curr[j] ?? 0;
  }
  return prev[m] ?? 0;
}

function nearestNames(name: string, all: readonly string[], limit = 3): string[] {
  return all
    .map((candidate) => ({ candidate, distance: levenshtein(name, candidate) }))
    .filter((pair) => pair.distance > 0 && pair.distance <= Math.max(2, Math.ceil(name.length / 4)))
    .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))
    .slice(0, limit)
    .map((pair) => pair.candidate);
}

/**
 * Returns the full input schema and a compact Luau-flavored signature for one
 * (or every) tool on this server. The point is in-script introspection: from
 * inside a `script` body the agent (or the user) can run
 * `mcp.toolSchema({ name = "get-players" })` and see exactly what arguments
 * the tool accepts, with the same shape the dashboard's `/api/tools/schema`
 * endpoint returns plus a one-line signature for prompts/errors.
 */
export default defineTool({
  name: "tool-schema",
  title: "Get a tool's input schema and Luau signature",
  description:
    "Return the input schema for any tool on this server in a compact, Luau-friendly form. Pass { name } " +
    "for one tool: returns its title, description, category, mutatesState, requiresClient, a one-line " +
    "Luau signature (e.g. `{ limit: number?, includeBots: boolean? }`), a per-field list with type + " +
    "description + optional flag, and a runnable `mcp.<camelCase>({...})` example. Pass { search } to " +
    "match a keyword across names/titles and get back a compact list of name + signature. With no args, " +
    "returns every tool's name + signature (one line each) — bulky but the fastest way for a script to " +
    "discover the whole surface. Use this from inside `script` to learn the right args BEFORE calling a " +
    "tool, instead of guessing and failing.",
  category: "Utility",
  mutatesState: false,
  requiresClient: false,
  input: z.object({
    name: z
      .string()
      .optional()
      .describe(
        "Exact kebab-case tool name (e.g. 'get-players'). If unknown, returns near-miss suggestions.",
      ),
    search: z
      .string()
      .optional()
      .describe("Keyword matched across each tool's name, title, and description."),
    category: z
      .string()
      .optional()
      .describe("Restrict to one category (case-sensitive exact match)."),
  }),
  async execute({ name, search, category }, ctx) {
    const directory = ctx.tools;

    if (name) {
      const descriptor = directory.find(name);
      if (!descriptor) {
        const suggestions = nearestNames(
          name,
          directory.list().map((t) => t.name),
        );
        const withSignatures = suggestions.map((candidate) => {
          const d = directory.find(candidate);
          return d
            ? { name: candidate, signature: inputSignature(d.input), title: d.title }
            : { name: candidate, signature: "{}", title: "" };
        });
        return {
          data: {
            error: `unknown tool "${name}"`,
            didYouMean: withSignatures,
            hint: "Tool names are kebab-case on the wire; mcp.getPlayers() resolves to get-players.",
          },
          isError: true,
        };
      }
      const fields = describeInputFields(descriptor.input);
      const signature = inputSignature(descriptor.input);
      const camel = kebabToCamel(descriptor.name);
      const exampleArgs = fields
        .filter((f) => !f.optional)
        .slice(0, 3)
        .map((f) => `${f.name} = <${f.type}>`)
        .join(", ");
      const example = exampleArgs
        ? `mcp.${camel}({ ${exampleArgs} })`
        : `mcp.${camel}()`;
      return {
        data: {
          name: descriptor.name,
          camelCase: camel,
          title: descriptor.title,
          description: descriptor.description,
          category: descriptor.category,
          mutatesState: descriptor.mutatesState,
          requiresClient: descriptor.requiresClient,
          signature,
          args: fields,
          example,
        },
      };
    }

    const term = search?.toLowerCase();
    const matches = directory
      .list()
      .filter((tool) => (category ? tool.category === category : true))
      .filter((tool) =>
        term
          ? tool.name.toLowerCase().includes(term) ||
            tool.title.toLowerCase().includes(term) ||
            tool.description.toLowerCase().includes(term)
          : true,
      )
      .map((tool) => ({
        name: tool.name,
        camelCase: kebabToCamel(tool.name),
        category: tool.category,
        signature: inputSignature(tool.input),
      }));

    return {
      data: {
        ...(search ? { search } : {}),
        ...(category ? { category } : {}),
        count: matches.length,
        tools: matches,
        hint: "Pass { name } to get full per-field detail for one tool.",
      },
    };
  },
});
