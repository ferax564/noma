// Deliberately narrow ruleset: tsc --strict already owns type correctness,
// so lint only flags correctness smells the compiler cannot see.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "site/assets/**", "packages/**/dist/**", "node_modules/**"],
  },
  {
    files: ["src/**/*.ts", "web/**/*.ts", "scripts/**/*.ts", "test/**/*.ts", "packages/*/src/**/*.ts", "packages/*/test/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2022,
      sourceType: "module",
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "prefer-const": "error",
      "no-debugger": "error",
      "no-dupe-else-if": "error",
      "no-self-compare": "error",
      "no-template-curly-in-string": "error",
      "no-unmodified-loop-condition": "error",
      "no-unreachable-loop": "error",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
);
