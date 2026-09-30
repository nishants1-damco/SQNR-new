import { defineConfig } from "vitest/config";

// Unit tests only: no database needed.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.int.test.ts"],
  },
});
