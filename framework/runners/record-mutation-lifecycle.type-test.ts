import type { RecordMutationLifecycleSpec } from "./record-mutation-lifecycle";

type LifecycleSpec<TConfig extends object> = RecordMutationLifecycleSpec<
  TConfig,
  object,
  void,
  void
>;

const commonSpec = {
  prepareFixture: async () => ({}),
  runMeasuredOperation: async () => ({
    name: "primary",
    durationMs: 0,
    result: undefined,
  }),
  buildResult: () => ({ metrics: {}, thresholds: [] }),
  cleanup: async () => {},
};

// Existing configs keep the conventional, resolver-free interface.
const conventionalSpec: LifecycleSpec<{ tableNamePrefix: string }> = commonSpec;

// A config with domain-specific naming has to declare the adapter explicitly.
const resolvedSpec: LifecycleSpec<{ sourceTableNamePrefix: string }> = {
  ...commonSpec,
  resolveTableNamePrefix: (config) => config.sourceTableNamePrefix,
};

// The expected-error directive is checked by pnpm check:types. If the lifecycle
// ever permits neither a conventional prefix nor a resolver, it becomes unused.
// @ts-expect-error config without tableNamePrefix requires a resolver
const missingResolverSpec: LifecycleSpec<{ sourceTableNamePrefix: string }> =
  commonSpec;

void conventionalSpec;
void resolvedSpec;
void missingResolverSpec;
