import { describe, expect, it } from "vitest";
import type { LuauOptions, ToolContext } from "../../../src/application/tool/tool.js";
import cryptBase64Encode from "../../../src/tools/crypt/crypt-base64-encode.js";
import cryptHash from "../../../src/tools/crypt/crypt-hash.js";
import cryptEncrypt from "../../../src/tools/crypt/crypt-encrypt.js";
import cryptGenerateBytes from "../../../src/tools/crypt/crypt-generate-bytes.js";
import { cryptTools } from "../../../src/tools/crypt/index.js";

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

describe("crypt tools", () => {
  it("exports all 7 tools with unique names in the Crypt category, all read-only", () => {
    expect(cryptTools).toHaveLength(7);
    const names = cryptTools.map((t) => t.name);
    expect(new Set(names).size).toBe(7);
    for (const tool of cryptTools) {
      expect(tool.category).toBe("Crypt");
      expect(tool.mutatesState).not.toBe(true);
    }
  });

  it("guards every tool with type(crypt) == 'table' and pcall", async () => {
    for (const tool of cryptTools) {
      const { ctx, calls } = stubContext({});
      // Parse with empty input so defaults fill in; supply required fields generically.
      const input = tool.input.parse({
        data: "x",
        key: "k",
        iv: "i",
      });
      await tool.execute(input, ctx);
      const src = calls[0]!.source;
      expect(src).toContain('if type(crypt) ~= "table" then');
      expect(src).toContain("crypt is not available in this executor.");
      expect(src).toContain("pcall(");
    }
  });

  describe("crypt-base64-encode", () => {
    it("q-quotes the data and probes both flat and namespaced base64 forms", async () => {
      const { ctx, calls } = stubContext({ encoded: "aGk=" });
      const input = cryptBase64Encode.input.parse({ data: 'hi"there', threadContext: 3 });

      const result = await cryptBase64Encode.execute(input, ctx);

      expect(result).toEqual({ data: { encoded: "aGk=" } });
      const { source, options } = calls[0]!;
      // q() escapes the embedded quote.
      expect(source).toContain('pcall(encoder, "hi\\"there")');
      // both forms probed
      expect(source).toContain('type(crypt.base64encode) == "function"');
      expect(source).toContain("crypt.base64");
      expect(source).toContain("crypt.base64.encode");
      expect(options?.threadContext).toBe(3);
    });
  });

  describe("crypt-hash", () => {
    it("defaults to sha256 and splices the algorithm into the call and result", async () => {
      const { ctx, calls } = stubContext({ hash: "abc", algorithm: "sha256" });
      const input = cryptHash.input.parse({ data: "payload" });

      await cryptHash.execute(input, ctx);

      const { source } = calls[0]!;
      expect(source).toContain('if type(crypt.hash) ~= "function" then');
      expect(source).toContain('pcall(crypt.hash, "payload", "sha256")');
      expect(source).toContain('algorithm = "sha256"');
    });

    it("passes a non-default algorithm through", async () => {
      const { ctx, calls } = stubContext({});
      const input = cryptHash.input.parse({ data: "payload", algorithm: "md5" });
      await cryptHash.execute(input, ctx);
      expect(calls[0]!.source).toContain('pcall(crypt.hash, "payload", "md5")');
    });
  });

  describe("crypt-encrypt", () => {
    it("omits iv/mode when absent and returns ciphertext + iv", async () => {
      const { ctx, calls } = stubContext({ ciphertext: "c", iv: "v" });
      const input = cryptEncrypt.input.parse({ data: "secret", key: "K" });

      const result = await cryptEncrypt.execute(input, ctx);

      expect(result).toEqual({ data: { ciphertext: "c", iv: "v" } });
      const { source } = calls[0]!;
      expect(source).toContain('pcall(crypt.encrypt, "secret", "K")');
    });

    it("placeholds the iv slot with nil when only mode is supplied", async () => {
      const { ctx, calls } = stubContext({});
      const input = cryptEncrypt.input.parse({ data: "secret", key: "K", mode: "CBC" });
      await cryptEncrypt.execute(input, ctx);
      expect(calls[0]!.source).toContain('pcall(crypt.encrypt, "secret", "K", nil, "CBC")');
    });

    it("passes iv and mode positionally when both supplied", async () => {
      const { ctx, calls } = stubContext({});
      const input = cryptEncrypt.input.parse({ data: "secret", key: "K", iv: "IV", mode: "CTR" });
      await cryptEncrypt.execute(input, ctx);
      expect(calls[0]!.source).toContain('pcall(crypt.encrypt, "secret", "K", "IV", "CTR")');
    });
  });

  describe("crypt-generate-bytes", () => {
    it("defaults size to 16 and clamps out-of-range requests", async () => {
      const { ctx, calls } = stubContext({ bytes: "==" });
      const def = cryptGenerateBytes.input.parse({});
      await cryptGenerateBytes.execute(def, ctx);
      expect(calls[0]!.source).toContain("pcall(crypt.generatebytes, 16)");

      const { ctx: ctx2, calls: calls2 } = stubContext({});
      const big = cryptGenerateBytes.input.parse({ size: 999999 });
      await cryptGenerateBytes.execute(big, ctx2);
      expect(calls2[0]!.source).toContain("pcall(crypt.generatebytes, 1024)");

      const { ctx: ctx3, calls: calls3 } = stubContext({});
      const small = cryptGenerateBytes.input.parse({ size: 0 });
      await cryptGenerateBytes.execute(small, ctx3);
      expect(calls3[0]!.source).toContain("pcall(crypt.generatebytes, 1)");
    });
  });
});
