import { performance } from "node:perf_hooks";
import pg from "pg";

const { Client } = pg;

type SnapshotRow = {
  seed_table_id: string;
  total: string | number;
  pending: string | number;
  processing: string | number;
  dead: string | number;
  max_attempts: string | number | null;
  max_estimated_complexity: string | number | null;
  oldest_task_age_ms: string | number | null;
  task_ids: string[] | null;
  change_types: string[] | null;
};

export type ComputedOutboxTableSnapshot = {
  total: number;
  pending: number;
  processing: number;
  dead: number;
  maxAttempts: number;
  maxEstimatedComplexity: number;
  oldestTaskAgeMs: number;
  taskIds: string[];
  changeTypes: string[];
};

export type ComputedOutboxSnapshot = {
  elapsedMs: number;
  total: number;
  pending: number;
  processing: number;
  dead: number;
  byTable: Record<string, ComputedOutboxTableSnapshot>;
};

export type ComputedOutboxTableSummary = {
  uniqueTaskCount: number;
  observedCompletedTaskCount: number;
  firstSeenMs?: number;
  lastSeenMs?: number;
  peakTotal: number;
  peakPending: number;
  peakProcessing: number;
  peakDead: number;
  maxAttempts: number;
  maxEstimatedComplexity: number;
  maxOldestTaskAgeMs: number;
  changeTypes: string[];
};

export type ComputedOutboxObserverSummary = {
  pollIntervalMs: number;
  sampleCount: number;
  sawTask: boolean;
  uniqueTaskCount: number;
  observedCompletedTaskCount: number;
  firstSeenMs?: number;
  lastSeenMs?: number;
  peakTotal: number;
  peakPending: number;
  peakProcessing: number;
  peakDead: number;
  overlapObserved: boolean;
  byTable: Record<string, ComputedOutboxTableSummary>;
  final: ComputedOutboxSnapshot;
};

const numberValue = (value: string | number | null | undefined) =>
  value == null ? 0 : Number(value);

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const emptyTableSnapshot = (): ComputedOutboxTableSnapshot => ({
  total: 0,
  pending: 0,
  processing: 0,
  dead: 0,
  maxAttempts: 0,
  maxEstimatedComplexity: 0,
  oldestTaskAgeMs: 0,
  taskIds: [],
  changeTypes: [],
});

export class ComputedOutboxObserver {
  private readonly client: InstanceType<typeof Client>;
  private readonly samples: ComputedOutboxSnapshot[] = [];
  private startedAt?: Date;
  private startedAtPerformance = 0;
  private running = false;
  private loopPromise?: Promise<void>;
  private loopError?: unknown;

