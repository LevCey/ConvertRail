/**
 * Per-key serial queue. Dependency-free on purpose: this is the one piece of the
 * state module that has to be unit-testable, and the rest of that module
 * reaches for the chain.
 *
 * It exists because the campaign cache reads a block range and then advances its
 * cursor, with an await in between. Two requests arriving inside that window
 * both observed the stale cursor, both scanned the same range, and both appended
 * it — every chain-derived counter doubled, while payments, which come from the
 * runtime evidence file rather than the cache, stayed correct. That asymmetry is
 * what made the bug visible: settled 100 against paid 50.
 *
 * Serialising per key means the second caller waits for the first and then scans
 * only what is genuinely new.
 */
const queues = new Map<string, Promise<unknown>>();

export function serializeByKey<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prior = queues.get(key);
  const next = (async () => {
    // A failed predecessor must not wedge the queue: the next caller still runs.
    if (prior) await prior.catch(() => undefined);
    return task();
  })();
  queues.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}
