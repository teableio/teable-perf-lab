import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_EVIDENCE_BASE_ID,
  DEFAULT_EVIDENCE_TABLE_IDS,
  EVIDENCE_TABLE_ID_ENV,
  resolveEvidenceSchema,
} from "../evidence-schema.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const auditor = join(here, "..", "check-evidence-keys.mjs");

const EXPECTED_TABLE_IDS = {
  run: "tblpOfmLQ0oF7VBd0RG",
  scenario: "tblekRdSzxaSnWrI8Ef",
  metric: "tblBOkY7Coe7nEE5XNJ",
  bottleneck: "tblQ51xVeMHSVoF8bMW",
  dataset: "tblBlNbg5SvNXjmIcE9",
  catalog: "tbltNQJdOam0wabQreT",
  report: "tblRsIZoJQG6WSQ33CE",
  cost: "tbl29K7mcnlRWActQ6O",
  resource: "tblhbgQi86tNHPSgRLd",
  correctness: "tblor6okhLRPq3y6fW7",
};

function cleanEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of ["BASE_URL", "TEABLE_TOKEN", "TOKEN"]) delete env[key];
  return { ...env, ...overrides };
}

function run(args, env) {
  return spawnSync(process.execPath, [auditor, ...args], {
    encoding: "utf8",
    env: cleanEnv(env),
  });
}

test("schema documents the staging base and all ten evidence tables", () => {
  assert.equal(DEFAULT_EVIDENCE_BASE_ID, "bseI12UcCPjJ9bnoGlQ");
  assert.equal(Object.keys(DEFAULT_EVIDENCE_TABLE_IDS).length, 10);
  assert.deepEqual({ ...DEFAULT_EVIDENCE_TABLE_IDS }, EXPECTED_TABLE_IDS);
  assert.deepEqual(
    Object.keys(EVIDENCE_TABLE_ID_ENV).sort(),
    Object.keys(DEFAULT_EVIDENCE_TABLE_IDS).sort(),
  );
});

test("every table ID has an independent environment override", () => {
  const env = { EVIDENCE_BASE_ID: "bse_override" };
  for (const [name, variable] of Object.entries(EVIDENCE_TABLE_ID_ENV)) {
    env[variable] = `tbl_${name}`;
  }
  const schema = resolveEvidenceSchema({}, env);
  assert.equal(schema.baseId, "bse_override");
  for (const name of Object.keys(DEFAULT_EVIDENCE_TABLE_IDS)) {
    assert.equal(schema.tableIds[name], `tbl_${name}`);
  }
});

test("explicit schema options win over environment overrides", () => {
  const schema = resolveEvidenceSchema(
    { baseId: "bse_args", tableIds: { run: "tbl_args_run" } },
    { EVIDENCE_BASE_ID: "bse_env", [EVIDENCE_TABLE_ID_ENV.run]: "tbl_env_run" },
  );
  assert.equal(schema.baseId, "bse_args");
  assert.equal(schema.tableIds.run, "tbl_args_run");
  assert.equal(schema.tableIds.scenario, DEFAULT_EVIDENCE_TABLE_IDS.scenario);
});

test("the audit refuses to run without read credentials before any request", () => {
  const missing = run(["--json"], {});
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /BASE_URL and TEABLE_TOKEN are required/);

  const noToken = run(["--json", "--base-url", "https://staging.invalid"], {});
  assert.equal(noToken.status, 2);
  assert.match(noToken.stderr, /BASE_URL and TEABLE_TOKEN are required/);
});

test("extra arguments do not bypass the credential guard", () => {
  const selected = run(
    ["--json", "--table", "tbl_extra", "--base-id", "bse_ignored"],
    {},
  );
  assert.equal(selected.status, 2);
  assert.match(selected.stderr, /BASE_URL and TEABLE_TOKEN are required/);
});

test("a CLI token cannot bypass missing environment credentials", () => {
  const result = run([
    "--json",
    "--base-url",
    "https://staging.invalid",
    "--token",
    "cli-secret",
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /BASE_URL and TEABLE_TOKEN are required/);
});
