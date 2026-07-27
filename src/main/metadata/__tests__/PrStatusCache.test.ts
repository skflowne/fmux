import { describe, it, expect, vi } from 'vitest';
import { PrStatusCache, mapGhPrView } from '../PrStatusCache';

const host = (cwd: string, sessionId = 'pty-host') => ({
  sessionId,
  location: { domain: 'host' as const, cwd, shell: 'pwsh.exe' },
});

describe('mapGhPrView', () => {
  it('maps an open PR with passing checks', () => {
    expect(mapGhPrView({
      number: 42,
      state: 'OPEN',
      isDraft: false,
      url: 'https://github.com/o/r/pull/42',
      statusCheckRollup: [
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'COMPLETED', conclusion: 'NEUTRAL' },
      ],
    })).toEqual({ number: 42, state: 'open', checks: 'passing', url: 'https://github.com/o/r/pull/42' });
  });

  it('draft beats open; merged/closed beat draft', () => {
    expect(mapGhPrView({ number: 1, state: 'OPEN', isDraft: true, url: 'u' })?.state).toBe('draft');
    expect(mapGhPrView({ number: 1, state: 'MERGED', isDraft: true, url: 'u' })?.state).toBe('merged');
    expect(mapGhPrView({ number: 1, state: 'CLOSED', isDraft: false, url: 'u' })?.state).toBe('closed');
  });

  it('any failure wins over pending', () => {
    expect(mapGhPrView({
      number: 2, state: 'OPEN', url: 'u',
      statusCheckRollup: [
        { status: 'IN_PROGRESS' },
        { status: 'COMPLETED', conclusion: 'FAILURE' },
      ],
    })?.checks).toBe('failing');
  });

  it('in-progress checks map to pending', () => {
    expect(mapGhPrView({
      number: 3, state: 'OPEN', url: 'u',
      statusCheckRollup: [{ status: 'QUEUED' }],
    })?.checks).toBe('pending');
  });

  it('StatusContext-variant entries (state, no conclusion) are honored', () => {
    expect(mapGhPrView({
      number: 4, state: 'OPEN', url: 'u',
      statusCheckRollup: [{ state: 'FAILURE' }],
    })?.checks).toBe('failing');
  });

  it('empty rollup means checks null', () => {
    expect(mapGhPrView({ number: 5, state: 'OPEN', url: 'u', statusCheckRollup: [] })?.checks).toBeNull();
  });

  it('rejects payloads missing number/url', () => {
    expect(mapGhPrView({ state: 'OPEN', url: 'u' })).toBeNull();
    expect(mapGhPrView({ number: 6, state: 'OPEN' })).toBeNull();
  });
});

