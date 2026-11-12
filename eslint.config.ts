/**
 * ESLint flat config (kit: ESLint for TypeScript, apply-engineering-guidelines/rules/testing-strategy.md:22).
 * TypeScript config loaded through jiti (ESLint 10 docs, "TypeScript Configuration Files"),
 * so a plain `npx eslint .` works.
 */
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/cdk.out/**",
      "**/test-results/**",
      "**/playwright-report/**",
      "data/**",
      "runs/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["apps/*/src/**/*.tsx", "apps/*/src/**/*.ts"],
    extends: [reactHooks.configs.flat.recommended],
  },
  {
    // Plain Node scripts: the Node globals they use (TypeScript files get these from @types/node).
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        AbortSignal: "readonly",
        Buffer: "readonly",
        URLSearchParams: "readonly",
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
        setTimeout: "readonly",
      },
    },
  },
);
