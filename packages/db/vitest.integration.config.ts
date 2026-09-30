import { defineConfig } from "vitest/config";

// Integration tests against the local stack (`pnpm infra:up`).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.int.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
