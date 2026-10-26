"""Offline tests for the C0 breakpoint analyzer.

Every fixture is local; no SigNoz, cloud, or subprocess calls are made.
"""

import argparse
import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

HERE = Path(__file__).resolve()
STRESS_DIR = HERE.parents[1]
FIXTURES = HERE.parent / "fixtures"
sys.path.insert(0, str(STRESS_DIR))

SPEC = importlib.util.spec_from_file_location("c0_analyze", STRESS_DIR / "c0-analyze.py")
c0 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(c0)

START = "2026-10-24T04:30:00Z"
END = "2026-10-24T04:32:00Z"
MINUTE_1 = "2026-10-24T04:30:00Z"
MINUTE_2 = "2026-10-24T04:31:00Z"


def series(labels, points):
    return {
        "labels": labels,
        "points": [{"ts": ts, "value": value} for ts, value in points],
    }


def block(series_list=None, status="ok", error=None):
    return {
        "status": status,
        "error": error,
        "series": series_list or [],
    }


def empty_blocks():
    return {
        "server": {
            "dataApiP95": block(status="no_data"),
            "dataApiP99": block(status="no_data"),
            "dataApiOutcomes": block(status="no_data"),
        },
        "db": {
            "poolConnections": block(status="no_data"),
            "poolLimit": block(status="no_data"),
            "poolWaiting": block(status="no_data"),
            "acquireTimeouts": block(status="no_data"),
        },
        "outbox": {
            "oldestDueAgeMs": block(status="no_data"),
            "backlog": block(status="no_data"),
            "queueReachable": block(status="no_data"),
        },
    }


def evaluate(server=None, db=None, outbox=None, rds=None, db_samples=None):
    blocks = empty_blocks()
    blocks["server"].update(server or {})
    blocks["db"].update(db or {})
    blocks["outbox"].update(outbox or {})
    args = SimpleNamespace(step_interval=60, db_namespace="byodb_test")
    rds = rds if rds is not None else {"status": "no_data", "metrics": {}}
    db_samples = db_samples if db_samples is not None else {"status": "no_data"}
    return c0.evaluate_guardrails(
        args,
        c0.iso_ms(START),
        c0.iso_ms(END),
        {"http": {}, "duration": {}},
        blocks["server"],
        blocks["db"],
        blocks["outbox"],
        rds,
        db_samples,
    )


class PerMinuteQuantileTests(unittest.TestCase):
    def test_quantiles_keep_each_minute_and_never_average_the_window(self):
        p99 = block([
            series({"implementation": "v1", "operation": "read"},
                   [(MINUTE_1, 1000.0), (MINUTE_2, 2000.0)]),
            series({"implementation": "v2", "operation": "read"},
                   [(MINUTE_1, 4000.0), (MINUTE_2, 3000.0)]),
        ])
        p95 = block([
            series({"implementation": "v1", "operation": "read"},
                   [(MINUTE_1, 500.0), (MINUTE_2, 900.0)]),
            series({"implementation": "v2", "operation": "read"},
                   [(MINUTE_1, 700.0), (MINUTE_2, 1500.0)]),
        ])
        outcomes = block([
            series({"implementation": "v1", "operation": "read", "outcome": "success"},
                   [(MINUTE_1, 100.0), (MINUTE_2, 100.0)]),
        ])

        result = evaluate(server={
            "dataApiP99": p99,
            "dataApiP95": p95,
            "dataApiOutcomes": outcomes,
        })

        minutes = result["perMinute"]
        self.assertEqual([item["ts"] for item in minutes], [MINUTE_1, MINUTE_2])
        self.assertEqual([item["p99Ms"] for item in minutes], [4000.0, 3000.0])
        self.assertEqual([item["p95Ms"] for item in minutes], [700.0, 1500.0])
        self.assertEqual(minutes[0]["p99WorstGroup"],
                         {"implementation": "v2", "operation": "read"})
        self.assertEqual(minutes[0]["p99ByImplementation"], {"v1": 1000.0, "v2": 4000.0})
        # A window average would be 2500.0; neither minute may show it.
        window_average = round(sum([1000.0, 4000.0, 2000.0, 3000.0]) / 4, 1)
        self.assertNotIn(window_average, [item["p99Ms"] for item in minutes])
        self.assertIn("never a window average", result["quantileSemantics"])

    def test_quantile_series_without_points_stays_null(self):
        result = evaluate()
        for minute in result["perMinute"]:
            self.assertIsNone(minute["p99Ms"])
            self.assertIsNone(minute["p95Ms"])
            self.assertIsNone(minute["p99WorstGroup"])
            self.assertEqual(minute["p99ByImplementation"], {})


