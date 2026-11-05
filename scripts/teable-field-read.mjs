import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const loadTeableFields = async ({ endpoint, token, tableId, baseId }) => {
  let fields;
  if (token) {
    const response = await fetch(
      `${endpoint.replace(/\/+$/, "")}/api/table/${tableId}/field`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Teable field read failed: ${response.status} ${text}`);
    }
    fields = JSON.parse(text);
  } else {
    const childEnv = { ...process.env, NO_PROXY: "*", no_proxy: "*" };
    for (const key of [
      "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
      "http_proxy", "https_proxy", "all_proxy",
    ]) {
      delete childEnv[key];
    }
    const { stdout } = await execFileAsync(
      "teable",
      [
        "field", "get", "--table-id", tableId, "--endpoint", endpoint,
        ...(baseId ? ["--base-id", baseId] : []),
      ],
      { env: childEnv, maxBuffer: 16 * 1024 * 1024 },
    );
    const result = JSON.parse(stdout);
    if (result?.success === false) {
      throw new Error(`Teable field read failed: ${JSON.stringify(result)}`);
    }
    fields = result?.fields ?? result?.data ?? result;
  }
  if (!Array.isArray(fields)) {
    throw new Error("Invalid Teable field metadata: expected an array");
  }
  return fields;
};

export const loadTeableFieldNames = async (options) =>
  new Set((await loadTeableFields(options)).map((field) => field.name));
