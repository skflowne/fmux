/**
 * Cache for transcript-existence probes.
 *
 * Invariant: **a recorded answer is revalidated once `ttlMs` has passed, and an
 * unreachable guest is never evidence of absence.**
 *
 * The second half bounds the first. A refresh that cannot reach the guest
 * records no answer, so `lives()` goes on serving the last one it has for as
 * long as the guest stays unreachable — past `ttlMs`, without limit. That is
 * deliberate: discarding a retained answer because the guest went idle is the
 * "could not look" → "it is not there" collapse this module exists to prevent.
 * `ttlMs` bounds when revalidation is *started*, never how old the answer a poll
 * is handed can be: the refresh runs out of band, so a stale answer is served
 * across it by design, and an unanswerable guest holds it indefinitely.
 *
 * Why this is its own module. The host branch of a transcript liveness probe is
 * one local `lstat`, but the WSL branch spawns `wsl.exe` and blocks for up to
 * WSL_READ_TIMEOUT_MS. The daemon probes from its `listSessions` handler — a
 * per-poll stat — so N WSL panes would stall the daemon event loop N × 750 ms on
 * every poll, delaying PTY data forwarding and every other RPC. A transcript
 * appearing or being deleted is rare, so the first answer for a key is resolved
 * for real and later polls are served from cache while a refresh runs out of
 * band, keeping the call sites synchronous.
 *
 * That mechanism previously lived inline next to the probe itself with two write
 * paths whose error rules contradicted each other: the synchronous one recorded
 * every failure as "does not exist", while the asynchronous one refused to. Here
 * there is exactly one writer of an answer — `applyOutcome` — and exactly one
 * error rule: an `unreachable` outcome never becomes an answer.
 *
 * The bound, the FIFO eviction, the guard that stops a settled refresh writing
 * into an entry that is no longer current, and the in-flight registry are not
 * this module's: they are `BoundedRevalidatingStore`, shared with
 * `GitSyncStatusCache` and `PrStatusCache`. What stays here is everything those
 * two do differently — answering synchronously, revalidating out of band, and
 * refusing to let a failure become an answer at all.
 *
 * Three states, not two. A key can be unknown (probe it, blocking, once), or
 * known-and-answered, or known-but-never-answered. The third state is what makes
 * "cannot probe" survivable: it records the *attempt* so repeat polls neither
 * block nor re-spawn, while recording no *answer*, so nothing can later mistake
 * it for evidence the transcript is gone.
 */

import { BoundedRevalidatingStore, DEFAULT_CACHE_MAX } from '../cache/boundedRevalidatingStore';

/**
 * The result of one probe attempt.
 *
 * `unreachable` means the probe could not run or could not be trusted to have
 * looked — a spawn failure, a timeout, a guest whose distro is not resolved yet.
 * It is deliberately distinct from `answered` with `lives: false`, which means a
 * probe ran and the file was not there.
 */
export type ProbeOutcome =
  | { status: 'answered'; lives: boolean }
  | { status: 'unreachable' };

/** A recorded existence answer and when it was recorded. */
export interface ProbeAnswer {
  lives: boolean;
  at: number;
}

export const DEFAULT_PROBE_TTL_MS = 30_000;
/** This module's name for the shared ceiling; the value belongs to the store. */
export const DEFAULT_PROBE_CACHE_MAX = DEFAULT_CACHE_MAX;

/**
 * What a poll gets for a transcript that has never been answered for.
 *
 * "Cannot prove it dead" — the same rule the daemon already applies to a resume
 * binding with no transcript path at all. A WSL distro that is cold-booting
 * cannot answer within the probe timeout, and reporting absence there is what
 * dropped the exact `--resume <id>` and restarted agents without their
 * conversation. A false positive costs one `--resume` that prints "No
 * conversation found." and exits 0; a false negative costs the conversation.
 */
const ASSUME_ALIVE_WHEN_UNPROVEN = true;

interface ProbeEntry {
  /** Null until a probe has actually answered. `unreachable` never writes here. */
  answer: ProbeAnswer | null;
  /** When a probe was last attempted, answered or not. Throttles retries so an
   *  unreachable guest is not re-spawned on every poll. */
  attemptedAt: number;
  /** The in-flight out-of-band refresh, if any — single-flight per key. */
  pending: Promise<void> | null;
}

export interface TranscriptProbeCacheOptions {
  ttlMs?: number;
  max?: number;
  /** Injected so TTL behaviour is testable without mocking global time. */
  now?: () => number;
}

export interface TranscriptProbeCache {
  /**
   * Answer "does this transcript exist?" without ever blocking twice for the
   * same cache entry. `probeSync` runs once per entry — on first sight, and
   * again only if that entry is later evicted or reset away — and `probeAsync`
   * carries every refresh.
   */
  lives(
    key: string,
    probeSync: () => ProbeOutcome,
    probeAsync: () => Promise<ProbeOutcome>,
  ): boolean;
  /**
   * Settle every in-flight refresh.
   *
   * Deliberately not per-key: a refresh whose entry was evicted or reset away is
   * no longer reachable through that entry, and those are the ones a caller most
   * needs to wait for.
   */
  whenIdle(): Promise<void>;
  /** Read seam: the recorded answer, or null when no probe has answered yet. */
  answerFor(key: string): ProbeAnswer | null;
  reset(): void;
}

