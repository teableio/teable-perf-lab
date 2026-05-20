import { USER_ME } from "@teable/openapi";
import { definePerfCase } from "../framework/types";

export default definePerfCase({
  id: "smoke/auth-user",
  title: "Authenticated user profile endpoint",
  runner: "http-endpoint",
  timeoutMs: 60_000,
  config: {
    method: "GET",
    path: USER_ME,
    samples: 10,
    threshold: {
      metric: "p95Ms",
      maxMs: 2_000,
    },
    validateSeedUser: true,
  },
});
