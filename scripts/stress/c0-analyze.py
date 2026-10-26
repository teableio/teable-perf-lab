#!/usr/bin/env python3
"""C0 breakpoint step analyzer.

Reads a k6 summary, queries SigNoz for the plateau window, and joins normalized
RDS metrics and optional database samples into the guardrail evidence document.

Contract highlights:
  * SigNoz URL, service name, and database namespace are explicit CLI or
    environment-owned inputs; this analyzer has no production defaults.
  * Quantile metrics (histogram ``.bucket``) remain per-minute time series.
    They are never averaged into a whole-window p95/p99.
  * Missing data is ``null`` with status ``no_data``; file, query, and transport
    failures are ``source_error``. Nothing is coerced to zero.
  * RDS collection is outside this process. ``--rds-metrics`` accepts the
    normalized JSON emitted by the infrastructure sampler.
  * ``--run-id``, ``--step``, and ``--target`` are checked against every
    supplied artifact's provenance before SigNoz is queried.

Usage:
  SIGNOZ_API_KEY=... python3 scripts/stress/c0-analyze.py \
    --run-id lst_example --step s25 --target 25 --k6 summary-s25.json \
    --signoz-url https://signoz.example.test --signoz-service loadtest \
    --db-namespace customer_db --start 2026-10-24T04:30:00Z \
    --end 2026-10-24T05:00:00Z --rds-metrics rds-s25.json \
    --db-samples db-samples.jsonl --out s25.json
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

SIGNOZ_URL = ""
SIGNOZ_KEY = ""
SERVICE_NAME = ""

RESOURCE_KEYS = {"service.name", "host.name", "deployment.environment"}

QUANTILES = {"p95", "p99"}


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def iso_ms(value):
    if isinstance(value, (int, float)):
        return int(value)
    text = value.replace("Z", "+00:00")
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def ms_iso(value):
    return datetime.fromtimestamp(value / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def field_type(key):
    if key in RESOURCE_KEYS or key.startswith("process."):
        return "resource"
    return "tag"


def block(metric, group_by, unit, value_role, status="ok", error=None, series=None,
          extra=None):
    out = {
        "status": status,
        "error": error,
        "metric": metric,
        "unit": unit,
        "groupBy": list(group_by),
        "valueRole": value_role,
        "series": series or [],
    }
    if extra:
        out.update(extra)
    return out


def signoz_query(metric, aggregate_operator, group_by=(), start=None, end=None, step=60,
                 time_aggregation=None, space_aggregation=None, unit="", value_role="per_minute",
                 extra_filters=(), metric_type="Gauge", signoz_url=None, signoz_key=None,
                 service_name=None):
    """Run one SigNoz builder query and return a normalised block.

    status: ok | no_data | source_error. Series keep every timestamped point.
    Connection values come from the caller; nothing is defaulted here.
    """
    group_by = list(group_by)
    url = (SIGNOZ_URL if signoz_url is None else signoz_url).rstrip("/")
    key = SIGNOZ_KEY if signoz_key is None else signoz_key
    service = SERVICE_NAME if service_name is None else service_name
    if not url:
        return block(metric, group_by, unit, value_role, status="source_error",
                     error="SigNoz URL is required (--signoz-url or SIGNOZ_URL)")
    if not service:
        return block(metric, group_by, unit, value_role, status="source_error",
                     error="SigNoz service is required (--signoz-service or SIGNOZ_SERVICE_NAME)")
    if not key:
        return block(metric, group_by, unit, value_role, status="source_error",
                     error="SIGNOZ_API_KEY not set")

    filters = [{
        "key": {"key": "service.name", "dataType": "string", "type": "resource"},
        "op": "=",
        "value": service,
    }]
    filters.extend(extra_filters)

    body = {
        "start": start,
        "end": end,
        "step": step,
        "compositeQuery": {
            "queryType": "builder",
            "panelType": "graph",
            "builderQueries": {
                "A": {
                    "dataSource": "metrics",
                    "queryName": "A",
                    "aggregateOperator": aggregate_operator,
                    "aggregateAttribute": {
                        "key": metric,
                        "dataType": "float64",
                        "type": metric_type,
                    },
                    "timeAggregation": time_aggregation or (
                        aggregate_operator if aggregate_operator in QUANTILES
                        else "rate" if aggregate_operator == "count" else "avg"
                    ),
                    "spaceAggregation": space_aggregation or (
                        aggregate_operator if aggregate_operator in QUANTILES
                        else "sum" if aggregate_operator == "count" else "max"
                    ),
                    "stepInterval": step,
                    "expression": "A",
                    "filters": {"op": "AND", "items": filters},
                    "groupBy": [
                        {"key": key, "dataType": "string", "type": field_type(key)}
                        for key in group_by
                    ],
                    "legend": "",
                    "reduceTo": "max",
                    "having": [],
                    "disabled": False,
                }
            },
        },
    }
    payload = json.dumps(body).encode()
    request = urllib.request.Request(
        f"{url}/api/v4/query_range",
        data=payload,
        headers={"SIGNOZ-API-KEY": key, "content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            raw = response.read().decode()
    except (urllib.error.URLError, OSError) as exc:
        return block(metric, group_by, unit, value_role, status="source_error",
                     error=f"signoz transport: {type(exc).__name__}: {exc}"[:300])
    try:
        result = json.loads(raw)
    except json.JSONDecodeError:
        return block(metric, group_by, unit, value_role, status="source_error",
                     error=f"signoz non-json response: {raw[:200]}")
    if result.get("status") != "success":
        return block(metric, group_by, unit, value_role, status="source_error",
                     error=f"signoz api: {str(result)[:300]}")

    series = []
    for item in (result.get("data") or {}).get("result") or []:
        for s in item.get("series") or []:
            points = []
            for point in s.get("values") or []:
                raw_value = point.get("value")
                if raw_value in (None, "NaN"):
                    continue
                try:
                    value = float(raw_value)
                except (TypeError, ValueError):
                    continue
                points.append({"ts": ms_iso(point["timestamp"]), "value": value})
            if not points:
                continue
            points.sort(key=lambda p: p["ts"])
            values = [p["value"] for p in points]
            series.append({
                "labels": s.get("labels") or {},
                "points": points,
                "pointCount": len(points),
                "pointMin": min(values),
                "pointMax": max(values),
            })

    if not series:
        return block(metric, group_by, unit, value_role, status="no_data")

    extra = {
        "aggregatedAcrossWindow": False,
        "quantile": aggregate_operator if aggregate_operator in QUANTILES else None,
        "aggregateOperator": aggregate_operator,
        "timeAggregation": body["compositeQuery"]["builderQueries"]["A"]["timeAggregation"],
        "spaceAggregation": body["compositeQuery"]["builderQueries"]["A"]["spaceAggregation"],
        "stepSeconds": step,
    }
    if aggregate_operator in QUANTILES:
        extra["note"] = (
            "per-minute quantile from histogram buckets; do not average these points"
        )
    return block(metric, group_by, unit, value_role, series=series, extra=extra)


RDS_METRIC_UNITS = {
    "CPUUtilization": "Percent",
    "DatabaseConnections": "Count",
    "ReadIOPS": "Count/Second",
    "WriteIOPS": "Count/Second",
    "FreeableMemory": "Bytes",
    "DiskQueueDepth": "Count",
    "TransactionLogsDiskUsage": "Bytes",
}

NORMALIZED_STATUSES = {"ok", "no_data", "source_error"}


def iso_to_utc_iso(value):
    dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_rds_metrics(path):
    """Normalise a sampled RDS metrics document. No collection happens here.

    The document is ``{run_id, step, status, error, instance, region,
    instanceStatus, metrics: {NAME: {status, error, statistic, unit,
    points: [{ts, value}]}}}``. Missing points stay ``no_data`` and unreadable
    input stays ``source_error``; nothing is zero-filled.
    """
    out = {
        "status": "no_data",
        "error": "no --rds-metrics supplied",
        "instance": None,
        "region": None,
        "instanceStatus": None,
        "runId": None,
        "step": None,
        "source": path or None,
        "supplied": bool(path),
        "declaredStatus": None,
        "declaredError": None,
        "metrics": {},
    }
    if not path:
        return out
    try:
        with open(path) as handle:
            raw = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        out.update({
            "status": "source_error",
            "source": path,
            "error": f"rds metrics: {type(exc).__name__}: {exc}"[:300],
        })
        return out
    if not isinstance(raw, dict):
        out.update({
            "status": "source_error",
            "source": path,
            "error": "rds metrics: top-level value must be an object",
        })
        return out

    out.update({
        "source": path,
        "instance": raw.get("instance") or raw.get("dbInstanceIdentifier"),
        "region": raw.get("region"),
        "instanceStatus": raw.get("instanceStatus"),
        "runId": raw.get("run_id") or raw.get("runId"),
        "step": raw.get("step"),
        "declaredStatus": raw.get("status"),
        "declaredError": raw.get("error"),
    })
    metrics = raw.get("metrics")
    declared_status = raw.get("status")
    if declared_status is not None and declared_status not in NORMALIZED_STATUSES:
        out.update({
            "status": "source_error",
            "error": f"rds metrics: invalid declared status {declared_status!r}",
        })
        return out
    if not isinstance(metrics, dict) or not metrics:
        derived_status = (
            "source_error" if "metrics" in raw and not isinstance(metrics, dict)
            else "no_data"
        )
        out.update({
            "status": declared_status or derived_status,
            "error": raw.get("error") if declared_status else (
                raw.get("error") or "rds metrics: document has no metrics object"
            ),
        })
        return out

    errors = []
    for name, metric in metrics.items():
        fallback_unit = RDS_METRIC_UNITS.get(name, "")
        if isinstance(metric, list):
            metric = {"points": metric}
        if not isinstance(metric, dict):
            out["metrics"][name] = {
                "status": "source_error",
                "error": "metric entry must be an object or a point list",
                "statistic": None,
                "unit": fallback_unit,
                "points": [],
                "pointCount": 0,
            }
            errors.append(f"{name}: metric entry must be an object or a point list")
            continue

        points = []
        malformed = 0
        for point in metric.get("points") or []:
            if not isinstance(point, dict) or point.get("ts") is None or point.get("value") is None:
                malformed += 1
                continue
            try:
                timestamp = iso_to_utc_iso(point["ts"])
                value = float(point["value"])
            except (TypeError, ValueError):
                malformed += 1
                continue
            points.append({"ts": timestamp, "value": value})
        points.sort(key=lambda item: item["ts"])

        declared_metric_status = metric.get("status")
        if (declared_metric_status is not None
                and declared_metric_status not in NORMALIZED_STATUSES):
            status = "source_error"
            error = f"invalid declared status {declared_metric_status!r}"
        elif declared_metric_status is not None:
            status = declared_metric_status
            error = metric.get("error")
        elif points:
            status = "ok"
            error = None
        else:
            status = "no_data"
            error = metric.get("error") or "no datapoints"
        if malformed:
            note = f"{malformed} unusable datapoint(s)"
            error = f"{error}; {note}" if error else note
        if status != "ok":
            errors.append(f"{name}: {error or status}")
        out["metrics"][name] = {
            "status": status,
            "error": error,
            "statistic": metric.get("statistic"),
            "unit": metric.get("unit") or fallback_unit,
            "points": points,
            "pointCount": len(points),
        }

    declared_status = raw.get("status")
    if declared_status is not None:
        out["status"] = declared_status
        out["error"] = raw.get("error")
    else:
        statuses = {metric["status"] for metric in out["metrics"].values()}
        if "ok" in statuses:
            out["status"] = "ok"
        elif "source_error" in statuses:
            out["status"] = "source_error"
        else:
            out["status"] = "no_data"
        if errors:
            out["error"] = "; ".join(errors)[:600]
    return out


# --------------------------------------------------------------------------- #
# k6 summary normalisation
# --------------------------------------------------------------------------- #
def as_number(value):
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def parse_k6_tags(name):
    if "{" not in name or "}" not in name:
        return {}
    inside = name[name.index("{") + 1:name.rindex("}")]
    tags = {}
    for part in inside.split(","):
        if ":" in part:
            key, value = part.split(":", 1)
            tags[key.strip()] = value.strip()
    return tags


def normalise_k6(path):
    """Accept the compact ``c0-k6-summary/v2`` document or a raw k6 dump.

    The compact document is produced by
    ``stress-tests/tools/k6-summary.mjs``.
    """
    with open(path) as handle:
        raw = json.load(handle)
    if not isinstance(raw, dict):
        raise ValueError("k6 summary top-level value must be an object")

    is_compact = "schema" in raw or (
        "http" in raw and "http_req_duration" in raw and "metrics" not in raw
    )
    if is_compact:
        if raw.get("schema") != "c0-k6-summary/v2":
            raise ValueError("compact k6 summary schema must be c0-k6-summary/v2")
        missing = [key for key in ("runId", "step", "targetRps")
                   if raw.get(key) is None]
        if missing:
            raise ValueError(f"compact k6 summary missing provenance: {', '.join(missing)}")
        compact = raw
        return {
            "shape": "compact",
            "runId": compact.get("runId"),
            "step": compact.get("step"),
            "targetRps": compact.get("targetRps"),
            "http": {
                "requests": compact.get("http", {}).get("requests"),
                "rate": compact.get("http", {}).get("rate"),
                "failedRate": compact.get("http", {}).get("failedRate"),
                "failedCount": compact.get("http", {}).get("failedCount"),
                "droppedIterations": compact.get("http", {}).get("droppedIterations"),
                "vusMax": compact.get("http", {}).get("vusMax"),
            },
            "duration": compact.get("http_req_duration") or {},
            "operations": compact.get("ops") or {},
            "opStatuses": None,
            "thresholds": None,
        }

    if not isinstance(raw.get("metrics"), dict):
        raise ValueError("raw k6 summary must contain a metrics object")

    metrics = raw.get("metrics") or {}
    values = lambda name: (metrics.get(name) or {}).get("values") or {}
    http_reqs = values("http_reqs")
    failed = values("http_req_failed")
    duration = values("http_req_duration")
    request_count = as_number(http_reqs.get("count"))
    failed_rate = as_number(failed.get("rate"))
    failed_count = as_number(failed.get("passes"))
    if failed_count is None and None not in (request_count, failed_rate):
        failed_count = request_count * failed_rate

    operations = {}
    op_statuses = {}
    v2_counts = {}
    for name, metric in metrics.items():
        if not isinstance(metric, dict):
            continue
        tags = parse_k6_tags(name)
        vals = metric.get("values") or {}
        if "op" in tags and (
            name.startswith("http_req_duration") or name.startswith("teable_op_duration")
        ):
            operations[tags["op"]] = {
                "count": as_number(vals.get("count")),
                "p50": as_number(vals.get("p(50)")),
                "p95": as_number(vals.get("p(95)")),
                "p99": as_number(vals.get("p(99)")),
                "max": as_number(vals.get("max")),
            }
        if name.startswith("teable_op_failures") and "op" in tags:
            key = f"{tags.get('op')}|{tags.get('status', 'unknown')}"
            op_statuses[key] = as_number(vals.get("count")) or as_number(vals.get("passes"))
        if name.startswith("c0_x_teable_v2") and "value" in tags:
            v2_counts[tags["value"]] = as_number(vals.get("count")) or as_number(vals.get("passes"))

    return {
        "shape": "raw",
        "runId": raw.get("state", {}).get("testRunId") if isinstance(raw.get("state"), dict) else None,
        "step": None,
        "targetRps": None,
        "http": {
            "requests": request_count,
            "rate": as_number(http_reqs.get("rate")),
            "failedRate": failed_rate,
            "failedCount": failed_count,
            "droppedIterations": as_number(values("dropped_iterations").get("count")),
            "vusMax": as_number(values("vus_max").get("max")),
        },
        "duration": {
            "count": as_number(duration.get("count")),
            "p50": as_number(duration.get("p(50)")),
            "p90": as_number(duration.get("p(90)")),
            "p95": as_number(duration.get("p(95)")),
            "p99": as_number(duration.get("p(99)")),
            "p999": as_number(duration.get("p(99.9)")),
            "max": as_number(duration.get("max")),
        },
        "operations": operations,
        "opStatuses": op_statuses or None,
        "v2Counts": v2_counts or None,
        "thresholds": {
            name: metric.get("thresholds")
            for name, metric in metrics.items()
            if isinstance(metric, dict) and metric.get("thresholds")
        } or None,
    }


# --------------------------------------------------------------------------- #
# series helpers
# --------------------------------------------------------------------------- #

def minute_grid(start_ms, end_ms, step_seconds=60):
    grid = []
    step_ms = step_seconds * 1000
    cursor = -(-start_ms // step_ms) * step_ms  # ceil to the next step boundary
    while cursor < end_ms:
        grid.append(ms_iso(cursor))
        cursor += step_ms
    return grid


def db_rates(records):
    """Per-sample counter deltas from consecutive ok samples. Missing/reset -> None."""
    ok = sorted((r for r in records if r.get("status") == "ok"), key=lambda r: r["ts"])
    rates = {}
    previous = None
    counter_map = {
        "commits": "commitsPerSec",
        "rollbacks": "rollbacksPerSec",
        "tup_inserted": "tupInsertedPerSec",
        "tup_updated": "tupUpdatedPerSec",
        "tup_deleted": "tupDeletedPerSec",
        "blks_read": "blksReadPerSec",
        "blks_hit": "blksHitPerSec",
    }
    for record in ok:
        current = {"ts": record["ts"]}
        if previous is not None:
            elapsed = (iso_ms(record["ts"]) - iso_ms(previous["ts"])) / 1000.0
            if elapsed > 0:
                for source, target in counter_map.items():
                    if source not in record or source not in previous:
                        continue
                    delta = record[source] - previous[source]
                    if delta < 0:
                        current[target] = None
                        current["counterReset"] = True
                    else:
                        current[target] = delta / elapsed
        rates[record["ts"]] = current
        previous = record
    return rates


def load_db_samples(path):
    """Read normalized or infrastructure-envelope database sampler JSONL."""
    out = {"status": "ok", "error": None, "records": {}, "byMinute": {},
           "ratesByMinute": {}, "lineCount": 0, "okCount": 0, "errorCount": 0,
           "source": path or None, "supplied": bool(path),
           "runIds": [], "steps": [], "provenanceRows": []}
    if not path:
        out.update({"status": "no_data", "error": "no --db-samples supplied"})
        return out
    try:
        with open(path) as handle:
            lines = handle.readlines()
    except OSError as exc:
        out.update({"status": "source_error", "error": f"{type(exc).__name__}: {exc}"[:200]})
        return out
    run_ids = set()
    steps = set()
    for line in lines:
        line = line.strip()
        if not line:
            continue
        out["lineCount"] += 1
        try:
            envelope = json.loads(line)
        except json.JSONDecodeError:
            out["errorCount"] += 1
            continue
        if not isinstance(envelope, dict):
            out["errorCount"] += 1
            continue
        sample = envelope.get("sample")
        if sample is not None and not isinstance(sample, dict):
            out["errorCount"] += 1
            continue
        record = dict(sample or envelope)
        if sample is not None:
            for key in ("run_id", "runId", "step", "status", "error", "error_class", "ts"):
                if key in envelope and key not in record:
                    record[key] = envelope[key]
        run_id = (envelope.get("run_id") or envelope.get("runId")
                  or record.get("run_id") or record.get("runId"))
        step_name = envelope.get("step") or record.get("step")
        if run_id is not None:
            run_ids.add(str(run_id))
            record["runId"] = str(run_id)
        if step_name is not None:
            steps.add(str(step_name))
            record["step"] = str(step_name)
        ts = record.get("ts")
        if not ts:
            out["errorCount"] += 1
            continue
        out["provenanceRows"].append({
            "line": out["lineCount"],
            "runId": str(run_id) if run_id is not None else None,
            "step": str(step_name) if step_name is not None else None,
        })
        out["records"][ts] = record
        out["byMinute"][ts[:16] + ":00Z"] = record
        if record.get("status") == "ok":
            out["okCount"] += 1
        else:
            out["errorCount"] += 1

    out["runIds"] = sorted(run_ids)
    out["steps"] = sorted(steps)
    for ts, rate in db_rates(list(out["records"].values())).items():
        out["ratesByMinute"][ts[:16] + ":00Z"] = rate

    if not out["records"]:
        out.update({"status": "no_data", "error": "db sampler file has no usable records"})
    elif out["okCount"] == 0:
        out["status"] = "source_error"
        out["error"] = "every db sample failed"
    return out


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
THRESHOLDS = {
    "errorRatePct": 1.0,
    "p99Ms": 2000.0,
    "poolUtilPct": 80.0,
    "outboxOldestAgeMs": 300000.0,
    "rdsCpuPct": 90.0,
    "minRequestsPerMinuteForErrorRate": 10,
}


def evaluate_guardrails(args, start, end, k6, server, db, outbox, rds, db_samples):
    grid = minute_grid(start, end, args.step_interval)

    # Quantiles are grouped by implementation+operation; never merge those
    # per-minute points across groups. Guardrail values are the worst group in
    # the same minute, explicitly labelled.
    def by_group_key(series_block, *keys):
        out = {}
        for series in series_block.get("series") or []:
            labels = series.get("labels") or {}
            compound = tuple(labels.get(key) for key in keys)
            target = out.setdefault(compound, {})
            for point in series.get("points") or []:
                target[point["ts"]] = point["value"]
        return out

    p99_by_impl_op = by_group_key(server["dataApiP99"], "implementation", "operation")
    p95_by_impl_op = by_group_key(server["dataApiP95"], "implementation", "operation")
    outcomes = {}
    for series in server["dataApiOutcomes"].get("series") or []:
        labels = series.get("labels") or {}
        key = (labels.get("implementation"), labels.get("outcome"))
        bucket = outcomes.setdefault(key, {})
        for point in series.get("points") or []:
            target_ts = point["ts"]
            bucket[target_ts] = bucket.get(target_ts, 0) + point["value"]

    # Join pool gauges on their complete identity, then deliberately sum matched
    # pools for the minute-level guardrail.
    pool_by_identity_state = {}
    for series in db["poolConnections"].get("series") or []:
        labels = series.get("labels") or {}
        if labels.get("db.namespace") != args.db_namespace:
            continue
        identity = (labels.get("host.name"), labels.get("db.namespace"),
                    labels.get("teable.database.pool.name"), labels.get("state"))
        target = pool_by_identity_state.setdefault(identity, {})
        for point in series.get("points") or []:
            target[point["ts"]] = point["value"]

    pool_limit_by_identity = {}
    pool_waiting_by_identity = {}
    for source, destination in ((db["poolLimit"], pool_limit_by_identity),
                                (db["poolWaiting"], pool_waiting_by_identity)):
        for series in source.get("series") or []:
            labels = series.get("labels") or {}
            if labels.get("db.namespace") != args.db_namespace:
                continue
            identity = (labels.get("host.name"), labels.get("db.namespace"),
                        labels.get("teable.database.pool.name"))
            target = destination.setdefault(identity, {})
            for point in series.get("points") or []:
                target[point["ts"]] = point["value"]

    def points_reduce(series_block, reducer):
        if not series_block or series_block.get("status") != "ok":
            return {}
        reduced = {}
        point_groups = [series_block.get("points") or []]
        point_groups.extend(series.get("points") or []
                            for series in series_block.get("series") or [])
        for points in point_groups:
            for point in points:
                ts, value = point["ts"], point["value"]
                reduced[ts] = value if ts not in reduced else reducer(reduced[ts], value)
        return reduced

    outbox_age = points_reduce(outbox["oldestDueAgeMs"], max)
    outbox_backlog = points_reduce(outbox["backlog"], max)
    queue_reachable = points_reduce(outbox["queueReachable"], min)
    rds_cpu_block = ((rds.get("metrics") or {}).get("CPUUtilization")
                     if rds.get("status") == "ok" else None)
    rds_cpu = points_reduce(rds_cpu_block, max)
    acquire_timeouts = points_reduce(db.get("acquireTimeouts"), sum)

    observations = []
    breach_list = []
    missing_counter = {
        "p99Ms": 0,
        "errorRatePct": 0,
        "poolUtilPct": 0,
        "outboxOldestAgeMs": 0,
        "rdsCpuPct": 0,
    }

    for ts in grid:

        p99_values = {}
        p99_group = None
        p99 = None
        for (impl, op), series in p99_by_impl_op.items():
            value = series.get(ts)
            if value is None:
                continue
            if impl is not None and (impl not in p99_values or value > p99_values[impl]):
                p99_values[impl] = value
            if p99 is None or value > p99:
                p99 = value
                p99_group = {"implementation": impl, "operation": op}

        p95_values = {}
        p95 = None
        for (impl, op), series in p95_by_impl_op.items():
            value = series.get(ts)
            if value is None:
                continue
            if impl is not None and (impl not in p95_values or value > p95_values[impl]):
                p95_values[impl] = value
            if p95 is None or value > p95:
                p95 = value

        outcome_at = {}
        for (impl, outcome), series in outcomes.items():
            if series.get(ts) is not None:
                outcome_at[(impl, outcome)] = series[ts]
        availability_failure_outcomes = {"server_error", "throttled", "aborted", "unexpected"}
        client_error = sum(v for (_, outcome), v in outcome_at.items()
                           if outcome == "client_error")
        availability_failures = sum(v for (_, outcome), v in outcome_at.items()
                                    if outcome in availability_failure_outcomes)
        total = sum(outcome_at.values())
        has_outcomes = bool(outcome_at)
        error_rate = (100.0 * availability_failures / total) if total > 0 else None
        server_error_rate = error_rate

        conn_total = 0.0
        limit_total = 0.0
        conn_present = 0
        limit_present = 0
        for (host, namespace, pool_name, state), series in pool_by_identity_state.items():
            if state != "total":
                continue
            identity = (host, namespace, pool_name)
            conn_value = series.get(ts)
            limit_value = (pool_limit_by_identity.get(identity) or {}).get(ts)
            if conn_value is None or limit_value is None:
                continue
            conn_total += conn_value
            limit_total += limit_value
            conn_present += 1
            limit_present += 1
        waiting_total = 0.0
        waiting_present = 0
        for identity, series in pool_waiting_by_identity.items():
            value = series.get(ts)
            if value is None:
                continue
            waiting_total += value
            waiting_present += 1

        pool_util = None
        if conn_present and limit_present and limit_total > 0:
            pool_util = 100.0 * conn_total / limit_total

        age = outbox_age.get(ts)
        backlog = outbox_backlog.get(ts)
        reachable = queue_reachable.get(ts)
        cpu = rds_cpu.get(ts)
        timeout_rate = acquire_timeouts.get(ts)

        db_record = db_samples.get("byMinute", {}).get(ts) if db_samples else None
        db_values = None
        if db_record:
            if db_record.get("status") == "ok":
                db_values = {
                    key: db_record.get(key)
                    for key in ("conns", "active", "idle", "idle_tx", "lock_waiters",
                                "waiting", "commits", "rollbacks", "blks_read", "blks_hit",
                                "tup_inserted", "tup_updated", "tup_deleted", "deadlocks",
                                "db_size_bytes", "max_conn", "wait_events")
                    if key in db_record
                }
                rate = db_samples.get("ratesByMinute", {}).get(ts) or {}
                for key in ("commitsPerSec", "rollbacksPerSec", "tupInsertedPerSec",
                            "tupUpdatedPerSec", "tupDeletedPerSec", "blksReadPerSec",
                            "blksHitPerSec", "counterReset"):
                    if key in rate:
                        db_values[key] = rate[key]
                db_values["status"] = "ok"
            else:
                db_values = {
                    "status": "error",
                    "errorClass": db_record.get("error_class", "sample_failed"),
                }

        for name, value in (("p99Ms", p99), ("errorRatePct", error_rate),
                            ("poolUtilPct", pool_util), ("outboxOldestAgeMs", age),
                            ("rdsCpuPct", cpu)):
            if value is None:
                missing_counter[name] += 1

        breaches = []
        sample_count = total * 60 if has_outcomes else 0
        error_rate_evaluable = (
            error_rate is not None
            and sample_count >= THRESHOLDS["minRequestsPerMinuteForErrorRate"]
        )
        if error_rate_evaluable and error_rate > THRESHOLDS["errorRatePct"]:
            breaches.append({"rule": "errorRatePct", "value": round(error_rate, 3),
                             "threshold": THRESHOLDS["errorRatePct"],
                             "samples": round(sample_count)})
        if p99 is not None and p99 > THRESHOLDS["p99Ms"]:
            breaches.append({"rule": "p99Ms", "value": round(p99, 1),
                             "threshold": THRESHOLDS["p99Ms"],
                             "worstGroup": p99_group})
        if pool_util is not None and pool_util > THRESHOLDS["poolUtilPct"]:
            breaches.append({"rule": "poolUtilPct", "value": round(pool_util, 1),
                             "threshold": THRESHOLDS["poolUtilPct"]})
        if age is not None and age > THRESHOLDS["outboxOldestAgeMs"]:
            breaches.append({"rule": "outboxOldestAgeMs", "value": round(age, 1),
                             "threshold": THRESHOLDS["outboxOldestAgeMs"]})
        if cpu is not None and cpu > THRESHOLDS["rdsCpuPct"]:
            breaches.append({"rule": "rdsCpuPct", "value": round(cpu, 2),
                             "threshold": THRESHOLDS["rdsCpuPct"]})
        if reachable is not None and reachable < 1:
            breaches.append({"rule": "queueReachable", "value": reachable,
                             "threshold": 1})
        if timeout_rate is not None and timeout_rate > 0:
            breaches.append({"rule": "acquireTimeouts", "value": round(timeout_rate, 3),
                             "threshold": 0})

        for breach in breaches:
            breach_list.append({"ts": ts, **breach})

        observations.append({
            "ts": ts,
            "p99Ms": round(p99, 1) if p99 is not None else None,
            "p99WorstGroup": p99_group,
            "p99ByImplementation": {k: round(v, 1) for k, v in p99_values.items()},
            "p95Ms": round(p95, 1) if p95 is not None else None,
            "requestRate": round(total, 3) if has_outcomes else None,
            "errorRatePct": round(error_rate, 3) if error_rate is not None else None,
            "serverErrorRatePct": round(server_error_rate, 3) if server_error_rate is not None else None,
            "errorRateSampleCount": round(sample_count) if has_outcomes else None,
            "clientErrorRatePct": round(100.0 * client_error / total, 3) if total > 0 else None,
            "acquireTimeoutsPerSec": round(timeout_rate, 3) if timeout_rate is not None else None,
            "poolConnections": round(conn_total, 1) if conn_present else None,
            "poolLimit": round(limit_total, 1) if limit_present else None,
            "poolUtilPct": round(pool_util, 2) if pool_util is not None else None,
            "poolWaiting": round(waiting_total, 1) if waiting_present else None,
            "outboxOldestAgeMs": round(age, 1) if age is not None else None,
            "outboxBacklog": backlog,
            "queueReachable": reachable,
            "rdsCpuPct": round(cpu, 2) if cpu is not None else None,
            "db": db_values,
            "breaches": breaches,
        })

    required = ["errorRatePct", "p99Ms", "poolUtilPct", "outboxOldestAgeMs"]
    complete_minutes = sum(
        1 for obs in observations
        if all(obs.get(name) is not None for name in required)
    )
    coverage = (complete_minutes / len(observations)) if observations else 0.0
    if breach_list:
        verdict = "breach"
    elif coverage >= 0.9:
        verdict = "pass"
    else:
        verdict = "insufficient_data"

    k6_window = {
        "source": "k6_summary",
        "scope": "whole_window",
        "note": "whole-window values from the k6 summary; not a per-minute guardrail signal",
        "requests": k6["http"].get("requests"),
        "failedRate": k6["http"].get("failedRate"),
        "failedCount": k6["http"].get("failedCount"),
        "droppedIterations": k6["http"].get("droppedIterations"),
        "p95Ms": k6["duration"].get("p95"),
        "p99Ms": k6["duration"].get("p99"),
    }
    k6_breaches = []
    if k6["http"].get("failedRate") is not None and k6["http"]["failedRate"] > 0.01:
        k6_breaches.append({"rule": "k6FailedRate", "value": k6["http"]["failedRate"],
                            "threshold": 0.01})
    if k6["duration"].get("p99") is not None and k6["duration"]["p99"] > THRESHOLDS["p99Ms"]:
        k6_breaches.append({"rule": "k6P99Ms", "value": k6["duration"]["p99"],
                            "threshold": THRESHOLDS["p99Ms"]})
    dropped = k6["http"].get("droppedIterations")
    requests = k6["http"].get("requests")
    if dropped is not None and requests is not None and dropped > max(10, 0.01 * requests):
        k6_breaches.append({"rule": "k6DroppedIterations", "value": dropped,
                            "threshold": max(10, 0.01 * requests)})

    return {
        "thresholds": THRESHOLDS,
        "evaluatedFrom": "per-minute SigNoz/RDS/db-sampler series",
        "quantileSemantics": (
            "p95/p99 are per-minute histogram quantiles; guardrail values are the "
            "worst implementation+operation in that minute, never a window average"
        ),
        "perMinute": observations,
        "minuteCount": len(observations),
        "completeMinuteCount": complete_minutes,
        "coveragePct": round(coverage * 100, 2),
        "missingMinuteCounts": missing_counter,
        "breaches": breach_list,
        "firstBreachTs": breach_list[0]["ts"] if breach_list else None,
        "verdict": verdict,
        "windowScope": {"k6": k6_window, "breaches": k6_breaches},
    }


def validate_provenance(run_id, step, target, k6, rds, db_samples):
    """Reject cross-run artifacts before any telemetry query or join."""
    mismatches = []

    def match(source, field, observed, expected, numeric=False):
        if observed is None:
            return
        try:
            equal = (float(observed) == float(expected) if numeric
                     else str(observed) == str(expected))
        except (TypeError, ValueError):
            equal = False
        if not equal:
            mismatches.append(f"{source}.{field}={observed!r}, expected {expected!r}")

    match("k6", "runId", k6.get("runId"), run_id)
    match("k6", "step", k6.get("step"), step)
    match("k6", "targetRps", k6.get("targetRps"), target, numeric=True)
    if rds.get("supplied") and rds.get("metrics"):
        if rds.get("runId") is None:
            mismatches.append("rds.runId is required for a supplied metrics artifact")
        if rds.get("step") is None:
            mismatches.append("rds.step is required for a supplied metrics artifact")
    match("rds", "runId", rds.get("runId"), run_id)
    match("rds", "step", rds.get("step"), step)
    provenance_rows = db_samples.get("provenanceRows") or []
    if db_samples.get("supplied") and db_samples.get("records"):
        if not provenance_rows:
            mismatches.append("dbSamples provenance is required for every usable row")
        for row in provenance_rows:
            if row.get("runId") is None:
                mismatches.append(f"dbSamples line {row['line']}: runId is required")
            if row.get("step") is None:
                mismatches.append(f"dbSamples line {row['line']}: step is required")
    for row in provenance_rows:
        match(f"dbSamples line {row['line']}", "runId", row.get("runId"), run_id)
        match(f"dbSamples line {row['line']}", "step", row.get("step"), step)
    if not provenance_rows:
        for observed in db_samples.get("runIds") or []:
            match("dbSamples", "runId", observed, run_id)
        for observed in db_samples.get("steps") or []:
            match("dbSamples", "step", observed, step)
    if mismatches:
        raise ValueError("provenance mismatch: " + "; ".join(mismatches))


def required_setting(parser, value, env_name, flag):
    resolved = (value or os.environ.get(env_name, "")).strip()
    if not resolved:
        parser.error(f"{flag} or {env_name} is required")
    return resolved


def main():
    global SERVICE_NAME, SIGNOZ_KEY, SIGNOZ_URL
    ap = argparse.ArgumentParser()
    ap.add_argument("--k6", required=True)
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--step", required=True)
    ap.add_argument("--target", type=float, required=True)
    ap.add_argument("--start", required=True)
    ap.add_argument("--end", required=True)
    ap.add_argument("--signoz-url", default="")
    ap.add_argument("--signoz-service", default="")
    ap.add_argument("--db-namespace", default="")
    ap.add_argument("--rds-metrics", default="")
    ap.add_argument("--db-samples", default="")
    ap.add_argument("--step-interval", type=int, default=60)
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    start = iso_ms(args.start)
    end = iso_ms(args.end)
    if end <= start:
        ap.error("--end must be after --start")
    try:
        k6 = normalise_k6(args.k6)
        rds = load_rds_metrics(args.rds_metrics)
        db_samples = load_db_samples(args.db_samples)
        validate_provenance(args.run_id, args.step, args.target, k6, rds, db_samples)
    except (OSError, json.JSONDecodeError, TypeError, ValueError) as exc:
        ap.error(str(exc))
    SIGNOZ_KEY = os.environ.get("SIGNOZ_API_KEY", "").strip()
    SIGNOZ_URL = required_setting(ap, args.signoz_url, "SIGNOZ_URL",
                                  "--signoz-url").rstrip("/")
    SERVICE_NAME = required_setting(ap, args.signoz_service, "SIGNOZ_SERVICE_NAME",
                                    "--signoz-service")
    args.db_namespace = required_setting(ap, args.db_namespace,
                                         "SIGNOZ_DB_NAMESPACE", "--db-namespace")
    ns = args.db_namespace
    step = args.step_interval
    if step != 60:
        ap.error("--step-interval must be 60: guardrail joins are per minute")
    start_iso, end_iso = ms_iso(start), ms_iso(end)

    # --- metric definitions -------------------------------------------------
    group_pool_full = ["host.name", "db.namespace", "teable.database.pool.name", "state"]
    group_pool_gauges = ["host.name", "db.namespace", "teable.database.pool.name"]

    server_specs = {
        "dataApiP95": ("teable.data_api.request.duration.bucket", "p95",
                       ["implementation", "operation"], "ms", "per_minute"),
        "dataApiP99": ("teable.data_api.request.duration.bucket", "p99",
                       ["implementation", "operation"], "ms", "per_minute"),
        "dataApiRate": ("teable.data_api.request.duration.count", "count",
                        ["implementation"], "requests/s", "per_minute"),
        "dataApiOutcomes": ("teable.data_api.request.completed", "count",
                            ["implementation", "operation", "outcome"], "requests/s",
                            "per_minute"),
        "requestActive": ("teable.data_api.request.active", "max",
                          ["operation"], "requests", "per_minute"),
        "startedRate": ("teable.data_api.request.started", "count",
                        ["implementation", "operation"], "requests/s", "per_minute"),
    }
    db_specs = {
        "poolConnections": ("teable.database.client.pool.connections", "max",
                            group_pool_full, "connections", "per_minute"),
        "poolWaiting": ("teable.database.client.pool.waiting", "max",
                        group_pool_gauges, "requests", "per_minute"),
        "poolLimit": ("teable.database.client.pool.limit", "max",
                      group_pool_gauges, "connections", "per_minute"),
        "poolReferences": ("teable.database.client.pool.references", "max",
                           group_pool_gauges, "clients", "per_minute"),
        "acquireP95": ("teable.database.client.pool.acquire.duration.bucket", "p95",
                       ["teable.database.role", "teable.database.pool.name",
                        "teable.database.instance.id"], "ms", "per_minute"),
        "acquireTimeouts": ("teable.database.client.pool.acquire.timeouts", "count",
                            ["teable.database.role", "teable.database.instance.id"],
                            "timeouts/s", "per_minute"),
        "operationP95": ("teable.database.client.operation.duration.bucket", "p95",
                         ["teable.database.role", "db.operation.name"], "ms",
                         "per_minute"),
        "operationsRate": ("teable.database.client.operations", "count",
                           ["teable.database.role", "db.operation.name", "outcome"],
                           "ops/s", "per_minute"),
        "connectionFailures": ("teable.database.client.connection.failures", "count",
                               ["teable.database.role", "teable.database.instance.id",
                                "teable.database.failure.phase",
                                "teable.database.error.class"], "failures/s",
                               "per_minute"),
    }
    outbox_specs = {
        "oldestDueAgeMs": ("v2.computed.outbox.oldest_due.age", "max",
                           ["storage"], "ms", "per_minute"),
        "backlog": ("v2.computed.outbox.backlog", "max", ["storage"], "tasks",
                    "per_minute"),
        "queueJobs": ("v2.computed.outbox.queue.jobs", "max",
                      ["provider", "state"], "jobs", "per_minute"),
        "queueReachable": ("v2.computed.outbox.queue.reachable", "max", [], "boolean",
                           "per_minute"),
    }

    def run_specs(specs):
        def one(item):
            name, (metric, agg, groups, unit, role) = item
            return name, signoz_query(
                metric, agg, groups, start=start, end=end, step=step, unit=unit,
                value_role=role, signoz_url=SIGNOZ_URL, signoz_key=SIGNOZ_KEY,
                service_name=SERVICE_NAME,
            )

        with ThreadPoolExecutor(max_workers=6) as pool:
            return dict(pool.map(one, specs.items()))

    server = run_specs(server_specs)
    db = run_specs(db_specs)
    outbox = run_specs(outbox_specs)


    guardrails = evaluate_guardrails(args, start, end, k6, server, db, outbox, rds,
                                     db_samples)

    sources = {
        "signoz": {
            "url": SIGNOZ_URL,
            "serviceName": SERVICE_NAME,
            "dbNamespace": ns,
            "status": "ok",
            "errors": [],
        },
        "rds": {"status": rds.get("status"), "error": rds.get("error"),
                "source": rds.get("source"),
                "instance": rds.get("instance"),
                "instanceStatus": rds.get("instanceStatus"),
                "region": rds.get("region"),
                "runId": rds.get("runId"),
                "step": rds.get("step")},
        "dbSamples": {"status": db_samples.get("status"),
                      "error": db_samples.get("error"),
                      "lineCount": db_samples.get("lineCount"),
                      "okCount": db_samples.get("okCount"),
                      "errorCount": db_samples.get("errorCount")},
    }
    for section_name, section in (("server", server), ("db", db), ("outbox", outbox)):
        for key, value in section.items():
            if value.get("status") == "source_error":
                sources["signoz"]["errors"].append(f"{section_name}.{key}: {value.get('error')}")
    if sources["signoz"]["errors"]:
        sources["signoz"]["status"] = "source_error"

    result = {
        "runId": args.run_id,
        "schemaVersion": 2,
        "step": args.step,
        "targetRps": args.target,
        "windowStart": start_iso,
        "windowEnd": end_iso,
        "stepIntervalSeconds": step,
        "scope": {
            "serviceName": SERVICE_NAME,
            "dbNamespace": ns,
            "rdsInstance": rds.get("instance"),
        },
        "k6": k6,
        "server": server,
        "db": db,
        "outbox": outbox,
        "rds": rds,
        "sources": sources,
        "guardrails": guardrails,
    }

    text = json.dumps(result, indent=2)
    if args.out:
        with open(args.out, "w") as handle:
            handle.write(text)
    print(text)


if __name__ == "__main__":
    sys.exit(main())
