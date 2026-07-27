import { describe, it, expect, vi } from 'vitest';
import { BoundedRevalidatingStore, DEFAULT_CACHE_MAX } from '../boundedRevalidatingStore';

interface Entry {
  value: string;
  at: number;
}

const entry = (value: string, at = 0): Entry => ({ value, at });

/**
 * Drain the microtask queue hard enough that an *already settled* drain would
 * have run its callback.
 *
 * Two ticks is not enough: an idle `whenIdle()` resolves at tick 2 exactly, so a
 * two-tick check clears a broken registry by a single tick and a one-tick check
 * does not catch it at all.
 */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/**
 * A promise the test settles by hand.
 *
 * The orphan write only exists in the window between a fetch starting and
 * settling, so every guard test has to place a map mutation inside that window.
 * Letting a fetch resolve on its own microtask cannot do that deterministically.
 */
function deferred<T>() {
  let settle!: (v: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

describe('BoundedRevalidatingStore — bound and eviction order', () => {
  it('evicts the oldest key when a new key would exceed the ceiling', () => {
    const store = new BoundedRevalidatingStore<Entry>({ max: 3 });
    store.insert('a', entry('a'));
    store.insert('b', entry('b'));
    store.insert('c', entry('c'));
    store.insert('d', entry('d'));

    expect(store.size).toBe(3);
    expect(store.keysInOrder()).toEqual(['b', 'c', 'd']);
    expect(store.peek('a')).toBeUndefined();
  });

  it('replacing an existing key does not renew its position (FIFO, not LRU)', () => {
    const store = new BoundedRevalidatingStore<Entry>({ max: 3 });
    store.insert('a', entry('a'));
    store.insert('b', entry('b'));
    store.insert('c', entry('c'));

    // 'a' is re-installed — under LRU this would make it the newest.
    store.insert('a', entry('a2'));
    expect(store.size).toBe(3);

    store.insert('d', entry('d'));
    expect(store.keysInOrder()).toEqual(['b', 'c', 'd']);
    expect(store.peek('a')).toBeUndefined();
  });

  it('reading does not renew position', () => {
    const store = new BoundedRevalidatingStore<Entry>({ max: 2 });
    store.insert('a', entry('a'));
    store.insert('b', entry('b'));
    store.peek('a');
    store.insert('c', entry('c'));
    expect(store.keysInOrder()).toEqual(['b', 'c']);
  });

  it('defaults the ceiling to 256', () => {
    const store = new BoundedRevalidatingStore<Entry>();
    for (let i = 0; i < DEFAULT_CACHE_MAX + 10; i++) store.insert(`k${i}`, entry(`k${i}`));
    expect(store.size).toBe(DEFAULT_CACHE_MAX);
    expect(store.peek('k0')).toBeUndefined();
    expect(store.peek(`k${DEFAULT_CACHE_MAX + 9}`)).toBeDefined();
  });
});

describe('BoundedRevalidatingStore — the identity guard on settle', () => {
  it('applies the write while the entry is still the current one', () => {
    const store = new BoundedRevalidatingStore<Entry>();
    const e = entry('stale');
    store.insert('k', e);

    const applied = store.settle('k', e, (target) => {
      target.value = 'fresh';
    });

    expect(applied).toBe(true);
    expect(store.peek('k')?.value).toBe('fresh');
  });

  // Mutant A: drop the guard entirely (settle unconditionally).
  it('refuses a write whose key was dropped mid-fetch, and does not resurrect it', () => {
    const store = new BoundedRevalidatingStore<Entry>();
    const e = entry('stale');
    store.insert('k', e);
    store.drop('k');

    const applied = store.settle('k', e, (target) => {
      target.value = 'fresh';
    });

    expect(applied).toBe(false);
    expect(store.peek('k')).toBeUndefined();
    expect(store.size).toBe(0);
  });

  // Mutant A, via the other trigger.
  it('refuses a write whose key was evicted mid-fetch, and does not resurrect it', () => {
    const store = new BoundedRevalidatingStore<Entry>({ max: 2 });
    const orphan = entry('orphan');
    store.insert('a', orphan);
    store.insert('b', entry('b'));
    store.insert('c', entry('c')); // evicts 'a'

    expect(store.settle('a', orphan, (t) => { t.value = 'fresh'; })).toBe(false);
    expect(store.peek('a')).toBeUndefined();
    expect(store.keysInOrder()).toEqual(['b', 'c']);
  });

  it('refuses a write whose key was cleared mid-fetch', () => {
    const store = new BoundedRevalidatingStore<Entry>();
    const e = entry('stale');
    store.insert('k', e);
    store.clear();

    expect(store.settle('k', e, (t) => { t.value = 'fresh'; })).toBe(false);
    expect(store.size).toBe(0);
  });

  /**
   * Mutant B — the one that matters. Weakening the guard to `entries.has(key)`
   * survives every test above, because after a re-insert the key is present
   * again. Only a *newer generation under the same key* distinguishes them.
   */
  it('refuses an older write when the key was dropped and refetched (has(key) is not enough)', () => {
    const store = new BoundedRevalidatingStore<Entry>();
    const first = entry('gen1', 100);
    store.insert('k', first);

    store.drop('k');
    const second = entry('gen2', 200);
    store.insert('k', second);

    const applied = store.settle('k', first, (t) => {
      t.value = 'gen1-late';
      t.at = 999;
    });

    expect(applied).toBe(false);
    // Both halves of the newer entry survive: an orphan that wrote only the
    // timestamp would backdate the live answer without changing its value.
    expect(store.peek('k')).toEqual({ value: 'gen2', at: 200 });
  });

  it('refuses an older write when the key was evicted and refetched', () => {
    const store = new BoundedRevalidatingStore<Entry>({ max: 2 });
    const first = entry('gen1', 100);
    store.insert('a', first);
    store.insert('b', entry('b'));
    store.insert('c', entry('c')); // evicts 'a'

    const second = entry('gen2', 200);
    store.insert('a', second); // 'a' is present again, different object

    expect(store.settle('a', first, (t) => { t.value = 'gen1-late'; })).toBe(false);
    expect(store.peek('a')).toEqual({ value: 'gen2', at: 200 });
  });

  it('refuses an older write when the key was replaced outright, with no drop in between', () => {
    const store = new BoundedRevalidatingStore<Entry>();
    const first = entry('gen1', 100);
    store.insert('k', first);
    // No drop, no eviction — a plain overwrite. Position is preserved here, so
    // only reference identity distinguishes the generations.
    const second = entry('gen2', 200);
    store.insert('k', second);

    expect(store.settle('k', first, (t) => { t.value = 'gen1-late'; })).toBe(false);
    expect(store.peek('k')).toEqual({ value: 'gen2', at: 200 });
  });

  /**
   * Mutant D — settle implemented as `delete` + `set` instead of mutating the
   * guarded object. Invisible to every assertion above, but it renews the key's
   * insertion position and quietly converts FIFO eviction into LRU.
   */
  it('settling the oldest key does not renew its eviction position', () => {
    const store = new BoundedRevalidatingStore<Entry>({ max: 3 });
    const oldest = entry('a');
    store.insert('a', oldest);
    store.insert('b', entry('b'));
    store.insert('c', entry('c'));

    store.settle('a', oldest, (t) => { t.value = 'a-refreshed'; });
    expect(store.peek('a')?.value).toBe('a-refreshed');

    store.insert('d', entry('d'));
    expect(store.keysInOrder()).toEqual(['b', 'c', 'd']);
    expect(store.peek('a')).toBeUndefined();
  });
});

describe('BoundedRevalidatingStore — in-flight tracking', () => {
  it('returns the caller its own promise, unchanged', async () => {
    const store = new BoundedRevalidatingStore<Entry>();
    const d = deferred<string>();
    const returned = store.track(d.promise);
    expect(returned).toBe(d.promise);
    d.settle('done');
    await expect(returned).resolves.toBe('done');
  });

  it('whenIdle stays pending until a tracked fetch settles', async () => {
    const store = new BoundedRevalidatingStore<Entry>();
    const d = deferred<string>();
    store.track(d.promise);

    const seen = vi.fn();
    const drain = store.whenIdle().then(seen);
    await flushMicrotasks();
    expect(seen).not.toHaveBeenCalled();

    d.settle('done');
    await drain;
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('a fetch whose entry was dropped is still awaitable', async () => {
    const store = new BoundedRevalidatingStore<Entry>();
    const e = entry('stale');
    store.insert('k', e);
    const d = deferred<string>();
    store.track(d.promise);

    store.drop('k'); // the entry is gone; the fetch is not
    expect(store.size).toBe(0);
    // The registry, not the entry, is what keeps this awaitable.
    expect(store.inFlightCount).toBe(1);

    const seen = vi.fn();
    const drain = store.whenIdle().then(seen);
    await flushMicrotasks();
    expect(seen).not.toHaveBeenCalled();

    d.settle('done');
    await drain;
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('drops settled fetches from the registry so it cannot grow without bound', async () => {
    const store = new BoundedRevalidatingStore<Entry>();
    const d = deferred<string>();
    store.track(d.promise);
    expect(store.inFlightCount).toBe(1);

    d.settle('done');
    await store.whenIdle();
    await flushMicrotasks();
    // A drain that resolves proves nothing on its own — Promise.all over a
    // leaked-but-settled registry resolves too. The count is the assertion.
    expect(store.inFlightCount).toBe(0);
  });

  it('a rejected fetch drains without becoming an unhandled rejection', async () => {
    const store = new BoundedRevalidatingStore<Entry>();
    const rejected = Promise.reject(new Error('spawn failed'));
    store.track(rejected);
    await expect(store.whenIdle()).resolves.toBeUndefined();
    // The caller's own promise still rejects — track must not swallow it for them.
    await expect(rejected).rejects.toThrow('spawn failed');
  });
});
