import swc from "unplugin-swc";
import tsconfigPaths from "vite-tsconfig-paths";
import { configDefaults, defineConfig } from "vitest/config";
import { overridePathResolvePlugin } from "./vitest-override-plugin";

process.env.TZ = "UTC";
// The perf suite runs one serial spec against the workflow-managed database.
// Unlike the general e2e suite, it does not provision per-worker database clones.
process.env.E2E_WORKER_DB = "0";

const timeout = process.env.CI ? 60000 : 10000;
const perfLabSpec =
  "../../community/apps/nestjs-backend/test/perf-lab/perf-lab.e2e-spec.ts";

export default defineConfig({
  resolve: {
    conditions: ["@teable/source"],
  },
  ssr: {
    resolve: {
      conditions: ["@teable/source"],
      externalConditions: ["@teable/source"],
    },
  },
  plugins: [
    swc.vite({
      jsc: {
        target: "es2022",
      },
    }),
    overridePathResolvePlugin,
    tsconfigPaths(),
  ],
  cacheDir: "../../.cache/vitest/backend-ee/perf-lab",
  test: {
    globals: true,
    environment: "node",
    setupFiles: [
      "./vitest-e2e.setup.ts",
      "../../community/apps/nestjs-backend/test/perf-lab/framework/perf-runtime-env.setup.ts",
      "./vitest-e2e-init-app.setup.ts",
    ],
    testTimeout: timeout,
    hookTimeout: timeout,
    passWithNoTests: false,
    pool: "forks",
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reportsDirectory: "./coverage/perf-lab",
      include: ["src/**/*.{js,ts}"],
    },
    sequence: {
      hooks: "stack",
    },
    logHeapUsage: true,
    reporters: ["verbose"],
    include: [perfLabSpec],
    exclude: [...configDefaults.exclude, "**/.next/**"],
  },
});