describe('PrStatusCache', () => {
  const PR_JSON = JSON.stringify({ number: 7, state: 'OPEN', isDraft: false, url: 'https://x/pull/7', statusCheckRollup: [] });

  it('caches within the TTL and refetches after it', async () => {
    let now = 0;
    const exec = vi.fn().mockResolvedValue({ stdout: PR_JSON });
    const cache = new PrStatusCache(() => now, exec);

    const first = await cache.get(host('D:\\repo'), 'main');
    expect(first?.number).toBe(7);
    expect(exec).toHaveBeenCalledTimes(1);

    now = 4 * 60 * 1000;
    await cache.get(host('D:\\repo'), 'main');
    expect(exec).toHaveBeenCalledTimes(1); // still cached

    now = 6 * 60 * 1000;
    await cache.get(host('D:\\repo'), 'main');
    expect(exec).toHaveBeenCalledTimes(2); // TTL expired
  });

  it('keys the cache by domain+distro+cwd+branch', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: PR_JSON });
    const cache = new PrStatusCache(() => 0, exec);
    await cache.get(host('D:\\repo'), 'main');
    await cache.get({
      sessionId: 'pty-u',
      location: { domain: 'wsl', cwd: '/repo', shell: 'wsl.exe', distro: 'Ubuntu' },
      activeContext: { sessionId: 'pty-u', active: true, distro: 'Ubuntu' },
    }, 'main');
    await cache.get({
      sessionId: 'pty-d',
      location: { domain: 'wsl', cwd: '/repo', shell: 'wsl.exe', distro: 'Debian' },
      activeContext: { sessionId: 'pty-d', active: true, distro: 'Debian' },
    }, 'main');
    await cache.get(host('D:\\repo'), 'feat');
    expect(exec).toHaveBeenCalledTimes(4);
  });

  it('normalizes the cwd key (separator/trailing-slash/case variance collapse onto one entry)', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: PR_JSON });
    const cache = new PrStatusCache(() => 0, exec);
    await cache.get(host('D:\\repo'), 'main');
    await cache.get(host('D:/repo/'), 'main');
    await cache.get(host('d:\\REPO'), 'main');
    // A bare worktree path (the pre-location caller form) must land on the
    // same entry the pane target created — locationIdentity owns the folding.
    await cache.get('D:/Repo//', 'main');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent callers onto one gh subprocess', async () => {
    let resolve!: (v: { stdout: string }) => void;
    const exec = vi.fn().mockReturnValue(new Promise<{ stdout: string }>((r) => { resolve = r; }));
    const cache = new PrStatusCache(() => 0, exec);
    const target = host('D:\\repo');
    const p1 = cache.get(target, 'main');
    const p2 = cache.get(target, 'main');
    resolve({ stdout: PR_JSON });
    const [a, b] = await Promise.all([p1, p2]);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(a?.number).toBe(7);
    expect(b?.number).toBe(7);
  });

  it('"no PR" failures resolve null quietly and are cached', async () => {
    const exec = vi.fn().mockRejectedValue(Object.assign(new Error('no pull requests found'), { code: 1 }));
    const cache = new PrStatusCache(() => 0, exec);
    expect(await cache.get(host('D:\\repo'), 'main')).toBeNull();
    expect(await cache.get(host('D:\\repo'), 'main')).toBeNull();
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('gh missing (ENOENT) disables the cache permanently for this process', async () => {
    const exec = vi.fn().mockRejectedValue(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
    const cache = new PrStatusCache(() => 0, exec);
    expect(await cache.get(host('D:\\a'), 'main')).toBeNull();
    expect(await cache.get(host('D:\\b'), 'other')).toBeNull();
    expect(exec).toHaveBeenCalledTimes(1); // never probed again
  });

  it('invalidate() forces a refetch before the TTL, across cwd spellings', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: PR_JSON });
    const cache = new PrStatusCache(() => 0, exec);
    await cache.get(host('D:\\repo'), 'main');
    // Deliberately a DIFFERENT spelling of the same directory: an invalidate
    // that only works on the identical object proves nothing about the key.
    cache.invalidate('d:/repo/', 'main');
    await cache.get(host('D:\\repo'), 'main');
    expect(exec).toHaveBeenCalledTimes(2);
    // Branch is still part of the key — a sibling branch keeps its own entry.
    cache.invalidate('d:/repo/', 'other');
    await cache.get(host('D:\\repo'), 'main');
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('keeps timeout/output caps and passes structured WSL argv', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: PR_JSON });
    const cache = new PrStatusCache(() => 0, exec);
    await cache.get({
      sessionId: 'pty-u',
      location: { domain: 'wsl', cwd: '/repo with spaces', shell: 'wsl.exe', distro: 'Ubuntu' },
      activeContext: { sessionId: 'pty-u', active: true, distro: 'Ubuntu' },
    }, 'main');
    expect(exec).toHaveBeenCalledWith(
      'wsl.exe',
      expect.arrayContaining(['--cd', '/repo with spaces', '--exec', process.platform === 'win32' ? 'gh.exe' : 'gh']),
      expect.objectContaining({ timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }),
    );
  });
});

/**
 * Issue 42 — the same orphaned-settle audit as GitSyncStatusCache, which this
 * cache's `get` duplicates line for line.
 *
 * The live trigger here is PR creation: `TaskPrService` invalidates the entry
 * the moment the PR exists, precisely so the badge does not wait out the TTL.
 * An orphaned write puts the "no PR" answer back with a fresh timestamp, and
 * this cache's TTL is five minutes.
 */
