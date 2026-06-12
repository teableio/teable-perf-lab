import type { PerfRunContext } from "./types";

export type RoutingHeaders = {
  "x-teable-v2"?: string;
  "x-teable-v2-feature"?: string;
  "x-teable-v2-reason"?: string;
};

export type EngineRouting = {
  requestedEngine: string;
  expectedXTeableV2?: string;
  actualXTeableV2: string;
  expectedV2Header?: string;
  actualV2Header: string;
  routeMatched: boolean;
  engineMatched: boolean;
  featureMatched: boolean;
  expectedFeature?: string;
  feature: string;
  reason: string;
  xTeableV2Feature: string;
  xTeableV2Reason: string;
};

export type StreamEngineRouting = {
  requestedEngine: string;
  expectedEngine?: string;
  actualEngine: string;
  routeMatched: boolean;
  engineMatched: boolean;
};

const expectedV2HeaderForEngine = (engine: string) =>
  engine === "v2" ? "true" : engine === "v1" ? "false" : undefined;

export const getRoutingResponseHeader = (
  headers: Record<string, unknown>,
  name: string,
) => {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0]) : String(value ?? "");
};

export const pickRoutingResponseHeaders = (
  headers: Record<string, unknown>,
) => ({
  "x-teable-v2": getRoutingResponseHeader(headers, "x-teable-v2"),
  "x-teable-v2-feature": getRoutingResponseHeader(
    headers,
    "x-teable-v2-feature",
  ),
  "x-teable-v2-reason": getRoutingResponseHeader(headers, "x-teable-v2-reason"),
  traceparent: getRoutingResponseHeader(headers, "traceparent"),
});

export const assertEngineRouting = (
  context: Pick<PerfRunContext, "engine">,
  responseHeaders: RoutingHeaders,
  options: {
    feature?: string;
    operation: string;
  },
): EngineRouting => {
  const requestedEngine = context.engine || "local";
  const expectedXTeableV2 = expectedV2HeaderForEngine(requestedEngine);
  const actualXTeableV2 = responseHeaders["x-teable-v2"] ?? "";
  const feature = responseHeaders["x-teable-v2-feature"] ?? "";
  const reason = responseHeaders["x-teable-v2-reason"] ?? "";
  const engineMatched =
    expectedXTeableV2 == null || actualXTeableV2 === expectedXTeableV2;
  const featureMatched = options.feature ? feature === options.feature : true;
  const routeMatched = engineMatched && featureMatched;

  if (expectedXTeableV2 != null && !engineMatched) {
    throw new Error(
      `${options.operation} did not use expected ${requestedEngine.toUpperCase()} route; expected x-teable-v2=${expectedXTeableV2}, got ${actualXTeableV2}; headers=${JSON.stringify(
        responseHeaders,
      )}`,
    );
  }

  return {
    requestedEngine,
    expectedXTeableV2,
    actualXTeableV2,
    expectedV2Header: expectedXTeableV2,
    actualV2Header: actualXTeableV2,
    routeMatched,
    engineMatched,
    featureMatched,
    expectedFeature: options.feature,
    feature,
    reason,
    xTeableV2Feature: feature,
    xTeableV2Reason: reason,
  };
};

export const assertStreamEngineRouting = (
  context: Pick<PerfRunContext, "engine">,
  actualEngine: string | undefined,
  options: {
    operation: string;
  },
): StreamEngineRouting => {
  const requestedEngine = context.engine || "local";
  const expectedEngine =
    requestedEngine === "v1" || requestedEngine === "v2"
      ? requestedEngine
      : undefined;
  const actual = String(actualEngine ?? "");
  const engineMatched = expectedEngine == null || actual === expectedEngine;

  if (expectedEngine != null && !engineMatched) {
    throw new Error(
      `${options.operation} did not use expected ${requestedEngine.toUpperCase()} route; expected engine=${expectedEngine}, got ${actual}`,
    );
  }

  return {
    requestedEngine,
    expectedEngine,
    actualEngine: actual,
    routeMatched: engineMatched,
    engineMatched,
  };
};
