// Config for packages that must run unchanged in Node, the browser and the
// worker: no I/O, no runtime-specific globals, no framework imports. This is
// what keeps @spatial/domain safe to share (see the migration plan, §6.1).
import base from "./index.js";

const forbiddenModules = [
  { name: "fs", message: "Shared packages must not do I/O." },
  { name: "path", message: "Shared packages must not depend on Node built-ins." },
  { name: "http", message: "Shared packages must not do I/O." },
  { name: "https", message: "Shared packages must not do I/O." },
  { name: "@supabase/supabase-js", message: "Data access belongs in apps/api or apps/worker." },
  { name: "pg", message: "Data access belongs in apps/api or apps/worker." },
  { name: "ioredis", message: "Redis access belongs in apps/api or apps/worker." },
  { name: "@azure/storage-blob", message: "Storage access belongs in packages/storage." },
  { name: "react", message: "UI code belongs in apps/web." },
];

export default [
  ...base,
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: forbiddenModules,
          patterns: [
            { group: ["node:*"], message: "Shared packages must not use Node built-ins." },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "window", message: "Shared packages run outside the browser." },
        { name: "document", message: "Shared packages run outside the browser." },
        { name: "navigator", message: "Shared packages run outside the browser." },
        { name: "localStorage", message: "Shared packages run outside the browser." },
        { name: "process", message: "Read configuration in apps, not in shared packages." },
        { name: "Buffer", message: "Use Uint8Array; Buffer is Node-only." },
        { name: "fetch", message: "Shared packages must not do I/O." },
      ],
    },
  },
];
