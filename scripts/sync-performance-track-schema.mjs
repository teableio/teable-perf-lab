import { env, requiredEnv } from "./env.mjs";
import { planPerformanceTrackSchema } from "./performance-track-schema-model.mjs";

const DEFAULT_ENDPOINT = "https://app.teable.ai";
const DEFAULT_TABLE_ID = "tblwPqrcchUzvyEOqLo";

const main = async () => {
  const endpoint = env("TEABLE_ENDPOINT", DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const token = requiredEnv("TEABLE_PERF_LAB_TOKEN");
  const tableId = env("TEABLE_PERF_LAB_TABLE_ID", DEFAULT_TABLE_ID);
  const apply = env("PERF_LAB_SCHEMA_APPLY") === "true";
  const request = async (method, path, body) => {
    const response = await fetch(`${endpoint}/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${method} ${path} failed: ${response.status} ${text}`);
    }
    return text ? JSON.parse(text) : undefined;
  };

  const fields = await request("GET", `/table/${tableId}/field`);
  const plan = planPerformanceTrackSchema(fields);
  if (plan.incompatible.length > 0) {
    throw new Error(
      `Incompatible Performance Track fields: ${plan.incompatible
        .map(
          ({ name, expectedType, actualType }) =>
            `${name} is ${actualType}, expected ${expectedType}`,
        )
        .join("; ")}`,
    );
  }
  if (plan.create.length === 0) {
    console.log("Performance Track schema is current.");
    return;
  }
  if (!apply) {
    console.log(JSON.stringify({ apply: false, ...plan }, null, 2));
    return;
  }
  for (const field of plan.create) {
    await request("POST", `/table/${tableId}/field`, field);
    console.log(`Created Performance Track field: ${field.name}`);
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
