import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/domain/errors/errors.js";
import { formatDomainError } from "../../src/infrastructure/mcp/error-mapping.js";

describe("MCP error mapping", () => {
  it("preserves machine-readable details and gives the agent a recovery path", () => {
    const error = new ValidationError('Invalid arguments for "search-instances".', {
      issues: [{ path: "limit", message: "Too big" }],
    });

    const output = formatDomainError(error);

    expect(output).toContain("VALIDATION: Invalid arguments");
    expect(output).toContain('details: {"issues":[{"path":"limit","message":"Too big"}]}');
    expect(output).toContain("recovery: Read the listed field issues");
  });
});
