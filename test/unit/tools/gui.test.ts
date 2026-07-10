import { describe, expect, it } from "vitest";
import type { LuauOptions, ToolContext } from "../../../src/application/tool/tool.js";
import listGuiElements from "../../../src/tools/gui/list-gui-elements.js";
import setGuiText from "../../../src/tools/gui/set-gui-text.js";
import clickButton from "../../../src/tools/gui/click-button.js";
import virtualInput from "../../../src/tools/gui/virtual-input.js";
import cameraControl from "../../../src/tools/gui/camera-control.js";
import { guiTools } from "../../../src/tools/gui/index.js";

/**
 * A minimal ToolContext stub whose runLuau records the source string and the
 * options it was called with, then returns a canned value. No socket, no game —
 * we only assert that the tool builds the expected Luau and returns { data }.
 */
function stubContext(canned: unknown): {
  ctx: ToolContext;
  calls: Array<{ source: string; options?: LuauOptions }>;
} {
  const calls: Array<{ source: string; options?: LuauOptions }> = [];
  const ctx = {
    async runLuau(source: string, options?: LuauOptions) {
      calls.push({ source, options });
      return canned;
    },
  } as unknown as ToolContext;
  return { ctx, calls };
}

describe("gui tools", () => {
  it("exports all 10 tools with unique names in the GUI category", () => {
    expect(guiTools).toHaveLength(10);
    const names = guiTools.map((t) => t.name);
    expect(new Set(names).size).toBe(10);
    for (const tool of guiTools) {
      expect(tool.category).toBe("GUI");
    }
  });

  it("marks the interaction tools as mutatesState", () => {
    const mutating = guiTools
      .filter((t) => t.mutatesState === true)
      .map((t) => t.name)
      .sort();
    expect(mutating).toEqual(
      [
        "set-gui-text",
        "click-button",
        "type-text-box",
        "fire-proximity-prompt",
        "fire-click-detector",
        "press-key",
        "virtual-input",
        "camera-control",
      ].sort(),
    );
  });

  it("keeps list-gui-elements and get-gui-text read-only", () => {
    const readOnly = guiTools.filter((t) => t.mutatesState !== true).map((t) => t.name);
    expect(readOnly.sort()).toEqual(["get-gui-text", "list-gui-elements"]);
  });

  describe("list-gui-elements", () => {
    it("defaults root to PlayerGui, caps the limit, and walks descendants", async () => {
      const canned = { count: 0, truncated: false, elements: [] };
      const { ctx, calls } = stubContext(canned);
      const input = listGuiElements.input.parse({});

      const result = await listGuiElements.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      expect(calls).toHaveLength(1);
      const { source, options } = calls[0]!;
      expect(source).toContain('__eval("game:GetService(\\"Players\\").LocalPlayer.PlayerGui")');
      expect(source).toContain("rootInst:GetDescendants()");
      expect(source).toContain('inst:IsA("GuiObject")');
      // No classFilter by default.
      expect(source).toContain("local classFilter = nil");
      // Default cap of 200.
      expect(source).toContain("local cap = 200");
      // Read-only: 20s budget, threadContext passes through (undefined here).
      expect(options?.timeoutMs).toBe(20000);
      expect(options?.threadContext).toBeUndefined();
    });

    it("splices a classFilter and a clamped limit into the source", async () => {
      const { ctx, calls } = stubContext({});
      const input = listGuiElements.input.parse({
        root: 'game:GetService("CoreGui")',
        classFilter: "TextButton",
        limit: 99999,
        threadContext: 3,
      });

      await listGuiElements.execute(input, ctx);

      const { source, options } = calls[0]!;
      expect(source).toContain('local classFilter = "TextButton"');
      // 99999 is clamped to the 5000 ceiling.
      expect(source).toContain("local cap = 5000");
      expect(options?.threadContext).toBe(3);
    });
  });

  describe("set-gui-text", () => {
    it("reads old text, sets new text via pcall, and is state-mutating", async () => {
      const canned = { Path: "Game.X", OldText: "a", NewText: "b", ok: true };
      const { ctx, calls } = stubContext(canned);
      const input = setGuiText.input.parse({
        path: "game.Players.LocalPlayer.PlayerGui.Login.UsernameBox",
        text: 'hi "there"',
      });

      const result = await setGuiText.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      expect(setGuiText.mutatesState).toBe(true);
      const { source } = calls[0]!;
      expect(source).toContain("local okRead, ov = pcall(function() return inst.Text end)");
      // The text value is quoted, including the embedded double quotes.
      expect(source).toContain('inst.Text = "hi \\"there\\""');
      expect(source).toContain("OldText = oldText");
      expect(source).toContain("NewText = newText");
    });
  });

  describe("click-button", () => {
    it("guards firesignal and fires all standard signals when no action given", async () => {
      const canned = { Path: "Game.Btn", Fired: ["Activated"], ok: true };
      const { ctx, calls } = stubContext(canned);
      const input = clickButton.input.parse({ path: "game.X.Btn" });

      const result = await clickButton.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      expect(clickButton.mutatesState).toBe(true);
      const { source } = calls[0]!;
      expect(source).toContain(
        'if type(firesignal) ~= "function" then return { error = "Your executor does not support \'firesignal\', which is required for this command." } end',
      );
      expect(source).toContain('button:IsA("GuiButton")');
      // The standard click signal list is spliced in.
      expect(source).toContain(
        '{ "Activated", "MouseButton1Down", "MouseButton2Down", "MouseButton1Click", "MouseButton2Click" }',
      );
      // No action -> loops over all signals.
      expect(source).toContain("local action = nil");
      expect(source).toContain("for _, signalName in ipairs(signals) do");
    });

    it("validates and fires a single named action when provided", async () => {
      const { ctx, calls } = stubContext({});
      const input = clickButton.input.parse({
        path: "game.X.Btn",
        action: "MouseButton1Click",
      });

      await clickButton.execute(input, ctx);

      const { source } = calls[0]!;
      expect(source).toContain('local action = "MouseButton1Click"');
      expect(source).toContain("if not table.find(signals, action) then");
      expect(source).toContain("firesignal(button[action])");
    });
  });

  describe("virtual-input", () => {
    it("builds a newcclosure-backed mouse click with executor-safe parameters", async () => {
      const canned = { ok: true, action: "mouseButton" };
      const { ctx, calls } = stubContext(canned);
      const input = virtualInput.input.parse({
        action: "mouseButton",
        x: 320,
        y: 240,
        button: "Left",
        buttonAction: "click",
        holdSec: 0.25,
      });

      const result = await virtualInput.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      expect(virtualInput.mutatesState).toBe(true);
      expect(calls[0]?.source).toContain("newcclosure");
      expect(calls[0]?.source).toContain("SendMouseButtonEvent(x, y, id, isDown, game, 0)");
      expect(calls[0]?.source).toContain("local holdSec = 0.25");
      expect(calls[0]?.options?.timeoutMs).toBe(20000);
    });
  });

  describe("camera-control", () => {
    it("builds a structured look-at camera update", async () => {
      const canned = { ok: true, action: "setCFrame" };
      const { ctx, calls } = stubContext(canned);
      const input = cameraControl.input.parse({
        action: "setCFrame",
        position: { x: 0, y: 10, z: 20 },
        lookAt: { x: 0, y: 0, z: 0 },
        fov: 70,
        cameraType: "Scriptable",
      });

      const result = await cameraControl.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      expect(calls[0]?.source).toContain("CFrame.lookAt");
      expect(calls[0]?.source).toContain("camera.FieldOfView = 70");
      expect(calls[0]?.source).toContain('Enum.CameraType["Scriptable"]');
    });
  });
});
