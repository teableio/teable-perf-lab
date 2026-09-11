import { queryPerfDb } from "./sql";

// Proof that a bystander request was blocked, rather than merely slow.
//
// Two requests in flight are slower than one for reasons that have nothing to
// do with locks: connection-pool contention, the event loop, the database
// competing with itself for buffers. A case that sends both at once and times
// the second cannot tell a run where a lock blocked it from a run where
// nothing did — the two differ only in degree, and the threshold separating
// them would be a statement about this machine's disk.
//
// So the harness does not race. It waits until the trigger's lock is actually
// held, releases the bystander then, and records which lock it saw. A run that
// never saw the lock is not a fast run; it is a run that measured nothing, and
// the artifact has to be able to say so.
//
// pg_locks is a SELECT, so this needs nothing beyond the read-only seam.

export type HeldLock = {
  pid: number;
  mode: string;
  relation: string;
  granted: boolean;
};

export type LockWatchOutcome = {
  observed: boolean;
  waitedMs: number;
  lock?: HeldLock;
  // Every lock seen on the relation when the watch ended, successfully or not.
  // On a timeout this is the evidence for why: an empty list means the trigger
  // never took a lock, a list without the awaited mode means it took a weaker
  // one than the case assumed.
  sample: HeldLock[];
};

type LockRow = {
  pid: number;
  mode: string;
  relname: string;
  granted: boolean;
};

const readLocks = async (
  schemaName: string,
  plainTableName: string,
): Promise<HeldLock[]> => {
  const rows = await queryPerfDb<LockRow>(
    `SELECT l.pid, l.mode, c.relname, l.granted
       FROM pg_locks l
       JOIN pg_class c ON c.oid = l.relation
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE l.locktype = 'relation'
        AND n.nspname = $1
        AND c.relname = $2`,
    [schemaName, plainTableName],
  );
  return rows.map((row) => ({
    pid: Number(row.pid),
    mode: String(row.mode),
    relation: String(row.relname),
    granted: row.granted === true,
  }));
};

export const waitForHeldLock = async ({
  schemaName,
  plainTableName,
  modes,
  timeoutMs,
  pollIntervalMs = 20,
  excludePids = [],
}: {
  schemaName: string;
  plainTableName: string;
  // Lock modes that count as the trigger having taken hold, e.g.
  // ["AccessExclusiveLock"]. Listed by the case, because which mode the
  // operation under test takes is part of what the case claims.
  modes: string[];
  timeoutMs: number;
  pollIntervalMs?: number;
  // Connections the harness itself owns, so the harness's own reads cannot be
  // mistaken for the trigger.
  excludePids?: number[];
}): Promise<LockWatchOutcome> => {
  const startedAt = performance.now();
  const excluded = new Set(excludePids);
  let sample: HeldLock[] = [];
  while (performance.now() - startedAt < timeoutMs) {
    sample = await readLocks(schemaName, plainTableName);
    const match = sample.find(
      (lock) =>
        lock.granted && modes.includes(lock.mode) && !excluded.has(lock.pid),
    );
    if (match) {
      return {
        observed: true,
        waitedMs: performance.now() - startedAt,
        lock: match,
        sample,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return {
    observed: false,
    waitedMs: performance.now() - startedAt,
    sample,
  };
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const assertIdentifier = (label: string, value: string) => {
  if (!IDENTIFIER.test(value)) {
    throw new Error(
      `lock observation ${label} must be a plain identifier, got ${JSON.stringify(value)}`,
    );
  }
  return value;
};

// A physical table name as the product stores it, split for the catalog
// queries that identify a relation by schema and name.
export const splitQualifiedTableName = (dbTableName: string) => {
  const dotIndex = dbTableName.indexOf(".");
  const schemaName =
    dotIndex === -1 ? "public" : dbTableName.slice(0, dotIndex);
  const plainTableName =
    dotIndex === -1 ? dbTableName : dbTableName.slice(dotIndex + 1);
  return {
    schemaName: assertIdentifier("schema name", schemaName),
    plainTableName: assertIdentifier("table name", plainTableName),
  };
};

export const rowOrderColumnName = (viewId: string) =>
  `__row_${assertIdentifier("view id", viewId)}`;