describe('PrStatusCache — orphaned settled fetches', () => {
  const prJson = (number: number) =>
    JSON.stringify({ number, state: 'OPEN', isDraft: false, url: `https://x/pull/${number}`, statusCheckRollup: [] });

  function deferredExec() {
    const settles: Array<(v: { stdout: string }) => void> = [];
    const exec = vi.fn().mockImplementation(
      () => new Promise<{ stdout: string }>((resolve) => { settles.push(resolve); }),
    );
    return { exec, settles };
  }

  it('an invalidate mid-fetch is not undone by the settled write', async () => {
    const { exec, settles } = deferredExec();
    const cache = new PrStatusCache(() => 0, exec);

    const inFlight = cache.get(host('D:/repo'), 'main');
    cache.invalidate('D:/repo', 'main');
    settles[0]({ stdout: prJson(7) });
    await inFlight;

    const next = cache.get(host('D:/repo'), 'main');
    expect(exec).toHaveBeenCalledTimes(2);
    settles[1]({ stdout: prJson(7) });
    await next;
  });

  it('an orphaned fetch does not overwrite the newer entry that replaced it', async () => {
    // A moving clock, so this also pins *when* the surviving entry says it was
    // fetched. With a frozen clock the settled write could skip its timestamp
    // entirely and nothing would notice — and an entry whose age never advances
    // re-spawns gh on every poll once its first window closes.
    let now = 0;
    const { exec, settles } = deferredExec();
    const cache = new PrStatusCache(() => now, exec);

    const gen1 = cache.get(host('D:/repo'), 'main');
    cache.invalidate('D:/repo', 'main');
    const gen2 = cache.get(host('D:/repo'), 'main');
    expect(exec).toHaveBeenCalledTimes(2);

    now = 1_000;
    settles[1]({ stdout: prJson(99) });
    await gen2;
    now = 2_000;
    settles[0]({ stdout: prJson(7) });
    await gen1;

    // Inside gen2's window, measured from gen2's own stamp of 1_000.
    now = 300_000;
    expect((await cache.get(host('D:/repo'), 'main'))?.number).toBe(99);
    expect(exec).toHaveBeenCalledTimes(2);

    // Past it: the entry must age from gen2's stamp, not from 0 and not from
    // the orphan's later one.
    now = 301_001;
    const third = cache.get(host('D:/repo'), 'main');
    expect(exec).toHaveBeenCalledTimes(3);
    settles[2]({ stdout: prJson(123) });
    expect((await third)?.number).toBe(123);
  });

  it('a clear mid-fetch is not undone by the settled write', async () => {
    const { exec, settles } = deferredExec();
    const cache = new PrStatusCache(() => 0, exec);

    const inFlight = cache.get(host('D:/repo'), 'main');
    cache.clear();
    settles[0]({ stdout: prJson(7) });
    await inFlight;

    const next = cache.get(host('D:/repo'), 'main');
    expect(exec).toHaveBeenCalledTimes(2);
    settles[1]({ stdout: prJson(7) });
    await next;
  });

  it('a fetch evicted mid-flight does not resurrect its key or clobber the refetch', async () => {
    const evicted: Array<(v: { stdout: string }) => void> = [];
    const exec = vi.fn().mockImplementation((_file: string, _args: string[], opts: { cwd?: string }) => {
      if (opts.cwd === 'D:/repo0') {
        return new Promise<{ stdout: string }>((resolve) => { evicted.push(resolve); });
      }
      return Promise.resolve({ stdout: prJson(1) });
    });
    const cache = new PrStatusCache(() => 0, exec);

    const orphan = cache.get(host('D:/repo0'), 'main');
    for (let i = 1; i <= 256; i++) await cache.get(host(`D:/filler${i}`), 'main');

    const refetch = cache.get(host('D:/repo0'), 'main');
    expect(evicted).toHaveLength(2);
    evicted[1]({ stdout: prJson(99) });
    await refetch;

    evicted[0]({ stdout: prJson(7) });
    await orphan;

    expect((await cache.get(host('D:/repo0'), 'main'))?.number).toBe(99);
  });

  it('still resolves the original caller with the value its own fetch returned', async () => {
    const { exec, settles } = deferredExec();
    const cache = new PrStatusCache(() => 0, exec);

    const inFlight = cache.get(host('D:/repo'), 'main');
    cache.invalidate('D:/repo', 'main');
    settles[0]({ stdout: prJson(7) });

    await expect(inFlight).resolves.toMatchObject({ number: 7 });
  });

  it('an ENOENT that settles after an invalidate still latches gh as unavailable', async () => {
    let reject!: (e: unknown) => void;
    const exec = vi.fn().mockImplementation(
      () => new Promise<{ stdout: string }>((_resolve, r) => { reject = r; }),
    );
    const cache = new PrStatusCache(() => 0, exec);

    const inFlight = cache.get(host('D:/repo'), 'main');
    cache.invalidate('D:/repo', 'main');
    reject(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
    expect(await inFlight).toBeNull();

    // The breaker is process-wide and lives inside fetch, deliberately outside
    // the per-entry guard: losing the entry must not make a gh-less machine
    // spawn gh forever.
    expect(await cache.get(host('D:/other'), 'main')).toBeNull();
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
