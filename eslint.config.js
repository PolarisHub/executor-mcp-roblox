// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "_legacy/**", "coverage/**", "*.mjs"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Domain layer must stay framework-free; enforce explicit boundaries elsewhere.
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      // Allow `a || b` on strings: the config layer treats trimmed "" as unset.
      "@typescript-eslint/prefer-nullish-coalescing": [
        "error",
        { ignorePrimitives: { string: true } },
      ],
      // Tools implement an async contract (execute(): Promise<ToolResult>); some
      // legitimately have no `await`, so requiring one is counterproductive here.
      "@typescript-eslint/require-await": "off",
      "no-console": "error",
    },
  },
  {
    // Tests favour terse, explicit fakes over production-grade ceremony.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/array-type": "off",
    },
  },
  {
    // Build/tooling config files are not part of the typed program.
    files: ["*.config.ts", "*.config.js", "eslint.config.js"],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      "no-console": "off",
    },
  },
  prettier,
);
