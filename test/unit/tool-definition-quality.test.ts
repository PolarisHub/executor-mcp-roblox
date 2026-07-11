import { describe, expect, it } from "vitest";

import {
  buildToolGuidance,
  formatToolDescription,
} from "../../src/application/services/tool-definition-quality.js";
import { describeInputFields } from "../../src/application/services/schema-introspect.js";
import { TOOL_CATEGORIES } from "../../src/domain/tool/category.js";
import { allTools } from "../../src/tools/index.js";

describe("tool definition quality compiler", () => {
  it("upgrades every registered tool to the complete AI-facing contract", () => {
    const tools = allTools();
    const names = new Set(tools.map((tool) => tool.name));

    expect(tools).toHaveLength(287);
    expect(names.size).toBe(tools.length);
    expect(new Set(tools.map((tool) => tool.category))).toEqual(new Set(TOOL_CATEGORIES));

    for (const tool of tools) {
      const fields = describeInputFields(tool.input);
      const guidance = buildToolGuidance(tool);
      const compiledDescription = formatToolDescription(tool);

      expect.soft(tool.title.trim(), `${tool.name}: title`).not.toBe("");
      expect.soft(tool.description.trim(), `${tool.name}: description`).not.toBe("");
      expect.soft(tool.ai, `${tool.name}: contract`).toBeDefined();
      expect.soft(tool.ai?.consumes.length, `${tool.name}: consumes`).toBeGreaterThan(0);
      expect.soft(tool.ai?.produces.length, `${tool.name}: produces`).toBeGreaterThan(0);
      expect.soft(tool.ai?.failureRecovery.length, `${tool.name}: recovery`).toBeGreaterThan(0);
      expect.soft(tool.quality?.score, `${tool.name}: quality score`).toBeGreaterThanOrEqual(90);
      expect.soft(tool.quality?.grade, `${tool.name}: quality grade`).toBe("A");

      for (const field of fields) {
        expect.soft(field.description.trim(), `${tool.name}.${field.name}: help`).not.toBe("");
        expect
          .soft(["explicit", "inferred"], `${tool.name}.${field.name}: help provenance`)
          .toContain(field.descriptionSource);
        expect
          .soft(field.constraints, `${tool.name}.${field.name}: constraints`)
          .toBeInstanceOf(Array);
        expect.soft(field.example, `${tool.name}.${field.name}: example`).not.toBeUndefined();
      }

      if (tool.requiresClient !== false) {
        expect
          .soft(tool.ai?.prerequisites, `${tool.name}: client prerequisite`)
          .toContain("active-client");
      }
      if (tool.mutatesState) {
        expect.soft(tool.ai?.sideEffects.length, `${tool.name}: side effects`).toBeGreaterThan(0);
        expect
          .soft(tool.ai?.verifiesWith.length, `${tool.name}: verification tool`)
          .toBeGreaterThan(0);
        expect
          .soft(tool.ai?.prerequisites, `${tool.name}: mutation approval`)
          .toContain("explicit-mutation-approval");
      }

      expect.soft(compiledDescription, `${tool.name}: signature`).toContain("Signature:");
      expect.soft(compiledDescription, `${tool.name}: phase`).toContain("Phase:");
      expect.soft(compiledDescription, `${tool.name}: prerequisites`).toContain("Requires:");
      expect.soft(compiledDescription, `${tool.name}: output`).toContain("Produces:");
      expect.soft(compiledDescription, `${tool.name}: safety`).toContain("Safety:");
      expect.soft(compiledDescription, `${tool.name}: recovery`).toContain("On failure:");
      expect
        .soft(compiledDescription, `${tool.name}: undefined leakage`)
        .not.toContain("undefined");
      expect
        .soft(compiledDescription.length, `${tool.name}: description budget`)
        .toBeLessThanOrEqual(7000);

      expect.soft(guidance.example, `${tool.name}: runnable example`).toMatch(/^mcp\.[A-Za-z]/);
      expect
        .soft(
          tool.input.safeParse(guidance.exampleInput).success,
          `${tool.name}: schema-valid example`,
        )
        .toBe(true);
      for (const required of guidance.requiredInputs) {
        expect
          .soft(guidance.example, `${tool.name}: example includes ${required}`)
          .toContain(`${required} =`);
      }
    }
  });

  it("keeps inferred documentation visible as measurable authoring debt", () => {
    const tools = allTools();
    const fields = tools.flatMap((tool) => describeInputFields(tool.input));

    expect(fields.length).toBeGreaterThan(0);
    expect(fields.every((field) => field.description.length > 0)).toBe(true);
    expect(fields.filter((field) => field.descriptionSource === "inferred").length).toBeGreaterThan(
      0,
    );
  });
});
