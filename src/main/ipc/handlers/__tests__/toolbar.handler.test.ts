/**
 * toolbar.handler — `git:status` runs its git through the location execution API.
 *
 * Issue #21 AC 1 put a pane location on this channel; issue #30 is the half that
 * was left behind. The handler used to convert the location to a host-reachable
 * path and run WINDOWS git against it, which for a WSL repo meant git walking the
 * 9p share instead of git running in the guest — a second execution mechanism in
 * a codebase where every other git/gh call site goes through
 * `prepareLocationCommand`/`preparePaneCommand`.
 *
 * So these specs assert the command the shared API produced, and — the part an
 * argv snapshot cannot give — that the handler inherits its REFUSALS: no live
 * pane behind a WSL location means no command at all, because only a live pane
 * carries the active-session context that gate requires.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import type { SessionLocation } from '../../../../shared/sessionLocation';
import { createSessionCommandTarget } from '../../../../shared/sessionLocation';
import type { PaneCommandTarget } from '../../../git/paneCommand';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
}));

// `git()` promisifies `execFile` at module load, so the mock has to answer the
// promisified binding (precedent: main/__tests__/installedFonts.test.ts).
const { execFileAsync } = vi.hoisted(() => ({ execFileAsync: vi.fn() }));
vi.mock('node:child_process', () => ({
  execFile: Object.assign(function execFile() { /* promisified via the custom symbol */ }, {
    [Symbol.for('nodejs.util.promisify.custom')]: execFileAsync,
  }),
}));

import { IPC } from '../../../../shared/constants';
import { registerToolbarHandlers } from '../toolbar.handler';

const fakeEvent = {} as Electron.IpcMainInvokeEvent;
// Windows spellings on purpose, as literals: these paths cross a domain
// conversion, and `path.join` would spell them POSIX-style on the Linux and
// macOS CI legs.
const hostCwd = 'C:\\dev\\proj';
const HOME = 'C:\\Users\\tester';
const MSYS_SHELL = 'C:\\Program Files\\Git\\bin\\bash.exe';
const PORCELAIN = ' M src/index.ts\n';

/** The live panes this test's registry knows, keyed the way the handler asks. */
const livePanes = new Map<string, PaneCommandTarget>();

function livePane(ptyId: string, location: SessionLocation): void {
  livePanes.set(JSON.stringify(location), createSessionCommandTarget(ptyId, location));
}

function gitStatus(): (...args: unknown[]) => unknown {
  const fn = handlers.get(IPC.GIT_STATUS);
  if (!fn) throw new Error('git:status handler is not registered');
  return fn;
}

