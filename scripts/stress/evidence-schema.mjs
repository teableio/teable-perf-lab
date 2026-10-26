// Checked-in ownership contract for the staging stress-evidence base.
// Every ID can be redirected independently without editing this repository.

export const DEFAULT_EVIDENCE_BASE_ID = "bseI12UcCPjJ9bnoGlQ";

export const DEFAULT_EVIDENCE_TABLE_IDS = Object.freeze({
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
});

export const EVIDENCE_TABLE_ID_ENV = Object.freeze({
  run: "EVIDENCE_RUN_TABLE_ID",
  scenario: "EVIDENCE_SCENARIO_TABLE_ID",
  metric: "EVIDENCE_METRIC_TABLE_ID",
  bottleneck: "EVIDENCE_BOTTLENECK_TABLE_ID",
  dataset: "EVIDENCE_DATASET_TABLE_ID",
  catalog: "EVIDENCE_CATALOG_TABLE_ID",
  report: "EVIDENCE_REPORT_TABLE_ID",
  cost: "EVIDENCE_COST_TABLE_ID",
  resource: "EVIDENCE_RESOURCE_TABLE_ID",
  correctness: "EVIDENCE_CORRECTNESS_TABLE_ID",
});

export function resolveEvidenceSchema(options = {}, env = process.env) {
  const tableIds = {};
  for (const [name, defaultId] of Object.entries(DEFAULT_EVIDENCE_TABLE_IDS)) {
    tableIds[name] =
      options.tableIds?.[name] || env[EVIDENCE_TABLE_ID_ENV[name]] || defaultId;
  }
  return Object.freeze({
    baseId: options.baseId || env.EVIDENCE_BASE_ID || DEFAULT_EVIDENCE_BASE_ID,
    tableIds: Object.freeze(tableIds),
  });
}
