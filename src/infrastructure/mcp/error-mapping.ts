import type { DomainError } from "../../domain/errors/errors.js";

/**
 * Render a {@link DomainError} as the single text payload of an MCP error result.
 * The shape is stable (`CODE: message`) so AI clients can pattern-match on the
 * code prefix without parsing free-form prose or seeing a stack trace.
 */
export function formatDomainError(error: DomainError): string {
  const lines = [`${error.code}: ${error.message}`, `retryable: ${error.retryable}`];
  if (error.details && Object.keys(error.details).length > 0) {
    lines.push(`details: ${JSON.stringify(error.details)}`);
  }

  const recovery: Partial<Record<DomainError["code"], string>> = {
    VALIDATION: "Read the listed field issues, then retry with arguments matching the tool schema.",
    TOOL_NOT_FOUND:
      "Use tool-plan, list-tools, or tool-schema to discover the exact kebab-case name.",
    NO_CLIENT_SELECTED: "Call list-clients, then select-client before using a client-bound tool.",
    AMBIGUOUS_CLIENT:
      "Call list-clients and select-client explicitly; never guess between connected games.",
    CLIENT_NOT_FOUND: "Refresh list-clients and select the currently connected client.",
    CLIENT_DISCONNECTED: "Refresh list-clients and retry after the connector reconnects.",
    EXECUTION_TIMEOUT:
      "Retry with a smaller scope/limit or a longer timeout; avoid unbounded scans.",
    EXECUTION_FAILED:
      "Inspect the executor capability/error text, then choose a supported fallback tool.",
    INTERNAL:
      "Retry once; if it persists, inspect the server logs and reduce the request to a minimal reproduction.",
  };
  const hint = recovery[error.code];
  if (hint) lines.push(`recovery: ${hint}`);
  return lines.join("\n");
}
