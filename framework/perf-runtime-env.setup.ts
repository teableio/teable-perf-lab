import {
  applyCaseRuntimeEnv,
  applyPerfObservabilityRuntimeEnv,
  applySingleEngineBootstrapEnv,
} from "./perf-runtime-env";
import { getPerfCase, resolvePerfCaseIdsWithExclusions } from "../registry";

const perfCaseIds = resolvePerfCaseIdsWithExclusions(
  process.env.PERF_LAB_CASE_FILTER ??
    process.env.PERF_LAB_CASE_ID ??
    "smoke/auth-user",
  process.env.PERF_LAB_EXCLUDE_CASE_FILTER,
);

applyCaseRuntimeEnv(perfCaseIds.map(getPerfCase));
applyPerfObservabilityRuntimeEnv();
applySingleEngineBootstrapEnv();
