import swc from "unplugin-swc";
import tsconfigPaths from "vite-tsconfig-paths";
import { configDefaults, defineConfig } from "vitest/config";
import { overridePathResolvePlugin } from "./vitest-override-plugin";

process.env.TZ = "UTC";

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
    setupFiles: ["./vitest-e2e.setup.ts", "./vitest-e2e-init-app.setup.ts"],
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
