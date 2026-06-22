import { describe, expect, it } from "vitest";
import type { LuauOptions, ToolContext } from "../../../src/application/tool/tool.js";
import readFile from "../../../src/tools/filesystem/read-file.js";
import writeFile from "../../../src/tools/filesystem/write-file.js";
import fileExists from "../../../src/tools/filesystem/file-exists.js";
import { filesystemTools } from "../../../src/tools/filesystem/index.js";

/**
 * A minimal ToolContext stub whose runLuau records the source string and the
 * options it was called with, then returns a canned value. No socket, no
 * executor — we only assert that the tool builds the expected Luau and returns
 * { data }.
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

describe("filesystem tools", () => {
  it("exports all 10 tools with unique names in the Filesystem category", () => {
    expect(filesystemTools).toHaveLength(10);
    const names = filesystemTools.map((t) => t.name);
    expect(new Set(names).size).toBe(10);
    for (const tool of filesystemTools) {
      expect(tool.category).toBe("Filesystem");
    }
  });

  it("marks only the writing/deleting/asset tools as mutatesState", () => {
    const mutating = filesystemTools
      .filter((t) => t.mutatesState === true)
      .map((t) => t.name)
      .sort();
    expect(mutating).toEqual(
      [
        "write-file",
        "append-file",
        "make-folder",
        "delete-file",
        "delete-folder",
        "get-custom-asset",
      ].sort(),
    );
  });

  describe("read-file", () => {
    it("type-guards readfile, q-quotes the path, and pcall-wraps the call", async () => {
      const canned = { path: "config.json", content: "{}" };
      const { ctx, calls } = stubContext(canned);
      const input = readFile.input.parse({
        path: "config.json",
        threadContext: 3,
        timeoutMs: 5000,
      });

      const result = await readFile.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      expect(calls).toHaveLength(1);
      const { source, options } = calls[0]!;
      expect(source).toContain('if type(readfile) ~= "function" then');
      expect(source).toContain("readfile is not available in this executor.");
      expect(source).toContain('local ok, content = pcall(readfile, "config.json")');
      expect(options?.threadContext).toBe(3);
      expect(options?.timeoutMs).toBe(5000);
    });

    it("is read-only (not mutatesState)", () => {
      expect(readFile.mutatesState).not.toBe(true);
    });
  });

  describe("write-file", () => {
    it("is a state-mutating tool that q-quotes path and content", async () => {
      expect(writeFile.mutatesState).toBe(true);
      const { ctx, calls } = stubContext({ path: "a.txt", ok: true });
      const input = writeFile.input.parse({ path: "a.txt", content: 'hi "there"\n' });

      await writeFile.execute(input, ctx);

      const { source } = calls[0]!;
      expect(source).toContain('if type(writefile) ~= "function" then');
      // path and content both routed through q() -> valid Luau literals
      expect(source).toContain('pcall(writefile, "a.txt", "hi \\"there\\"\\n")');
    });
  });

  describe("file-exists", () => {
    it("guards isfile and isfolder independently and reports both", async () => {
      const canned = { path: "data", isFile: false, isFolder: true };
      const { ctx, calls } = stubContext(canned);
      const input = fileExists.input.parse({ path: "data" });

      const result = await fileExists.execute(input, ctx);

      expect(result).toEqual({ data: canned });
      const { source } = calls[0]!;
      expect(source).toContain('local hasFile = type(isfile) == "function"');
      expect(source).toContain('local hasFolder = type(isfolder) == "function"');
      expect(source).toContain("isfile/isfolder are not available in this executor.");
      expect(source).toContain('pcall(isfile, "data")');
      expect(source).toContain('pcall(isfolder, "data")');
    });
  });
});
