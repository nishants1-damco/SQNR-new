import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// End-to-end tests against the local stack (`pnpm infra:up`): a throwaway
// database per file, real Redis and Mailpit.
export default defineConfig({
  plugins: [swc.vite({ module: { type: "es6" } })],
  test: {
    environment: "node",
    include: ["test/**/*.int.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
