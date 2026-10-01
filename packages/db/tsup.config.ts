import { defineConfig } from "tsup";

export default defineConfig({
  // `migrate` sits at the dist root so its ../migrations path still resolves;
  // container images run it as `node node_modules/@spatial/db/dist/migrate.js`.
  entry: { index: "src/index.ts", testing: "src/testing.ts", migrate: "src/cli/migrate.ts" },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  // import.meta.url in the CJS build (MIGRATIONS_DIR).
  shims: true,
});
