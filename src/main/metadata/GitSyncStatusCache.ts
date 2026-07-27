import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitSyncStatus } from '../../shared/types';
import { getGitExecEnv } from '../../shared/execEnv';
import {
  paneCommandIdentity,
  preparePaneCommand,
  hostCommandTarget,
  type PaneCommandTarget,
} from '../git/paneCommand';
import { BoundedRevalidatingStore } from '../cache/boundedRevalidatingStore';

const execFileAsync = promisify(execFile);

/**
 * Sidebar git sync status — dirty count + ahead/behind vs upstream, from one
 * `git --no-optional-locks status --porcelain=v2 --branch` per repo per TTL
 * window. Same quiet-absence contract as PrStatusCache: resolves null on
 * every failure path (git missing, not a repo, timeout) and never throws.
 *
 * TTL is much shorter than the PR cache's 5 min — dirty state changes with
 * every buffer save, and the whole point of the badge is "do I have local
 * work here". `--no-optional-locks` keeps the subprocess from ever touching
 * the index lock, so it can never collide with a user-driven git operation.
 */

const TTL_MS = 15_000;
const GIT_TIMEOUT_MS = 10_000;

interface CacheEntry {
  value: GitSyncStatus | null;
  fetchedAt: number;
  /** In-flight fetch, shared by concurrent callers within the same window. */
  pending: Promise<GitSyncStatus | null> | null;
}

/**
 * Parse `git status --porcelain=v2 --branch` output. Exported for tests.
 *
 * Headers consumed: `# branch.ab +A -B` (present only with an upstream).
 * Every non-header line is one changed path: `1 ` (modified), `2 ` (renamed),
 * `u ` (unmerged), `? ` (untracked). Ignored entries (`! `) don't count.
 */
export function parsePorcelainV2(stdout: string): GitSyncStatus {
  let ahead = 0;
  let behind = 0;
  let hasUpstream = false;
  let dirty = 0;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('# branch.ab ')) {
      const m = line.match(/^# branch\.ab \+(\d+) -(\d+)$/);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
        hasUpstream = true;
      }
    } else if (/^[12u?] /.test(line)) {
      dirty++;
    }
  }
  return { dirty, ahead, behind, hasUpstream };
}

export class GitSyncStatusCache {
  /**
   * The bound, FIFO eviction and the identity guard on settled writes live in
   * the store, shared with PrStatusCache and transcriptProbeCache. What stays
   * here is this cache's own policy: callers await the fetch, and a failed
   * fetch is a real answer (null) cached for the TTL like any other.
   */
  private store = new BoundedRevalidatingStore<CacheEntry>();

  constructor(
    private now: () => number = Date.now,
    private exec: (
      cmd: string,
      args: string[],
      opts: { cwd?: string; timeout: number; env: NodeJS.ProcessEnv; windowsHide: boolean; maxBuffer: number },
    ) => Promise<{ stdout: string }> = execFileAsync,
  ) {}

  /**
   * Sync status for the repo containing `cwd`. Null on every failure path —
   * quiet absence is the contract (matches PrStatusCache).
   */
  async get(input: PaneCommandTarget | string): Promise<GitSyncStatus | null> {
    const target = typeof input === 'string' ? hostCommandTarget(input) : input;
    if (!preparePaneCommand(target, 'git', ['status']).ok) return null;
    const key = paneCommandIdentity(target);
    const entry = this.store.peek(key);
    const now = this.now();
    if (entry) {
      if (entry.pending) return entry.pending;
      if (now - entry.fetchedAt < TTL_MS) return entry.value;
    }

    // The entry this fetch belongs to. Held by reference so the settle below
    // can be refused if the map has moved on — an `invalidate` from the git
    // watcher, a `clear`, or an eviction, any of which can land while git runs.
    const next: CacheEntry = {
      value: entry?.value ?? null,
      fetchedAt: entry?.fetchedAt ?? 0,
      pending: null,
    };
    // Installed before the fetch starts, so the entry the settle matches against
    // always exists by then — rather than relying on `fetch` being declared
    // async and therefore unable to throw before the install below.
    this.store.insert(key, next);
    const pending = (async () => {
      // `fetch` already resolves null on every failure path; the catch is a
      // belt on top of that, not a second error rule.
      const value = await this.fetch(target).catch(() => null);
      // Clock read stays outside the mutate, so the mutate is assignments only
      // and cannot throw. A throw in there would abandon `pending` half-cleared,
      // leaving the entry holding a rejected promise that every later get()
      // would return — and this cache's contract is that it never throws.
      const fetchedAt = this.now();
      this.store.settle(key, next, (slot) => {
        slot.value = value;
        slot.fetchedAt = fetchedAt;
        slot.pending = null;
      });
      return value;
    })();
    next.pending = pending;
    return pending;
  }

  /** Drop one entry so the next poll refetches (branch switch, post-commit). */
  invalidate(input: PaneCommandTarget | string): void {
    const target = typeof input === 'string' ? hostCommandTarget(input) : input;
    this.store.drop(paneCommandIdentity(target));
  }

  clear(): void {
    this.store.clear();
  }

  private async fetch(target: PaneCommandTarget): Promise<GitSyncStatus | null> {
    try {
      const command = preparePaneCommand(
        target,
        'git',
        ['--no-optional-locks', 'status', '--porcelain=v2', '--branch'],
      );
      if (!command.ok) return null;
      const { stdout } = await this.exec(
        command.file,
        command.args,
        {
          ...(command.cwd ? { cwd: command.cwd } : {}),
          timeout: GIT_TIMEOUT_MS,
          env: { ...getGitExecEnv(), GIT_OPTIONAL_LOCKS: '0', NO_COLOR: '1' },
          windowsHide: true,
          // A pathological repo (thousands of untracked files) must truncate,
          // not reject — 10 MB covers ~100k paths.
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      return parsePorcelainV2(stdout);
    } catch {
      // Not a repo / git missing / timeout — quiet absence.
      return null;
    }
  }
}

/** Process-wide singleton — one TTL window shared by every caller. */
export const gitSyncStatusCache = new GitSyncStatusCache();
