import swc from "unplugin-swc";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";
import { overridePathResolvePlugin } from "./vitest-override-plugin";

process.env.TZ = "UTC";

export default defineConfig({
  resolve: { conditions: ["@teable/source"] },
  ssr: {
    resolve: {
      conditions: ["@teable/source"],
      externalConditions: ["@teable/source"],
    },
  },
  plugins: [
    swc.vite({ jsc: { target: "es2022" } }),
    overridePathResolvePlugin,
    tsconfigPaths(),
  ],
  cacheDir: "../../.cache/vitest/backend-ee/perf-contract",
  test: {
    globals: true,
    environment: "node",
    passWithNoTests: false,
    pool: "forks",
    fileParallelism: false,
    reporters: ["verbose"],
    include: [
      "../../community/apps/nestjs-backend/test/perf-lab/paired-contract-preflight.spec.ts",
    ],
  },
});
