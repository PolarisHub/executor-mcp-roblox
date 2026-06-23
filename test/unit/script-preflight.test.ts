import { describe, expect, it } from "vitest";

import { preflightScript } from "../../src/application/services/script-preflight.js";

const KNOWN = ["get-players", "search-instances", "find-functions-by-name", "fire-remote", "list-clients"];

describe("preflightScript", () => {
  it("accepts a script with only known tool names", () => {
    const source = `
      local p = mcp.getPlayers()
      local r = mcp.searchInstances({ className = "RemoteEvent" })
      mcp.call("find-functions-by-name", { name = "buy" })
      return #p
    `;
    const report = preflightScript(source, KNOWN);
    expect(report.errors).toEqual([]);
    expect(report.callCount).toBe(3);
  });

  it("flags a typo'd dot-form call with a near-miss suggestion", () => {
    const source = `local r = mcp.searchInstancess({})`;
    const report = preflightScript(source, KNOWN);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]?.name).toBe("search-instancess");
    expect(report.errors[0]?.suggestions).toContain("search-instances");
  });

  it("flags a typo'd kebab call via mcp.call(\"...\")", () => {
    const source = `mcp.call("fire-remot", { path = "x" })`;
    const report = preflightScript(source, KNOWN);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]?.name).toBe("fire-remot");
    expect(report.errors[0]?.suggestions).toContain("fire-remote");
  });

  it("aggregates occurrences of the same unknown name", () => {
    const source = `
      mcp.bogus()
      mcp.bogus()
      mcp.bogus()
    `;
    const report = preflightScript(source, KNOWN);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]?.occurrences).toBe(3);
  });

  it("does not flag mcp.call (the proxy itself)", () => {
    const source = `mcp.call("get-players", {})`;
    const report = preflightScript(source, KNOWN);
    expect(report.errors).toEqual([]);
  });

  it("ignores dynamic indexing like mcp[name]()", () => {
    const source = `local name = "get-players"; local p = mcp[name]()`;
    const report = preflightScript(source, KNOWN);
    expect(report.errors).toEqual([]);
  });
});