/** The one command the handler ran, as `[file, args]`. */
function ranCommand(): [string, string[]] {
  expect(execFileAsync).toHaveBeenCalledTimes(1);
  const [file, args] = execFileAsync.mock.calls[0] as [string, string[]];
  return [file, args];
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(os, 'homedir').mockReturnValue(HOME);
  handlers.clear();
  livePanes.clear();
  execFileAsync.mockReset();
  execFileAsync.mockResolvedValue({ stdout: PORCELAIN, stderr: '' });
  registerToolbarHandlers((location) => livePanes.get(JSON.stringify(location)));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('git:status — through the location execution API', () => {
  it('runs git IN THE GUEST for a WSL pane', async () => {
    const location: SessionLocation = {
      domain: 'wsl', cwd: '/home/me/proj', shell: 'wsl.exe', distro: 'Ubuntu',
    };
    livePane('pty-1', location);

    await expect(gitStatus()(fakeEvent, location)).resolves.toBe(PORCELAIN);
    expect(ranCommand()).toEqual([
      'wsl.exe',
      ['-d', 'Ubuntu', '--cd', '/home/me/proj', '--exec', 'git', 'status', '--porcelain'],
    ]);
  });

  it('refuses a WSL location with no live pane rather than reaching over the share', async () => {
    await expect(gitStatus()(fakeEvent, {
      domain: 'wsl', cwd: '/home/me/proj', shell: 'wsl.exe', distro: 'Ubuntu',
    })).resolves.toBe('');
    expect(execFileAsync).not.toHaveBeenCalled();
  });

  it('refuses a WSL pane that has not resolved its distro, at the shared gate', async () => {
    // The pane is live; the command still cannot be built, because the API
    // will not guess which guest to run in. A handler spelling `wsl.exe -d …`
    // itself has nothing to consult here and would run against `undefined`.
    const location: SessionLocation = { domain: 'wsl', cwd: '/home/me/proj', shell: 'wsl.exe' };
    livePane('pty-1', location);

    await expect(gitStatus()(fakeEvent, location)).resolves.toBe('');
    expect(execFileAsync).not.toHaveBeenCalled();
  });

  it('runs host git in the Windows directory an MSYS location names', async () => {
    await expect(gitStatus()(fakeEvent, {
      domain: 'msys',
      cwd: '/c/dev/proj',
      shell: MSYS_SHELL,
    })).resolves.toBe(PORCELAIN);

    expect(ranCommand()).toEqual(['git', ['status', '--porcelain']]);
    expect(execFileAsync.mock.calls[0][2]).toMatchObject({ cwd: hostCwd });
  });

  it('still accepts a bare host cwd from the toolbar', async () => {
    await expect(gitStatus()(fakeEvent, hostCwd)).resolves.toBe(PORCELAIN);
    expect(ranCommand()).toEqual(['git', ['status', '--porcelain']]);
    expect(execFileAsync.mock.calls[0][2]).toMatchObject({ cwd: hostCwd });
  });

  it('never hands the guest directory to a Windows-side git', async () => {
    const location: SessionLocation = {
      domain: 'wsl', cwd: '/home/me/proj', shell: 'wsl.exe', distro: 'Ubuntu',
    };
    livePane('pty-1', location);
    await gitStatus()(fakeEvent, location);

    const [file, args] = ranCommand();
    const options = execFileAsync.mock.calls[0][2] as { cwd?: string };
    expect(`${file} ${args.join(' ')} ${options?.cwd ?? ''}`)
      .not.toMatch(/wsl\.localhost|wsl\$/i);
    // A guest directory is where the command RUNS, never an argument to a
    // command running somewhere else.
    expect(args).not.toContain('-C');
    expect(options?.cwd).toBeUndefined();
  });

  it('reports no status rather than a partial one when git fails', async () => {
    execFileAsync.mockRejectedValue(
      Object.assign(new Error('not a repository'), { stdout: PORCELAIN, stderr: '', code: 128 }),
    );
    await expect(gitStatus()(fakeEvent, hostCwd)).resolves.toBe('');
  });

  it('keeps refusing a sensitive directory, in every spelling of it', async () => {
    // A credential directory named the way each domain names it. The guest
    // spellings are the ones a raw-cwd check cannot see: they only look like
    // `C:\Users\tester\.ssh` once converted.
    const blocked: Array<string | SessionLocation> = [
      `${HOME}\\.ssh`,
      { domain: 'msys', cwd: '/c/Users/tester/.ssh', shell: MSYS_SHELL },
      { domain: 'wsl', cwd: '/mnt/c/Users/tester/.ssh', shell: 'wsl.exe', distro: 'Ubuntu' },
      { domain: 'wsl', cwd: '/home/me/.aws', shell: 'wsl.exe', distro: 'Ubuntu' },
    ];
    for (const payload of blocked) {
      if (typeof payload !== 'string') livePane('pty-1', payload);
      await expect(gitStatus()(fakeEvent, payload)).resolves.toBe('');
    }
    expect(execFileAsync).not.toHaveBeenCalled();
  });

  it('refuses a path that only reaches a sensitive directory once resolved', async () => {
    // Written around it, and — for a host path, the one domain that has a host
    // answer for `realpath` — linked to it.
    vi.spyOn(fs.promises, 'realpath').mockResolvedValue(`${HOME}\\.ssh` as never);
    await expect(gitStatus()(fakeEvent, `${HOME}\\proj`)).resolves.toBe('');

    vi.spyOn(fs.promises, 'realpath').mockRejectedValue(new Error('ENOENT'));
    const traversal: SessionLocation = {
      domain: 'msys', cwd: '/c/Users/tester/proj/../.ssh', shell: MSYS_SHELL,
    };
    livePane('pty-1', traversal);
    await expect(gitStatus()(fakeEvent, traversal)).resolves.toBe('');

    expect(execFileAsync).not.toHaveBeenCalled();
  });

  it('returns empty for a malformed payload', async () => {
    await expect(gitStatus()(fakeEvent, { domain: 'nope', cwd: '/x', shell: '' })).resolves.toBe('');
    expect(execFileAsync).not.toHaveBeenCalled();
  });
});
