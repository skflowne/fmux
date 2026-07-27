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

// The shared gate, wrapped so this file can prove the handler REACHES it. A
// local copy that merely agreed on every input would satisfy every behavioural
// spec below; only this spy fails when one is reintroduced.
const { refusesSensitivePathSpy } = vi.hoisted(() => ({ refusesSensitivePathSpy: vi.fn() }));
vi.mock('../fs.handler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../fs.handler')>();
  refusesSensitivePathSpy.mockImplementation(actual.refusesSensitivePath);
  return { ...actual, refusesSensitivePath: refusesSensitivePathSpy };
});

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
import { registerFsHandlers } from '../fs.handler';
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

/** `fs.readDir`, for the specs that pin both call sites against ONE gate. */
function readDir(): (...args: unknown[]) => unknown {
  registerFsHandlers();
  const fn = handlers.get(IPC.FS_READ_DIR);
  if (!fn) throw new Error('fs:read-dir handler is not registered');
  return fn;
}

let realpathSpy: ReturnType<typeof vi.spyOn>;

/** The one command the handler ran, as `[file, args]`. */
function ranCommand(): [string, string[]] {
  expect(execFileAsync).toHaveBeenCalledTimes(1);
  const [file, args] = execFileAsync.mock.calls[0] as [string, string[]];
  return [file, args];
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(os, 'homedir').mockReturnValue(HOME);
  // A directory that exists and is not a link. The canonicalisation pass runs
  // for every domain now, and it fails closed, so without this every happy
  // path below would depend on `C:\dev\proj` existing on the CI box.
  realpathSpy = vi.spyOn(fs.promises, 'realpath')
    .mockImplementation(async (target) => target as string) as never;
  handlers.clear();
  livePanes.clear();
  refusesSensitivePathSpy.mockClear();
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
    // The canonicalisation pass ran here too. Without this the identity mock
    // above would hide a gate that skips it for guests — which is exactly how
    // a guest symlink into `~/.ssh` stayed browsable-refused but git-allowed.
    expect(realpathSpy).toHaveBeenCalledWith('\\\\wsl.localhost\\Ubuntu\\home\\me\\proj');
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

  it('runs MSYS git in the converted directory, not the one it canonicalises to', async () => {
    // The directory git ACTUALLY runs in, which an argv snapshot alone cannot
    // show: `prepareLocationCommand` spells the msys cwd as the converted path,
    // so the gate's canonical path must not leak into the command. With an
    // identity `realpath` the two are indistinguishable — hence a canonical
    // that genuinely differs.
    realpathSpy.mockResolvedValue('C:\\real\\proj' as never);

    await expect(gitStatus()(fakeEvent, {
      domain: 'msys', cwd: '/c/dev/proj', shell: MSYS_SHELL,
    })).resolves.toBe(PORCELAIN);

    const [, args] = ranCommand();
    const options = execFileAsync.mock.calls[0][2] as { cwd?: string };
    expect(options).toMatchObject({ cwd: hostCwd });
    expect(options.cwd).not.toBe('C:\\real\\proj');
    expect(args).not.toContain('-C');
    // Pins that the canonical path was looked up at all: without this the spec
    // also passes against a gate that never canonicalises an MSYS location.
    expect(realpathSpy).toHaveBeenCalledWith(hostCwd);
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
    // Written around it: `..` collapses into the credential directory. The
    // identity `realpath` is deliberate — it keeps this spec pinned on the
    // RESOLVE pass, so it cannot start passing for the canonicalisation pass's
    // reasons (or for the fail-closed catch's).
    const traversal: SessionLocation = {
      domain: 'msys', cwd: '/c/Users/tester/proj/../.ssh', shell: MSYS_SHELL,
    };
    livePane('pty-1', traversal);
    await expect(gitStatus()(fakeEvent, traversal)).resolves.toBe('');

    // And linked to it, which only the canonical path can see.
    realpathSpy.mockResolvedValue(`${HOME}\\.ssh` as never);
    await expect(gitStatus()(fakeEvent, `${HOME}\\proj`)).resolves.toBe('');

    expect(execFileAsync).not.toHaveBeenCalled();
  });

  it('refuses an MSYS junction into a credential directory', async () => {
    // The gap a host-only canonicalisation pass left: `/c/dev/proj` is
    // innocent raw and innocent converted, and the link is a plain Windows
    // junction the host can and does resolve.
    realpathSpy.mockResolvedValue(`${HOME}\\.ssh` as never);
    const junction: SessionLocation = {
      domain: 'msys', cwd: '/c/dev/proj', shell: MSYS_SHELL,
    };
    livePane('pty-1', junction);

    await expect(gitStatus()(fakeEvent, junction)).resolves.toBe('');
    expect(execFileAsync).not.toHaveBeenCalled();
  });

  it('refuses a WSL guest symlink into a credential directory', async () => {
    realpathSpy.mockResolvedValue('\\\\wsl.localhost\\Ubuntu\\home\\me\\.ssh' as never);
    const location: SessionLocation = {
      domain: 'wsl', cwd: '/home/me/proj', shell: 'wsl.exe', distro: 'Ubuntu',
    };
    livePane('pty-1', location);

    await expect(gitStatus()(fakeEvent, location)).resolves.toBe('');
    expect(execFileAsync).not.toHaveBeenCalled();
  });

  it('refuses a path it cannot canonicalise rather than running git in it', async () => {
    // Fail closed, the same answer `fs.readDir` gives: a path the host cannot
    // canonicalise is one nothing cleared, not one nothing objected to.
    realpathSpy.mockRejectedValue(new Error('ENOENT') as never);

    await expect(gitStatus()(fakeEvent, {
      domain: 'msys', cwd: '/c/dev/proj', shell: MSYS_SHELL,
    })).resolves.toBe('');
    expect(execFileAsync).not.toHaveBeenCalled();
  });

  it('leaves an unconvertible guest path to the execution API, not to this gate', async () => {
    // `toHostAccessiblePath` fails for a distro-less WSL location, so there is
    // no host spelling to resolve or canonicalise. That is not a refusal by the
    // gate — the raw pass already cleared the cwd — and the command is refused
    // one layer later, where the missing distro is actually a problem.
    const location: SessionLocation = { domain: 'wsl', cwd: '/home/me/proj', shell: 'wsl.exe' };
    livePane('pty-1', location);

    await expect(gitStatus()(fakeEvent, location)).resolves.toBe('');
    await expect(refusesSensitivePathSpy.mock.results[0].value).resolves.toBe(false);
    expect(realpathSpy).not.toHaveBeenCalled();
    expect(execFileAsync).not.toHaveBeenCalled();
  });

  it('returns empty for a malformed payload', async () => {
    await expect(gitStatus()(fakeEvent, { domain: 'nope', cwd: '/x', shell: '' })).resolves.toBe('');
    expect(execFileAsync).not.toHaveBeenCalled();
  });
});

describe('git:status and fs.readDir — one gate, one verdict', () => {
  it('refuses the same MSYS junction on both channels', async () => {
    // The invariant this gate owns, asserted where it is actually a pair: a
    // path this app refuses to BROWSE is a path it refuses to run git in.
    // Both handlers register into the same map here, so one spec can drive the
    // one location through both under a single `realpath` answer.
    realpathSpy.mockResolvedValue(`${HOME}\\.ssh` as never);
    const location: SessionLocation = {
      domain: 'msys', cwd: '/c/dev/proj', shell: MSYS_SHELL,
    };
    livePane('pty-1', location);

    await expect(readDir()(fakeEvent, { path: location.cwd, location })).resolves.toEqual([]);
    await expect(gitStatus()(fakeEvent, location)).resolves.toBe('');
    expect(execFileAsync).not.toHaveBeenCalled();
  });

  it('reaches that verdict through the shared gate, not a local copy', async () => {
    await gitStatus()(fakeEvent, hostCwd);
    expect(refusesSensitivePathSpy).toHaveBeenCalledWith(
      { domain: 'host', cwd: hostCwd, shell: '' },
    );
  });
});
