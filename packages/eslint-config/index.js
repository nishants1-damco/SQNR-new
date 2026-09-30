// Base ESLint flat config shared by every workspace. Mirrors the rules the
// original app used (typescript-eslint recommended + Prettier), without the
// React and TanStack Start specifics, which belong to apps/web.
import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import tseslint from "typescript-eslint";

export const ignores = { ignores: ["dist/**", "coverage/**", ".turbo/**"] };

export default tseslint.config(
  ignores,
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx,js,mjs}"],
    languageOptions: { ecmaVersion: 2022 },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  eslintPluginPrettier,
);