class MissingDataTests(unittest.TestCase):
    def test_missing_sources_are_null_and_insufficient(self):
        result = evaluate()
        self.assertEqual(result["minuteCount"], 2)
        self.assertEqual(result["completeMinuteCount"], 0)
        self.assertEqual(result["coveragePct"], 0.0)
        self.assertEqual(result["verdict"], "insufficient_data")
        self.assertEqual(result["breaches"], [])
        self.assertEqual(result["missingMinuteCounts"]["p99Ms"], 2)
        self.assertEqual(result["missingMinuteCounts"]["rdsCpuPct"], 2)

    def test_error_rate_requires_samples_in_the_same_minute(self):
        result = evaluate(server={
            "dataApiOutcomes": block([
                series({"implementation": "v1", "operation": "read",
                        "outcome": "server_error"}, [(MINUTE_1, 0.05)]),
            ]),
        })
        first = result["perMinute"][0]
        self.assertEqual(first["errorRatePct"], 100.0)
        self.assertEqual(first["errorRateSampleCount"], 3)
        # 100% over 3 samples is below the 10-sample floor: not a breach.
        self.assertEqual(first["breaches"], [])
        self.assertIsNone(result["perMinute"][1]["errorRatePct"])

    def test_rds_cpu_missing_never_zero_fills(self):
        result = evaluate(rds={"status": "source_error", "error": "unreadable",
                               "metrics": {}})
        self.assertIsNone(result["perMinute"][0]["rdsCpuPct"])
        self.assertEqual(result["missingMinuteCounts"]["rdsCpuPct"], 2)

    def test_availability_excludes_client_errors_and_counts_failure_outcomes(self):
        outcomes = []
        values = {
            "success": 70.0,
            "not_modified": 10.0,
            "client_error": 10.0,
            "server_error": 2.0,
            "throttled": 3.0,
            "aborted": 4.0,
            "unexpected": 1.0,
        }
        for outcome, value in values.items():
            outcomes.append(series({"implementation": "v1", "operation": "list",
                                    "outcome": outcome}, [(MINUTE_1, value)]))
        outcomes.append(series({"implementation": "v1", "operation": "get",
                                "outcome": "success"}, [(MINUTE_1, 20.0)]))
        first = evaluate(server={"dataApiOutcomes": block(outcomes)})["perMinute"][0]
        self.assertEqual(first["requestRate"], 120.0)
        self.assertEqual(first["errorRatePct"], 8.333)
        self.assertEqual(first["clientErrorRatePct"], 8.333)

    def test_pool_identity_keeps_multiple_pools_and_only_matches_same_pool(self):
        def pool_labels(name, state=None):
            labels = {"host.name": "host-a", "db.namespace": "byodb_test",
                      "teable.database.pool.name": name}
            if state is not None:
                labels["state"] = state
            return labels

        result = evaluate(db={
            "poolConnections": block([
                series(pool_labels("pool-a", "total"), [(MINUTE_1, 8.0)]),
                series(pool_labels("pool-b", "total"), [(MINUTE_1, 4.0)]),
                series(pool_labels("unmatched", "total"), [(MINUTE_1, 100.0)]),
            ]),
            "poolLimit": block([
                series(pool_labels("pool-a"), [(MINUTE_1, 10.0)]),
                series(pool_labels("pool-b"), [(MINUTE_1, 10.0)]),
            ]),
            "poolWaiting": block([
                series(pool_labels("pool-a"), [(MINUTE_1, 1.0)]),
                series(pool_labels("pool-b"), [(MINUTE_1, 2.0)]),
            ]),
        })
        first = result["perMinute"][0]
        self.assertEqual(first["poolConnections"], 12.0)
        self.assertEqual(first["poolLimit"], 20.0)
        self.assertEqual(first["poolUtilPct"], 60.0)
        self.assertEqual(first["poolWaiting"], 3.0)

    def test_acquisition_timeout_breaches_on_any_positive_rate(self):
        first = evaluate(db={
            "acquireTimeouts": block([
                series({"teable.database.role": "byodb"}, [(MINUTE_1, 0.01)]),
            ]),
        })["perMinute"][0]
        self.assertEqual(first["acquireTimeoutsPerSec"], 0.01)
        self.assertIn("acquireTimeouts", [breach["rule"] for breach in first["breaches"]])

    def test_rds_non_ok_metric_points_are_ignored(self):
        for status in ("no_data", "source_error"):
            result = evaluate(rds={"status": status, "metrics": {
                "CPUUtilization": {"status": status, "points": [
                    {"ts": MINUTE_1, "value": 99.0},
                ]},
            }})
            self.assertIsNone(result["perMinute"][0]["rdsCpuPct"])


    def test_rds_ok_metric_points_are_used(self):
        result = evaluate(rds={"status": "ok", "metrics": {
            "CPUUtilization": {"status": "ok", "points": [
                {"ts": MINUTE_1, "value": 42.5},
            ]},
        }})
        self.assertEqual(result["perMinute"][0]["rdsCpuPct"], 42.5)

