import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      // Coverage is GATED on the pure logic layers (domain + application), which
      // must stay near-fully covered. Infrastructure adapters are exercised by
      // integration tests; per-tool unit tests land with each migration wave (see
      // docs/MIGRATION.md), at which point src/tools + src/infrastructure join the
      // gate and the include list widens.
      include: ["src/domain/**/*.ts", "src/application/**/*.ts"],
      // Interface/type-only files carry no executable code to cover.
      exclude: [
        "**/*.test.ts",
        "**/index.ts",
        "src/application/tool/tool.ts",
        "src/application/ports/**",
        "src/domain/shared/brand.ts",
      ],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