  constructor(
    private readonly input: {
      baseId: string;
      seedTableIds: string[];
      pollIntervalMs: number;
    },
  ) {
    if (input.seedTableIds.length === 0) {
      throw new Error("Computed Outbox observer requires at least one table");
    }
    const databaseUrl = process.env.PRISMA_DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("PRISMA_DATABASE_URL is not set");
    }
    this.client = new Client({ connectionString: databaseUrl });
  }

  async start() {
    try {
      await this.client.connect();
      const baseline = await this.querySnapshot(false);
      if (baseline.total > 0 || baseline.dead > 0) {
        throw new Error(
          `Computed Outbox observer requires a clean table scope: tables=${this.input.seedTableIds.join(",")}, total=${baseline.total}, dead=${baseline.dead}`,
        );
      }

      this.startedAt = new Date();
      this.startedAtPerformance = performance.now();
      this.running = true;
      await this.sampleNow();
      this.loopPromise = this.runLoop().catch((error) => {
        this.loopError = error;
        this.running = false;
      });
    } catch (error) {
      this.running = false;
      await this.client.end().catch(() => undefined);
      throw error;
    }
  }

  async sampleNow(): Promise<ComputedOutboxSnapshot> {
    if (!this.startedAt) {
      throw new Error("Computed Outbox observer has not started");
    }
    const snapshot = await this.querySnapshot(true);
    this.samples.push(snapshot);
    return snapshot;
  }

  async stop(): Promise<ComputedOutboxObserverSummary> {
    this.running = false;
    try {
      await this.loopPromise;
      if (this.loopError) {
        throw this.loopError;
      }
      await this.sampleNow();
      return this.summary();
    } finally {
      await this.client.end();
    }
  }

  private async runLoop() {
    const pollIntervalMs = Math.max(1, this.input.pollIntervalMs);
    while (this.running) {
      await wait(pollIntervalMs);
      if (!this.running) break;
      await this.sampleNow();
    }
  }

  private async querySnapshot(
    scopeToObservation: boolean,
  ): Promise<ComputedOutboxSnapshot> {
    const scopedTime = scopeToObservation ? this.startedAt : undefined;
    const result = await this.client.query<SnapshotRow>(
      `
        SELECT
          scope.seed_table_id,
          COUNT(o.id)::int AS total,
          COUNT(o.id) FILTER (WHERE o.status = 'pending')::int AS pending,
          COUNT(o.id) FILTER (WHERE o.status = 'processing')::int AS processing,
          COALESCE(dead.count, 0)::int AS dead,
          MAX(o.attempts)::int AS max_attempts,
          MAX(o.estimated_complexity)::int AS max_estimated_complexity,
          COALESCE(
            GREATEST(
              EXTRACT(EPOCH FROM (clock_timestamp() - MIN(o.created_at))) * 1000,
              0
            ),
            0
          ) AS oldest_task_age_ms,
          COALESCE(
            ARRAY_AGG(DISTINCT o.id::text) FILTER (WHERE o.id IS NOT NULL),
            ARRAY[]::text[]
          ) AS task_ids,
          COALESCE(
            ARRAY_AGG(DISTINCT o.change_type) FILTER (WHERE o.change_type IS NOT NULL),
            ARRAY[]::text[]
          ) AS change_types
        FROM UNNEST($2::text[]) AS scope(seed_table_id)
        LEFT JOIN computed_update_outbox o
          ON o.base_id = $1
          AND o.seed_table_id = scope.seed_table_id
          AND ($3::timestamptz IS NULL OR o.created_at >= $3)
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS count
          FROM computed_update_dead_letter d
          WHERE d.base_id = $1
            AND d.seed_table_id = scope.seed_table_id
            AND ($3::timestamptz IS NULL OR d.created_at >= $3)
        ) dead ON TRUE
        GROUP BY scope.seed_table_id, dead.count
        ORDER BY scope.seed_table_id
      `,
      [this.input.baseId, this.input.seedTableIds, scopedTime ?? null],
    );
    const byTable = Object.fromEntries(
      this.input.seedTableIds.map((tableId) => [tableId, emptyTableSnapshot()]),
    );
    for (const row of result.rows) {
      byTable[row.seed_table_id] = {
        total: numberValue(row.total),
        pending: numberValue(row.pending),
        processing: numberValue(row.processing),
        dead: numberValue(row.dead),
        maxAttempts: numberValue(row.max_attempts),
        maxEstimatedComplexity: numberValue(row.max_estimated_complexity),
        oldestTaskAgeMs: numberValue(row.oldest_task_age_ms),
        taskIds: row.task_ids ?? [],
        changeTypes: row.change_types ?? [],
      };
    }
    const tableSnapshots = Object.values(byTable);
    return {
      elapsedMs: Math.max(0, performance.now() - this.startedAtPerformance),
      total: tableSnapshots.reduce((sum, snapshot) => sum + snapshot.total, 0),
      pending: tableSnapshots.reduce(
        (sum, snapshot) => sum + snapshot.pending,
        0,
      ),
      processing: tableSnapshots.reduce(
        (sum, snapshot) => sum + snapshot.processing,
        0,
      ),
      dead: tableSnapshots.reduce((sum, snapshot) => sum + snapshot.dead, 0),
      byTable,
    };
  }

  private summary(): ComputedOutboxObserverSummary {
    const final = this.samples.at(-1);
    if (!final) {
      throw new Error("Computed Outbox observer collected no samples");
    }
    const buildTableSummary = (tableId: string): ComputedOutboxTableSummary => {
      const snapshots = this.samples.map(
        (sample) => sample.byTable[tableId] ?? emptyTableSnapshot(),
      );
      const taskSamples = snapshots
        .map((snapshot, index) => ({
          snapshot,
          elapsedMs: this.samples[index].elapsedMs,
        }))
        .filter(({ snapshot }) => snapshot.total > 0);
      const taskIds = new Set(
        snapshots.flatMap((snapshot) => snapshot.taskIds),
      );
      const finalIds = new Set(final.byTable[tableId]?.taskIds ?? []);
      const changeTypes = new Set(
        snapshots.flatMap((snapshot) => snapshot.changeTypes),
      );
      return {
        uniqueTaskCount: taskIds.size,
        observedCompletedTaskCount: [...taskIds].filter(
          (taskId) => !finalIds.has(taskId),
        ).length,
        firstSeenMs: taskSamples[0]?.elapsedMs,
        lastSeenMs: taskSamples.at(-1)?.elapsedMs,
        peakTotal: Math.max(...snapshots.map((snapshot) => snapshot.total)),
        peakPending: Math.max(...snapshots.map((snapshot) => snapshot.pending)),
        peakProcessing: Math.max(
          ...snapshots.map((snapshot) => snapshot.processing),
        ),
        peakDead: Math.max(...snapshots.map((snapshot) => snapshot.dead)),
        maxAttempts: Math.max(
          ...snapshots.map((snapshot) => snapshot.maxAttempts),
        ),
        maxEstimatedComplexity: Math.max(
          ...snapshots.map((snapshot) => snapshot.maxEstimatedComplexity),
        ),
        maxOldestTaskAgeMs: Math.max(
          ...snapshots.map((snapshot) => snapshot.oldestTaskAgeMs),
        ),
        changeTypes: [...changeTypes].sort(),
      };
    };
    const byTable = Object.fromEntries(
      this.input.seedTableIds.map((tableId) => [
        tableId,
        buildTableSummary(tableId),
      ]),
    );
    const taskSamples = this.samples.filter((sample) => sample.total > 0);
    const uniqueTaskCount = Object.values(byTable).reduce(
      (sum, table) => sum + table.uniqueTaskCount,
      0,
    );
    return {
      pollIntervalMs: this.input.pollIntervalMs,
      sampleCount: this.samples.length,
      sawTask: taskSamples.length > 0,
      uniqueTaskCount,
      observedCompletedTaskCount: Object.values(byTable).reduce(
        (sum, table) => sum + table.observedCompletedTaskCount,
        0,
      ),
      firstSeenMs: taskSamples[0]?.elapsedMs,
      lastSeenMs: taskSamples.at(-1)?.elapsedMs,
      peakTotal: Math.max(...this.samples.map((sample) => sample.total)),
      peakPending: Math.max(...this.samples.map((sample) => sample.pending)),
      peakProcessing: Math.max(
        ...this.samples.map((sample) => sample.processing),
      ),
      peakDead: Math.max(...this.samples.map((sample) => sample.dead)),
      overlapObserved: this.samples.some(
        (sample) =>
          Object.values(sample.byTable).filter((table) => table.total > 0)
            .length > 1,
      ),
      byTable,
      final,
    };
  }
}
