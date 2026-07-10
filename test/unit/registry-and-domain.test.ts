import { describe, expect, it } from "vitest";
import { z } from "zod";

import { isSameAccount } from "../../src/domain/client/client.js";
import {
  DomainError,
  InternalError,
  ValidationError,
  toDomainError,
} from "../../src/domain/errors/errors.js";
import { isToolCategory } from "../../src/domain/tool/category.js";
import { defineTool } from "../../src/application/tool/define-tool.js";
import { ToolRegistry } from "../../src/application/tool/registry.js";
import type { ToolCategory } from "../../src/domain/tool/category.js";
import { makeClient } from "../helpers/fakes.js";

const fakeTool = (name: string, category: ToolCategory) =>
  defineTool({
    name,
    description: "fake",
    category,
    input: z.object({}),
    requiresClient: false,
    execute: () => Promise.resolve({ data: null }),
  });

describe("ToolRegistry", () => {
  it("registers, looks up, and counts tools", () => {
    const registry = new ToolRegistry();
    registry.registerAll([fakeTool("a", "Diagnostics"), fakeTool("b", "Execution")]);
    registry.register(fakeTool("c", "Diagnostics"));

    expect(registry.size).toBe(3);
    expect(registry.has("a")).toBe(true);
    expect(registry.has("missing")).toBe(false);
    expect(registry.get("b")?.category).toBe("Execution");
    expect(registry.byCategory("Diagnostics").map((t) => t.name)).toEqual(["a", "c"]);
  });

  it("rejects duplicate names", () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool("dup", "Diagnostics"));
    expect(() => registry.register(fakeTool("dup", "Execution"))).toThrow(/Duplicate/);
  });

  it("reports category counts in canonical order, skipping empties", () => {
    const registry = new ToolRegistry();
    registry.registerAll([fakeTool("x", "Execution"), fakeTool("y", "Diagnostics")]);
    // Canonical order puts Diagnostics before Execution regardless of insertion order.
    expect(registry.categoryCounts()).toEqual([
      { category: "Diagnostics", count: 1 },
      { category: "Execution", count: 1 },
    ]);
  });
});

describe("isToolCategory", () => {
  it("accepts known categories and rejects unknown ones", () => {
    expect(isToolCategory("Diagnostics")).toBe(true);
    expect(isToolCategory("Memory Scan")).toBe(true);
    expect(isToolCategory("Intelligence")).toBe(true);
    expect(isToolCategory("Nonsense")).toBe(false);
  });
});

describe("isSameAccount", () => {
  it("matches on userId when both are present", () => {
    const a = makeClient({ userId: 7 as never, username: "Alice" });
    const b = makeClient({ userId: 7 as never, username: "alice-alt" });
    expect(isSameAccount(a, b)).toBe(true);
  });

  it("does not match on differing userIds", () => {
    const a = makeClient({ userId: 1 as never });
    const b = makeClient({ userId: 2 as never });
    expect(isSameAccount(a, b)).toBe(false);
  });

  it("falls back to a case-insensitive username when ids are absent", () => {
    const a = makeClient({ userId: null, username: "Bob" });
    const b = makeClient({ userId: null, username: "bOB" });
    expect(isSameAccount(a, b)).toBe(true);
  });

  it("falls back to the connection id when no account info exists", () => {
    const a = makeClient({ userId: null, username: null });
    const b = makeClient({ userId: null, username: null });
    expect(isSameAccount(a, a)).toBe(true);
    expect(isSameAccount(a, b)).toBe(false);
  });
});

describe("error taxonomy", () => {
  it("wraps unknown throwables as InternalError and preserves DomainErrors", () => {
    const wrapped = toDomainError(new Error("boom"));
    expect(wrapped).toBeInstanceOf(InternalError);
    expect(wrapped.code).toBe("INTERNAL");

    const original = new ValidationError("bad");
    expect(toDomainError(original)).toBe(original);

    expect(toDomainError("a string")).toBeInstanceOf(InternalError);
  });

  it("serializes to a stable shape with and without details", () => {
    const withDetails = new ValidationError("bad input", { field: "port" });
    expect(withDetails.toJSON()).toEqual({
      code: "VALIDATION",
      message: "bad input",
      details: { field: "port" },
    });

    const noDetails = new ValidationError("bad input");
    expect(noDetails.toJSON()).toEqual({ code: "VALIDATION", message: "bad input" });
    expect(noDetails).toBeInstanceOf(DomainError);
  });
});
