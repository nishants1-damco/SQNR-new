import base from "@spatial/eslint-config";

export default [
  ...base,
  {
    files: ["**/*.ts"],
    rules: {
      // Nest injects by constructor parameter type, which lint sees as "type-only".
      "@typescript-eslint/consistent-type-imports": "off",
    },
  },
];
