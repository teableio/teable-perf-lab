import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const measureCpuCanary = ({ iterations = 25_000 } = {}) => {
  const input = Buffer.alloc(1_024, 0x5a);
  const started = performance.now();
  let value = input;
  for (let index = 0; index < iterations; index += 1) {
    value = createHash("sha256").update(value).update(input).digest();
  }
  if (value.length !== 32) throw new Error("CPU canary produced no digest");
  return performance.now() - started;
};

export const measureDatabaseCanary = async ({
  containerName,
  database = "e2e_test_teable",
} = {}) => {
  if (!containerName) return undefined;
  const started = performance.now();
  const { stdout } = await execFileAsync("docker", [
    "exec",
    containerName,
    "psql",
    "-U",
    "teable",
    "-d",
    database,
    "-Atqc",
    "SELECT sum(value) FROM generate_series(1, 50000) AS value",
  ]);
  if (stdout.trim() !== "1250025000") {
    throw new Error(`Database canary returned ${stdout.trim() || "nothing"}`);
  }
  return performance.now() - started;
};

export const measureRunnerCanary = async (options = {}) => ({
  cpuCanaryMs: measureCpuCanary(options),
  databaseCanaryMs: await measureDatabaseCanary(options),
});
