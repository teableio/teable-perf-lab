import type { RunnerInventory, RunnerOperation } from "./runner-registry";
import { runFormulaTableCase } from "./runners/formula-table.runner";
import type { PerfCaseFor, PerfRunContext } from "./types";

declare const httpSeedOperation: RunnerOperation<"http-endpoint">;
declare const httpCase: PerfCaseFor<"http-endpoint">;
declare const context: PerfRunContext;

// The real formula operation cannot be installed in the http-endpoint slot. The
// expected-error directive is itself checked by pnpm check:types: if the
// inventory ever loses runner/config correlation, TypeScript reports it unused.
const invalidInventory = {
  "http-endpoint": {
    implementation: { mode: "direct" },
    // @ts-expect-error formula execute cannot satisfy http execute wiring
    execute: runFormulaTableCase,
    seed: httpSeedOperation,
  },
} satisfies Pick<RunnerInventory, "http-endpoint">;

// The operation interface carries the same correlation through dispatch, so a
// case with the http config cannot cross the formula runner seam.
// @ts-expect-error http-endpoint config cannot be sent to formula-table
runFormulaTableCase(httpCase, context);

void invalidInventory;
