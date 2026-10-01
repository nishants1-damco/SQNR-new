import { defineConfig } from "vitest/config";

// Against the local stack (`pnpm infra:up`): a Supabase-shaped source database,
// a migrated target database and Azurite.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.int.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
