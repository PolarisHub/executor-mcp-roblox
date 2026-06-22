import { describe, expect, it } from "vitest";
import type { ShellResult } from "../../../src/application/ports/host-shell.js";
import type { LuauOptions, ToolContext } from "../../../src/application/tool/tool.js";
import executeFile from "../../../src/tools/execution/execute-file.js";
import listRobloxWindows from "../../../src/tools/windows/list-roblox-windows.js";
import screenshotWindow from "../../../src/tools/windows/screenshot-window.js";
import { windowsTools } from "../../../src/tools/windows/index.js";

/**
 * A minimal ToolContext stub exposing only the host capabilities (fs + shell)
 * and a recording runLuau. Each host method is backed by a caller-supplied
 * function so a test can stub success or failure; calls are recorded for
 * assertions. No real filesystem or process is touched.
 */
function hostContext(stubs: {
  readText?: (path: string) => Promise<string>;
  shellRun?: (
    command: string,
    args: readonly string[],
    options?: { timeoutMs?: number },
  ) => Promise<ShellResult>;
  runLuau?: (source: string, options?: LuauOptions) => Promise<unknown>;
}): {
  ctx: ToolContext;
  luauCalls: Array<{ source: string; options?: LuauOptions }>;
  shellCalls: Array<{ command: string; args: readonly string[] }>;
} {
  const luauCalls: Array<{ source: string; options?: LuauOptions }> = [];
  const shellCalls: Array<{ command: string; args: readonly string[] }> = [];

  const ctx = {
    async runLuau(source: string, options?: LuauOptions) {
      luauCalls.push({ source, options });
      return stubs.runLuau ? stubs.runLuau(source, options) : undefined;
    },
    host: {
      fs: {
        async readText(path: string) {
          if (!stubs.readText) throw new Error("readText not stubbed");
          return stubs.readText(path);
        },
        async list() {
          return [];
        },
        async exists() {
          return true;
        },
        allowedRoots: ["/allowed"] as readonly string[],
      },
      shell: {
        async run(command: string, args: readonly string[], options?: { timeoutMs?: number }) {
          shellCalls.push({ command, args });
          if (!stubs.shellRun) throw new Error("shell.run not stubbed");
          return stubs.shellRun(command, args, options);
        },
      },
    },
  } as unknown as ToolContext;

  return { ctx, luauCalls, shellCalls };
}

describe("execute-file", () => {
  it("reads the file and passes its contents through to runLuau", async () => {
    const canned = { hp: 100 };
    const { ctx, luauCalls } = hostContext({
      readText: async () => "return 100",
      runLuau: async () => canned,
    });
    const input = executeFile.input.parse({
      path: "scripts/probe.luau",
      threadContext: 8,
      timeoutMs: 5000,
    });

    const result = await executeFile.execute(input, ctx);

    expect(result).toEqual({ data: { file: "scripts/probe.luau", result: canned } });
    expect(luauCalls).toHaveLength(1);
    expect(luauCalls[0]?.source).toBe("return 100");
    expect(luauCalls[0]?.options).toEqual({ threadContext: 8, timeoutMs: 5000 });
  });

  it("returns an error result (without running Luau) when the read is rejected", async () => {
    const { ctx, luauCalls } = hostContext({
      readText: async () => {
        throw new Error("Path is outside the allowed roots: /etc/passwd");
      },
    });
    const input = executeFile.input.parse({ path: "/etc/passwd" });

    const result = await executeFile.execute(input, ctx);

    expect(result.isError).toBe(true);
    expect((result.data as { error: string }).error).toContain("outside the allowed roots");
    expect(luauCalls).toHaveLength(0);
  });

  it("is a state-mutating Execution tool requiring a client by default", () => {
    expect(executeFile.category).toBe("Execution");
    expect(executeFile.mutatesState).toBe(true);
    expect(executeFile.requiresClient ?? true).toBe(true);
  });
});

describe("list-roblox-windows", () => {
  it("parses the JSON the PowerShell query prints into a windows array", async () => {
    const canned = JSON.stringify([
      { pid: 1234, title: "Roblox" },
      { pid: 5678, title: "My Game" },
    ]);
    const { ctx, shellCalls } = hostContext({
      shellRun: async () => ({ stdout: canned, stderr: "", code: 0 }),
    });

    const result = await listRobloxWindows.execute({}, ctx);

    expect(result.data).toEqual({
      windows: [
        { pid: 1234, title: "Roblox" },
        { pid: 5678, title: "My Game" },
      ],
    });
    expect(shellCalls).toHaveLength(1);
    expect(shellCalls[0]?.command).toBe("powershell");
    // args are passed as an array (no shell:true), including the -Command flag.
    expect(shellCalls[0]?.args).toContain("-Command");
  });

  it("returns an empty list when no Roblox windows are open", async () => {
    const { ctx } = hostContext({
      shellRun: async () => ({ stdout: "[]", stderr: "", code: 0 }),
    });

    const result = await listRobloxWindows.execute({}, ctx);

    expect(result.data).toEqual({ windows: [] });
    expect(result.isError).toBeUndefined();
  });

  it("flags an error when PowerShell exits non-zero", async () => {
    const { ctx } = hostContext({
      shellRun: async () => ({ stdout: "", stderr: "boom", code: 1 }),
    });

    const result = await listRobloxWindows.execute({}, ctx);

    expect(result.isError).toBe(true);
    expect((result.data as { error: string }).error).toContain("failed");
  });

  it("does not require a client", () => {
    expect(listRobloxWindows.requiresClient).toBe(false);
    expect(listRobloxWindows.category).toBe("Windows");
  });
});

describe("windows tool index", () => {
  it("exports both Windows tools with unique names", () => {
    expect(windowsTools).toHaveLength(2);
    expect(windowsTools.map((t) => t.name)).toEqual(["list-roblox-windows", "screenshot-window"]);
    for (const tool of windowsTools) {
      expect(tool.category).toBe("Windows");
      expect(tool.requiresClient).toBe(false);
    }
  });

  it("screenshot-window does not mutate state", () => {
    expect(screenshotWindow.mutatesState).toBe(false);
  });
});