class RdsMetricsLoaderTests(unittest.TestCase):
    def test_normalizes_points_and_preserves_provenance(self):
        loaded = c0.load_rds_metrics(str(FIXTURES / "rds-metrics.json"))
        self.assertEqual(loaded["status"], "ok")
        self.assertEqual(loaded["runId"], "lst_fixture_000000000")
        self.assertEqual(loaded["step"], "s25")
        self.assertEqual(loaded["instance"], "db-fixture")
        self.assertEqual(loaded["region"], "test-region-1")
        self.assertEqual(loaded["instanceStatus"], "available")
        self.assertTrue(loaded["supplied"])
        self.assertEqual(loaded["source"], str(FIXTURES / "rds-metrics.json"))

        cpu = loaded["metrics"]["CPUUtilization"]
        self.assertEqual(cpu["status"], "ok")
        self.assertEqual(cpu["unit"], "Percent")
        self.assertEqual(cpu["points"], [
            {"ts": MINUTE_1, "value": 41.0},
            {"ts": MINUTE_2, "value": 42.5},
        ])

        connections = loaded["metrics"]["DatabaseConnections"]
        self.assertEqual(connections["status"], "no_data")
        self.assertEqual(connections["points"], [])
        # The fixture's declared top-level error is authoritative, including null.
        self.assertIsNone(loaded["error"])

    def test_absent_input_is_no_data(self):
        loaded = c0.load_rds_metrics("")
        self.assertEqual(loaded["status"], "no_data")
        self.assertIn("--rds-metrics", loaded["error"])
        self.assertEqual(loaded["metrics"], {})
        self.assertIsNone(loaded["instance"])
        self.assertFalse(loaded["supplied"])
        self.assertIsNone(loaded["source"])

    def test_unreadable_document_is_source_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "bad.json"
            bad.write_text("[1, 2, 3]", encoding="utf-8")
            loaded = c0.load_rds_metrics(str(bad))
            self.assertEqual(loaded["status"], "source_error")
            self.assertIn("object", loaded["error"])

            missing = c0.load_rds_metrics(str(Path(tmp) / "missing.json"))
            self.assertEqual(missing["status"], "source_error")

    def test_empty_points_remain_no_data_without_zero_fill(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "empty.json"
            path.write_text(json.dumps({
                "metrics": {
                    "CPUUtilization": {
                        "status": "no_data",
                        "points": [],
                    },
                },
            }), encoding="utf-8")
            loaded = c0.load_rds_metrics(str(path))
            self.assertEqual(loaded["status"], "no_data")
            self.assertEqual(loaded["metrics"]["CPUUtilization"]["status"], "no_data")
            self.assertEqual(loaded["metrics"]["CPUUtilization"]["points"], [])


    def test_top_level_declared_status_and_error_are_authoritative(self):
        for status in ("no_data", "source_error"):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / "declared-top.json"
                declared_error = f"declared {status}"
                path.write_text(json.dumps({
                    "status": status,
                    "error": declared_error,
                    "metrics": {
                        "CPUUtilization": {
                            "status": "ok",
                            "points": [{"ts": MINUTE_1, "value": 42}],
                        },
                    },
                }), encoding="utf-8")

                loaded = c0.load_rds_metrics(str(path))

                self.assertEqual(loaded["status"], status)
                self.assertEqual(loaded["error"], declared_error)
                self.assertEqual(loaded["metrics"]["CPUUtilization"]["status"], "ok")
                self.assertEqual(loaded["metrics"]["CPUUtilization"]["points"], [
                    {"ts": MINUTE_1, "value": 42.0},
                ])

    def test_metric_declared_status_and_error_survive_usable_points(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "declared-metrics.json"
            path.write_text(json.dumps({
                "metrics": {
                    "CPUUtilization": {
                        "status": "no_data",
                        "error": "declared CPU gap",
                        "points": [{"ts": MINUTE_1, "value": 42}],
                    },
                    "DatabaseConnections": {
                        "status": "source_error",
                        "error": "declared connection failure",
                        "points": [{"ts": MINUTE_1, "value": 7}],
                    },
                },
            }), encoding="utf-8")

            loaded = c0.load_rds_metrics(str(path))

            cpu = loaded["metrics"]["CPUUtilization"]
            self.assertEqual(cpu["status"], "no_data")
            self.assertEqual(cpu["error"], "declared CPU gap")
            self.assertEqual(cpu["points"], [{"ts": MINUTE_1, "value": 42.0}])
            connections = loaded["metrics"]["DatabaseConnections"]
            self.assertEqual(connections["status"], "source_error")
            self.assertEqual(connections["error"], "declared connection failure")
            self.assertEqual(connections["points"], [
                {"ts": MINUTE_1, "value": 7.0},
            ])
            self.assertEqual(loaded["status"], "source_error")


class K6AndDbSampleNormalizationTests(unittest.TestCase):
    def test_raw_k6_summary_is_compactable(self):
        # Raw handleSummary shape; stress-tests/tools/k6-summary.mjs
        # owns the compact c0-k6-summary/v2 producer.
        k6 = c0.normalise_k6(str(FIXTURES / "k6-summary.json"))
        self.assertEqual(k6["shape"], "raw")
        self.assertEqual(k6["http"]["requests"], 100.0)
        self.assertAlmostEqual(k6["http"]["failedCount"], 1.0)
        self.assertEqual(k6["duration"]["p99"], 900.0)
        self.assertEqual(k6["operations"]["list"]["p99"], 900.0)

    def test_db_sampler_missing_file_is_explicit(self):
        loaded = c0.load_db_samples("")
        self.assertEqual(loaded["status"], "no_data")
        self.assertIn("--db-samples", loaded["error"])

    def test_db_sampler_counter_reset_yields_null_rate(self):
        records = [
            {"ts": MINUTE_1, "status": "ok", "commits": 100},
            {"ts": MINUTE_2, "status": "ok", "commits": 50},
        ]
        rates = c0.db_rates(records)
        self.assertIsNone(rates[MINUTE_2]["commitsPerSec"])
        self.assertTrue(rates[MINUTE_2]["counterReset"])

    def test_db_sampler_flattens_infrastructure_envelope(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "db.jsonl"
            rows = [
                {"run_id": "lst_test", "step": "s25", "status": "ok",
                 "sample": {"ts": MINUTE_1, "commits": 100, "conns": 4}},
                {"run_id": "lst_test", "step": "s25", "status": "ok",
                 "sample": {"ts": MINUTE_2, "commits": 160, "conns": 5}},
            ]
            path.write_text("\n".join(json.dumps(row) for row in rows) + "\n",
                            encoding="utf-8")
            loaded = c0.load_db_samples(str(path))
        self.assertEqual(loaded["status"], "ok")
        self.assertTrue(loaded["supplied"])
        self.assertEqual(loaded["source"], str(path))
        self.assertEqual(loaded["provenanceRows"], [
            {"line": 1, "runId": "lst_test", "step": "s25"},
            {"line": 2, "runId": "lst_test", "step": "s25"},
        ])
        self.assertEqual(loaded["runIds"], ["lst_test"])
        self.assertEqual(loaded["steps"], ["s25"])
        self.assertEqual(loaded["byMinute"][MINUTE_1]["conns"], 4)
        self.assertEqual(loaded["byMinute"][MINUTE_1]["status"], "ok")
        self.assertEqual(loaded["ratesByMinute"][MINUTE_2]["commitsPerSec"], 1.0)


class ProvenanceValidationTests(unittest.TestCase):
    def test_matching_or_absent_provenance_is_accepted(self):
        c0.validate_provenance(
            "lst_test", "s25", 25.0,
            {"runId": None, "step": None, "targetRps": None},
            {"supplied": False, "runId": None, "step": None, "metrics": {}},
            {"supplied": False, "records": {}, "runIds": [], "steps": [],
             "provenanceRows": []},
        )

    def test_any_supplied_provenance_mismatch_is_rejected(self):
        cases = [
            ({"runId": "other", "step": None, "targetRps": None}, {}, {}),
            ({"runId": None, "step": "other", "targetRps": None}, {}, {}),
            ({"runId": None, "step": None, "targetRps": 50}, {}, {}),
            ({}, {"runId": "other", "step": "s25"}, {}),
            ({}, {}, {"runIds": ["lst_test"], "steps": ["other"]}),
        ]
        for k6, rds, db_samples in cases:
            with self.subTest(k6=k6, rds=rds, db_samples=db_samples):
                with self.assertRaisesRegex(ValueError, "provenance mismatch"):
                    c0.validate_provenance("lst_test", "s25", 25, k6, rds, db_samples)

    def test_supplied_rds_metrics_require_run_id_and_step(self):
        base = {"supplied": True, "metrics": {"CPUUtilization": {"status": "ok"}}}
        for artifact, missing in (({**base, "step": "s25"}, "runId"),
                                  ({**base, "runId": "lst_test"}, "step")):
            with self.subTest(missing=missing):
                with self.assertRaisesRegex(ValueError, f"rds.{missing} is required"):
                    c0.validate_provenance(
                        "lst_test", "s25", 25, {}, artifact,
                        {"supplied": False, "records": {}, "provenanceRows": []})

    def test_every_usable_db_row_requires_run_id_and_step(self):
        rows = [
            {"line": 1, "runId": "lst_test", "step": "s25"},
            {"line": 2, "runId": None, "step": "s25"},
            {"line": 3, "runId": "lst_test", "step": None},
        ]
        db_samples = {
            "supplied": True,
            "records": {MINUTE_1: {}, MINUTE_2: {}},
            "provenanceRows": rows,
        }
        with self.assertRaisesRegex(ValueError, "line 2: runId is required") as raised:
            c0.validate_provenance("lst_test", "s25", 25, {}, {}, db_samples)
        self.assertIn("line 3: step is required", str(raised.exception))

    def test_compact_summary_requires_exact_schema_and_provenance(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "compact.json"
            path.write_text(json.dumps({
                "schema": "c0-k6-summary/v1",
                "runId": "lst_test",
                "step": "s25",
                "targetRps": 25,
                "http": {},
                "http_req_duration": {},
            }), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "c0-k6-summary/v2"):
                c0.normalise_k6(str(path))


    def test_valid_compact_summary_preserves_provenance(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "compact.json"
            path.write_text(json.dumps({
                "schema": "c0-k6-summary/v2",
                "runId": "lst_test",
                "step": "s25",
                "targetRps": 25,
                "http": {},
                "http_req_duration": {},
                "ops": {},
            }), encoding="utf-8")
            loaded = c0.normalise_k6(str(path))
        self.assertEqual(loaded["shape"], "compact")
        self.assertEqual(loaded["runId"], "lst_test")
        self.assertEqual(loaded["step"], "s25")
        self.assertEqual(loaded["targetRps"], 25)

class SigNozQueryContractTests(unittest.TestCase):
    def query_body(self, operator):
        captured = {}

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return b'{"status":"success","data":{"result":[]}}'

        def open_request(request, timeout):
            captured["body"] = json.loads(request.data.decode())
            self.assertEqual(timeout, 90)
            return Response()

        with mock.patch.object(c0.urllib.request, "urlopen", side_effect=open_request):
            c0.signoz_query("fixture.metric", operator,
                            signoz_url="https://signoz.example.test",
                            signoz_key="key", service_name="service")
        return captured["body"]["compositeQuery"]["builderQueries"]["A"]

    def test_counters_use_rate_over_time_and_sum_over_space(self):
        query = self.query_body("count")
        self.assertEqual(query["timeAggregation"], "rate")
        self.assertEqual(query["spaceAggregation"], "sum")

    def test_quantile_aggregations_remain_quantiles(self):
        query = self.query_body("p99")
        self.assertEqual(query["timeAggregation"], "p99")
        self.assertEqual(query["spaceAggregation"], "p99")


class ConfigurationTests(unittest.TestCase):
    def test_module_has_no_connection_defaults(self):
        self.assertEqual(c0.SIGNOZ_URL, "")
        self.assertEqual(c0.SIGNOZ_KEY, "")
        self.assertEqual(c0.SERVICE_NAME, "")

    def test_required_setting_fails_without_cli_or_environment(self):
        parser = argparse.ArgumentParser()
        with mock.patch.dict(os.environ, {}, clear=True):
            with contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    c0.required_setting(parser, "", "SIGNOZ_URL", "--signoz-url")

    def test_required_setting_reads_environment(self):
        parser = argparse.ArgumentParser()
        with mock.patch.dict(os.environ, {"SIGNOZ_SERVICE_NAME": "fixture-service"},
                             clear=True):
            resolved = c0.required_setting(
                parser, "", "SIGNOZ_SERVICE_NAME", "--signoz-service")
        self.assertEqual(resolved, "fixture-service")


if __name__ == "__main__":
    unittest.main()
