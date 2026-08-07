// Print the distinct commit refs the corpus needs to position, one per line.
//
// Two flavours, because the corpus keys on two different repositories:
//
//   --teable-ee   the commits under test, from `Teable EE Ref`
//   --perf-lab    the commits that took the measurements, from `Commit SHA`
//
// Split out of the resolvers so that neither of them needs to know how to talk
// to Teable, and so a developer can pipe a hand-written list into either one
// while debugging.
//
// Only the ref column is selected. The table's long-text columns run to
// hundreds of megabytes, and a `SELECT *` here would be both enormous and
// pointless.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { env } from "./env.mjs";

const execFileAsync = promisify(execFile);

const DEFAULT_ENDPOINT = "https://app.teable.ai";
const DEFAULT_BASE_ID = "bselS3I2MeVI6RJhS4g";
const DEFAULT_TABLE = "tblwPqrcchUzvyEOqLo";

const COLUMNS = {
  "--teable-ee": "Teable_EE_Ref",
  "--perf-lab": "Commit_SHA",
};

const sqlQuery = async ({ endpoint, token, baseId, sql }) => {
  if (token) {
    const res = await fetch(
      `${endpoint.replace(/\/+$/, "")}/api/base/${baseId}/query?${new URLSearchParams({ query: sql })}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Teable SQL failed: ${res.status} ${text}`);
    }
    const data = JSON.parse(text);
    if (data?.success === false) {
      throw new Error(data.error ?? "unknown SQL error");
    }
    return data?.rows ?? [];
  }

  // No service token: fall back to the signed-in CLI, which is how this runs on
  // a developer's machine.
  const { stdout } = await execFileAsync(
    "teable",
    ["sql-query", "--base-id", baseId, "--sql", sql],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const data = JSON.parse(stdout);
  if (data?.success === false) {
    throw new Error(data.error ?? "unknown SQL error");
  }
  return data?.rows ?? [];
};

const main = async () => {
  const flag = process.argv.find((argument) => COLUMNS[argument]);
  if (!flag) {
    throw new Error(
      `Pass one of ${Object.keys(COLUMNS).join(" or ")} to say which repository's refs to list.`,
    );
  }

  const baseId = env("TEABLE_PERF_LAB_BASE_ID", DEFAULT_BASE_ID);
  const table = `"${baseId}"."${env("TEABLE_PERF_LAB_TABLE_ID", DEFAULT_TABLE)}"`;
  const column = COLUMNS[flag];

  const rows = await sqlQuery({
    endpoint: env("TEABLE_ENDPOINT", DEFAULT_ENDPOINT),
    token: env("TEABLE_PERF_LAB_TOKEN"),
    baseId,
    // Only full SHAs. A branch name pins nothing, and the ordering resolver
    // reports those as unpinned anyway — filtering here keeps the list honest
    // and the response small.
    sql: `SELECT DISTINCT "${column}" AS r FROM ${table}
          WHERE "${column}" IS NOT NULL AND LENGTH("${column}") = 40`,
  });

  process.stdout.write(`${rows.map((row) => row.r).join("\n")}\n`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
