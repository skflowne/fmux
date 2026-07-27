/**
 * The substrate shared by every bounded, revalidating, per-key cache in the
 * main process.
 *
 * Invariant it owns: **a settled fetch never writes to an entry the store no
 * longer holds.** An entry can disappear mid-fetch three ways — FIFO eviction
 * at the ceiling, an explicit `drop`, or a `clear` — and on every one of them
 * the write that arrives afterwards belongs to nobody. Letting it land
 * resurrects a key that was deliberately dropped, or overwrites a newer
 * generation with an older answer.
 *
 * No call site could do either today even if the guard were removed: each holds
 * its entry by reference and mutates it, so an orphaned write lands in a
 * detached object and is inert. The guard is what keeps that true for a writer
 * that goes back to storing by key — which is exactly what the two metadata
 * caches used to do, and exactly how the bug got in.
 *
 * Why this module exists. That invariant was hand-rolled three times
 * (`GitSyncStatusCache`, `PrStatusCache`, `transcriptProbeCache`) and only the
 * third one got the guard right, because only the third one was mutation-tested
 * for it. Three owners, three chances to omit it. One owner, one test.
 *
 * What it deliberately does NOT own, because the three call sites genuinely
 * disagree and a shared answer would be a lie:
 *
 * - **The read shape.** The two metadata caches `await` the fetch and hand the
 *   caller a promise. `transcriptProbeCache` answers synchronously from the last
 *   recorded value and revalidates out of band, because the daemon's per-poll
 *   `listSessions` handler must not block on `wsl.exe`.
 * - **What a failed fetch means.** For the metadata caches a failure *is* the
 *   answer — null, cached, aged out normally; quiet absence is their stated
 *   contract. For the probe cache a failure must never become an answer, because
 *   collapsing "could not look" into "it is not there" drops the `--resume` and
 *   loses the conversation.
 * - **What the TTL bounds.** The metadata caches use it as the maximum age of a
 *   value they will serve. The probe cache uses it to decide when revalidation
 *   *starts*, and will serve an older answer indefinitely while a guest stays
 *   unreachable.
 *
 * So the entry shape stays at the call site and this store is generic over it.
 * The store never interprets an entry; it only decides which object is current.
 *
 * Standing rule that follows from that: no TTL, no fetch and no timer ever lands
 * in this module. The moment one does, the divergence above has been papered
 * over rather than expressed.
 */

/** Cache ceiling — evicts oldest entries; sized far above realistic pane counts. */
export const DEFAULT_CACHE_MAX = 256;

export interface BoundedRevalidatingStoreOptions {
  /** Entry ceiling. Defaults to {@link DEFAULT_CACHE_MAX}. */
  max?: number;
}

/**
 * A bounded, insertion-ordered map of cache entries with an identity-guarded
 * settle path and an in-flight registry that survives its own entries.
 *
 * `E` is the call site's entry type. It must be an object: the guard is
 * reference identity, so a primitive entry could not distinguish two
 * generations holding the same value.
 */
export class BoundedRevalidatingStore<E extends object> {
  private readonly entries = new Map<string, E>();
  /**
   * Every tracked fetch still running, including ones whose entry has since
   * been evicted, dropped or cleared. Awaitability cannot hang off the entry:
   * losing the entry is exactly the case a caller most needs to be able to wait
   * for, and it is the case where the entry no longer holds the promise.
   */
  private readonly inFlight = new Set<Promise<void>>();
  private readonly max: number;

  constructor(options: BoundedRevalidatingStoreOptions = {}) {
    this.max = options.max ?? DEFAULT_CACHE_MAX;
  }

  /** The current entry for `key`, or undefined. Reading never renews position. */
  peek(key: string): E | undefined {
    return this.entries.get(key);
  }

  /**
   * Install `entry` under `key`, evicting the oldest key first if a *new* key
   * would exceed the ceiling.
   *
   * FIFO, not LRU: eviction takes the first key of a `Map`, whose iteration is
   * insertion-ordered. Replacing an existing key via `Map.set` keeps its
   * original position, so re-installing an entry does not renew it.
   *
   * That is a choice to match the existing behaviour, not an efficiency claim —
   * LRU would hold a busy key longer and hit more often. FIFO is what all three
   * call sites already did, and `transcriptProbeCache`'s suite pins
   * FIFO-not-LRU as an explicit assertion, so changing it here would silently
   * change behaviour there.
   */
  insert(key: string, entry: E): void {
    if (!this.entries.has(key) && this.entries.size >= this.max) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, entry);
  }

  /** Forget one key so the next read refetches. */
  drop(key: string): boolean {
    return this.entries.delete(key);
  }

  /**
   * Forget every key. In-flight fetches are deliberately left tracked so they
   * stay awaitable; each one finds its entry gone and writes nothing.
   */
  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  /** Read seam for tests: keys in eviction order, oldest first. */
  keysInOrder(): string[] {
    return [...this.entries.keys()];
  }

  /** Read seam for tests: fetches currently registered for draining. */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /**
   * **The guard.** Apply `mutate` to `entry` only if `key` still maps to that
   * exact object; report whether it ran.
   *
   * A `has(key)` check is not equivalent and is the mutant this exists to
   * survive: after a drop and a fresh fetch for the same key, `has` is true
   * again but the entry is a *different, newer* object, and letting the older
   * fetch write into it is the same bug wearing a different hat.
   *
   * `mutate` receives the entry rather than replacing it. Identity is the
   * mechanism; insertion position is a side effect worth keeping. Rewriting the
   * slot with a fresh object would still strand any other orphan holding the
   * previous one, and doing it via `delete` then `set` would additionally move
   * the key to the end of insertion order, silently turning FIFO eviction into
   * something LRU-shaped.
   */
  settle(key: string, entry: E, mutate: (entry: E) => void): boolean {
    if (this.entries.get(key) !== entry) return false;
    mutate(entry);
    return true;
  }

  /**
   * Register a fetch so {@link whenIdle} can await it, and return it unchanged.
   *
   * The registry holds a rejection-proof derivative rather than the promise
   * itself, so a caller that never attaches a handler cannot turn draining into
   * an unhandled rejection.
   *
   * Side effect worth naming: attaching that handler also marks the caller's
   * own promise as handled, so a rejection it ignores stops being reported by
   * Node as unhandled. Nothing should come to depend on that — `track` exists
   * to make a fetch drainable, not to swallow errors on a caller's behalf.
   */
  track<R>(promise: Promise<R>): Promise<R> {
    const settled = promise.then(
      () => undefined,
      () => undefined,
    );
    this.inFlight.add(settled);
    void settled.finally(() => {
      this.inFlight.delete(settled);
    });
    return promise;
  }

  /** Settle every fetch tracked at the moment of the call. */
  async whenIdle(): Promise<void> {
    await Promise.all([...this.inFlight]);
  }
}
