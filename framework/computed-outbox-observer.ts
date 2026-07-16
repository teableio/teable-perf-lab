import { performance } from "node:perf_hooks";
import pg from "pg";

const { Client } = pg;

type ComputedOutboxSnapshotRow = {
  total: string | number;
  pending: string | number;
  processing: string | number;
  dead: string | number;
  max_attempts: string | number | null;
  max_estimated_complexity: string | number | null;
  oldest_task_age_ms: string | number | null;
  min_sync_max_level: string | number | null;
  max_sync_max_level: string | number | null;
  change_types: string[] | null;
};

export type ComputedOutboxSnapshot = {
  elapsedMs: number;
  total: number;
  pending: number;
  processing: number;
  dead: number;
  maxAttempts: number;
  maxEstimatedComplexity: number;
  oldestTaskAgeMs: number;
  minSyncMaxLevel?: number;
  maxSyncMaxLevel?: number;
  changeTypes: string[];
};

export type ComputedOutboxObserverSummary = {
  sampleCount: number;
  sawTask: boolean;
  firstSeenMs?: number;
  lastSeenMs?: number;
  peakTotal: number;
  peakPending: number;
  peakProcessing: number;
  peakDead: number;
  maxAttempts: number;
  maxEstimatedComplexity: number;
  maxOldestTaskAgeMs: number;
  minSyncMaxLevel?: number;
  maxSyncMaxLevel?: number;
  changeTypes: string[];
  final: ComputedOutboxSnapshot;
};

const numberValue = (value: string | number | null | undefined) =>
  value == null ? 0 : Number(value);

const optionalNumberValue = (
  value: string | number | null | undefined,
): number | undefined => (value == null ? undefined : Number(value));

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export class ComputedOutboxObserver {
  private readonly client: InstanceType<typeof Client>;
  private readonly samples: ComputedOutboxSnapshot[] = [];
  private readonly changeTypes = new Set<string>();
  private startedAt?: Date;
  private startedAtPerformance = 0;
  private running = false;
  private loopPromise?: Promise<void>;
  private loopError?: unknown;

  constructor(
    private readonly input: {
      baseId: string;
      seedTableId: string;
      pollIntervalMs?: number;
    },
  ) {
    const databaseUrl = process.env.PRISMA_DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("PRISMA_DATABASE_URL is not set");
    }
    this.client = new Client({ connectionString: databaseUrl });
  }

  async start() {
    await this.client.connect();
    const baseline = await this.querySnapshot(false);
    if (baseline.total > 0 || baseline.dead > 0) {
      await this.client.end();
      throw new Error(
        `Computed Outbox observer requires a clean table scope: table=${this.input.seedTableId}, total=${baseline.total}, dead=${baseline.dead}`,
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
  }

  async sampleNow(): Promise<ComputedOutboxSnapshot> {
    if (!this.startedAt) {
      throw new Error("Computed Outbox observer has not started");
    }
    const snapshot = await this.querySnapshot(true);
    this.samples.push(snapshot);
    for (const changeType of snapshot.changeTypes) {
      this.changeTypes.add(changeType);
    }
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
    const pollIntervalMs = Math.max(1, this.input.pollIntervalMs ?? 10);
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
    const result = await this.client.query<ComputedOutboxSnapshotRow>(
      `
        SELECT
          COUNT(*) FILTER (WHERE o.id IS NOT NULL)::int AS total,
          COUNT(*) FILTER (WHERE o.status = 'pending')::int AS pending,
          COUNT(*) FILTER (WHERE o.status = 'processing')::int AS processing,
          COALESCE((
            SELECT COUNT(*)::int
            FROM computed_update_dead_letter d
            WHERE d.base_id = $1
              AND d.seed_table_id = $2
              AND ($3::timestamptz IS NULL OR d.created_at >= $3)
          ), 0)::int AS dead,
          MAX(o.attempts)::int AS max_attempts,
          MAX(o.estimated_complexity)::int AS max_estimated_complexity,
          COALESCE(
            GREATEST(
              EXTRACT(EPOCH FROM (clock_timestamp() - MIN(o.created_at))) * 1000,
              0
            ),
            0
          ) AS oldest_task_age_ms,
          MIN(o.sync_max_level)::int AS min_sync_max_level,
          MAX(o.sync_max_level)::int AS max_sync_max_level,
          COALESCE(
            ARRAY_AGG(DISTINCT o.change_type) FILTER (WHERE o.change_type IS NOT NULL),
            ARRAY[]::text[]
          ) AS change_types
        FROM computed_update_outbox o
        WHERE o.base_id = $1
          AND o.seed_table_id = $2
          AND ($3::timestamptz IS NULL OR o.created_at >= $3)
      `,
      [this.input.baseId, this.input.seedTableId, scopedTime ?? null],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(
        "Computed Outbox observer query returned no aggregate row",
      );
    }
    return {
      elapsedMs: Math.max(0, performance.now() - this.startedAtPerformance),
      total: numberValue(row.total),
      pending: numberValue(row.pending),
      processing: numberValue(row.processing),
      dead: numberValue(row.dead),
      maxAttempts: numberValue(row.max_attempts),
      maxEstimatedComplexity: numberValue(row.max_estimated_complexity),
      oldestTaskAgeMs: numberValue(row.oldest_task_age_ms),
      minSyncMaxLevel: optionalNumberValue(row.min_sync_max_level),
      maxSyncMaxLevel: optionalNumberValue(row.max_sync_max_level),
      changeTypes: row.change_types ?? [],
    };
  }

  private summary(): ComputedOutboxObserverSummary {
    const final = this.samples.at(-1);
    if (!final) {
      throw new Error("Computed Outbox observer collected no samples");
    }
    const taskSamples = this.samples.filter((sample) => sample.total > 0);
    const syncLevels = this.samples.flatMap((sample) =>
      [sample.minSyncMaxLevel, sample.maxSyncMaxLevel].filter(
        (value): value is number => value != null,
      ),
    );
    return {
      sampleCount: this.samples.length,
      sawTask: taskSamples.length > 0,
      firstSeenMs: taskSamples[0]?.elapsedMs,
      lastSeenMs: taskSamples.at(-1)?.elapsedMs,
      peakTotal: Math.max(...this.samples.map((sample) => sample.total)),
      peakPending: Math.max(...this.samples.map((sample) => sample.pending)),
      peakProcessing: Math.max(
        ...this.samples.map((sample) => sample.processing),
      ),
      peakDead: Math.max(...this.samples.map((sample) => sample.dead)),
      maxAttempts: Math.max(
        ...this.samples.map((sample) => sample.maxAttempts),
      ),
      maxEstimatedComplexity: Math.max(
        ...this.samples.map((sample) => sample.maxEstimatedComplexity),
      ),
      maxOldestTaskAgeMs: Math.max(
        ...this.samples.map((sample) => sample.oldestTaskAgeMs),
      ),
      minSyncMaxLevel:
        syncLevels.length > 0 ? Math.min(...syncLevels) : undefined,
      maxSyncMaxLevel:
        syncLevels.length > 0 ? Math.max(...syncLevels) : undefined,
      changeTypes: [...this.changeTypes].sort(),
      final,
    };
  }
}
