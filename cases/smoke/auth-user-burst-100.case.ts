import { USER_ME } from "@teable/openapi";
import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "smoke/auth-user-burst-100",
  title: "Authenticated user profile endpoint over 100 sequential samples",
  runner: "http-endpoint",
  routingEvidence: "not-applicable",
  timeoutMs: 180_000,
  config: {
    method: "GET",
    path: USER_ME,
    samples: 100,
    threshold: { metric: "p95Ms", maxMs: 2_000 },
    validateSeedUser: true,
  },
});