export function createTranscriptProbeCache(
  options: TranscriptProbeCacheOptions = {},
): TranscriptProbeCache {
  const ttlMs = options.ttlMs ?? DEFAULT_PROBE_TTL_MS;
  const max = options.max ?? DEFAULT_PROBE_CACHE_MAX;
  // Read through to the global on every call rather than capturing `Date.now`
  // once — the reference is captured at module load, which a caller that
  // controls time later could not then influence.
  const clock = options.now ?? (() => Date.now());
  /**
   * Owns the ceiling, FIFO eviction, the identity guard on a settled refresh,
   * and the in-flight registry that outlives its own entries — the last of
   * those because awaitability cannot hang off the entry alone: an eviction
   * mid-refresh would drop the promise from view while the spawn is still live.
   */
  const store = new BoundedRevalidatingStore<ProbeEntry>({ max });

  /**
   * The only writer of `answer`.
   *
   * Both the first blocking probe and every out-of-band refresh that settles
   * into its own entry land here — one whose entry was evicted or `reset` away
   * never gets this far, because the store refuses it — which is what keeps the
   * error rule single: an outcome that could not look is recorded as an attempt
   * and nothing else. The stamp sits *above* the answered guard because a failed
   * attempt is exactly what the retry throttle exists to space out; it
   * supersedes the one `ensureRefresh` takes when the attempt starts, so a probe
   * that settled `unreachable` slowly is not due again the moment it returns.
   *
   * A refresh that *rejects* never reaches here — `ensureRefresh` swallows it —
   * so on that one path the start stamp is the throttle, and the next retry is
   * spaced from when the attempt began.
   */
  function applyOutcome(entry: ProbeEntry, outcome: ProbeOutcome): void {
    entry.attemptedAt = clock();
    if (outcome.status !== 'answered') return;
    entry.answer = { lives: outcome.lives, at: entry.attemptedAt };
  }

  /**
   * The only place an entry is created, so the store's bound holds for
   * unanswered entries too.
   *
   * Evicting a key whose refresh is still in flight costs one extra probe: the
   * next sighting re-inserts and probes synchronously while the orphan finishes.
   * The orphan must not then write into the replacement, which is what the
   * store's identity guard in `ensureRefresh` prevents.
   *
   * The `attemptedAt` given here only guarantees the field is defined: the
   * `applyOutcome` call below runs unconditionally on the entry just created and
   * overwrites it, so no read ever sees this value.
   */
  function insert(key: string, outcome: ProbeOutcome): void {
    const entry: ProbeEntry = { answer: null, attemptedAt: clock(), pending: null };
    store.insert(key, entry);
    applyOutcome(entry, outcome);
  }

  function ensureRefresh(
    key: string,
    entry: ProbeEntry,
    probeAsync: () => Promise<ProbeOutcome>,
  ): void {
    if (entry.pending) return;
    // Throttle on the attempt, not the answer: an entry that has never been
    // answered for has no answer timestamp to age, and retrying it on every poll
    // would keep waking an idle distro indefinitely.
    if (clock() - entry.attemptedAt < ttlMs) return;
    // Stamped before the attempt, not only after it: a refresh that rejects is
    // swallowed below without reaching `applyOutcome`, and with no stamp at all
    // every later poll would re-spawn against the guest that just failed.
    entry.attemptedAt = clock();
    const pending: Promise<void> = (async () => {
      try {
        const outcome = await probeAsync();
        // Write only into the entry this refresh was started for. A `reset`, or
        // an eviction followed by a fresh probe, replaces that object — and a
        // stale answer must not overwrite the newer one, least of all in the
        // live-to-absent direction, nor restamp it with this older attempt.
        store.settle(key, entry, (slot) => applyOutcome(slot, outcome));
      } catch {
        // A rejected probe is unreachable: keep the last known answer.
      }
    })().finally(() => {
      const current = store.peek(key);
      if (current?.pending === pending) current.pending = null;
    });
    entry.pending = pending;
    // Track the outermost promise — the one the `finally` above produced, not
    // the async body it wraps — so a drain is ordered after the cleanup no
    // matter where `track` sits relative to it. Tracking the inner promise
    // happens to work today only because `.finally` is registered first.
    store.track(pending);
  }

  return {
    lives(key, probeSync, probeAsync) {
      const entry = store.peek(key);
      if (!entry) {
        const outcome = probeSync();
        insert(key, outcome);
        return outcome.status === 'answered' ? outcome.lives : ASSUME_ALIVE_WHEN_UNPROVEN;
      }
      if (entry.answer && clock() - entry.answer.at < ttlMs) return entry.answer.lives;
      ensureRefresh(key, entry, probeAsync);
      return entry.answer ? entry.answer.lives : ASSUME_ALIVE_WHEN_UNPROVEN;
    },
    async whenIdle() {
      await store.whenIdle();
    },
    answerFor(key) {
      return store.peek(key)?.answer ?? null;
    },
    reset() {
      // In-flight refreshes are deliberately left tracked so they stay
      // awaitable; each one finds its entry gone and writes nothing.
      store.clear();
    },
  };
}
