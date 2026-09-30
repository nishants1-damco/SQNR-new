import { defineConfig } from "tsup";

// One entry per module so consumers import by subpath
// (`@spatial/domain/walk-legs`) and each module keeps its own namespace.
export default defineConfig({
  entry: ["src/*.ts", "!src/*.test.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
});
