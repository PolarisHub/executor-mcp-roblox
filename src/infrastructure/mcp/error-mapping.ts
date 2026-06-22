import type { DomainError } from "../../domain/errors/errors.js";

/**
 * Render a {@link DomainError} as the single text payload of an MCP error result.
 * The shape is stable (`CODE: message`) so AI clients can pattern-match on the
 * code prefix without parsing free-form prose or seeing a stack trace.
 */
export function formatDomainError(error: DomainError): string {
  return `${error.code}: ${error.message}`;
}
