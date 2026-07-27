import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isSensitivePath,
  refusesSensitivePath,
  registerFsHandlers,
  resolveAccessiblePath,
} from '../fs.handler';
import { ipcMain } from 'electron';

vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: vi.fn(),
    handle: vi.fn(),
  },
  BrowserWindow: {
    getFocusedWindow: vi.fn(),
    getAllWindows: vi.fn(() => []),
  },
}));

describe('fs.handler security helpers', () => {
  // Use an OS-native absolute home path. The previous Windows-only hardcode
  // (`path.join('C:', 'Users', 'tester')`) produced "C:/Users/tester" on
  // Unix, which path.resolve treats as a relative segment under cwd. The
  // resulting absolute path no longer prefix-matches `home`, so
  // isSensitivePath returned false and realpath was unexpectedly called.
  const home = process.platform === 'win32'
    ? path.join('C:', 'Users', 'tester')
    : path.join('/home', 'tester');
  let realpathSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    realpathSpy = vi.spyOn(fs.promises, 'realpath');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('treats the daemon auth token path as sensitive', () => {
    expect(isSensitivePath(path.join(home, '.fmux', 'daemon-auth-token'))).toBe(true);
  });

  it.each([
    ['blocked directory', '.ssh', true],
    ['blocked directory descendant', '.ssh/id_rsa', true],
    ['blocked file', '.npmrc', true],
    ['directory prefix neighbor', '.ssh-backup/id_rsa', false],
    ['file prefix neighbor', '.npmrc.old', false],
  ])('applies the same home-relative boundary to host and WSL: %s', (_name, relative, blocked) => {
    const hostPath = path.join(home, ...relative.split('/'));
    const wslPath = `/home/alice/${relative}`;
    const wslLocation = {
      domain: 'wsl' as const,
      cwd: '/home/alice/project',
      shell: 'wsl.exe',
      distro: 'Ubuntu',
    };

    expect(isSensitivePath(hostPath)).toBe(blocked);
    expect(isSensitivePath(wslPath, wslLocation)).toBe(blocked);
    expect(isSensitivePath(
      `\\\\wsl.localhost\\Ubuntu${wslPath.replace(/\//g, '\\')}`,
      wslLocation,
    )).toBe(blocked);
  });

  it('fails closed before conversion for a WSL namespace from another distro', async () => {
    const mismatched = '\\\\wsl.localhost\\Debian\\home\\alice\\.ssh\\id_rsa';
    const convert = vi.fn(() => ({ ok: true as const, path: mismatched }));

    await expect(resolveAccessiblePath(
      mismatched,
      { domain: 'wsl', cwd: '/home/alice/project', shell: 'wsl.exe', distro: 'Ubuntu' },
      convert,
    )).resolves.toBeNull();

    expect(convert).not.toHaveBeenCalled();
    expect(realpathSpy).not.toHaveBeenCalled();
  });

  it('rejects a symlink whose canonical target is sensitive', async () => {
    realpathSpy.mockResolvedValue(path.join(home, '.ssh', 'id_rsa'));

    await expect(resolveAccessiblePath(path.join(home, 'project', 'link-to-secret'))).resolves.toBeNull();
  });

  it('rejects a direct sensitive path before canonical lookup', async () => {
    await expect(resolveAccessiblePath(path.join(home, '.fmux-auth-token'))).resolves.toBeNull();
    expect(realpathSpy).not.toHaveBeenCalled();
  });

  it('returns the canonical path for an allowed target', async () => {
    const canonical = path.join(home, 'project', 'src', 'index.ts');
    realpathSpy.mockResolvedValue(canonical);

    await expect(resolveAccessiblePath(path.join(home, 'project', 'src', '..', 'src', 'index.ts'))).resolves.toBe(canonical);
    // One canonicalisation, and the path returned is the one the gate vetted.
    // Clearing the path and then resolving it again would both waste the
    // syscall and open the window where the second answer is a link the first
    // was not.
    expect(realpathSpy).toHaveBeenCalledTimes(1);
  });

  it('returns null when canonicalization fails', async () => {
    realpathSpy.mockRejectedValue(new Error('ENOENT'));

    await expect(resolveAccessiblePath(path.join(home, 'project', 'missing.txt'))).resolves.toBeNull();
  });

  it('converts a WSL path before canonicalization and security checks', async () => {
    const guestPath = '/home/me/project/src';
    const hostPath = path.join(home, 'converted', 'project', 'src');
    realpathSpy.mockResolvedValue(hostPath);
    const convert = vi.fn(() => ({ ok: true as const, path: hostPath }));

    await expect(resolveAccessiblePath(
      guestPath,
      { domain: 'wsl', cwd: '/home/me/project', shell: 'wsl.exe', distro: 'Ubuntu' },
      convert,
    )).resolves.toBe(hostPath);

    expect(convert).toHaveBeenCalledWith(
      { domain: 'wsl', cwd: '/home/me/project', shell: 'wsl.exe', distro: 'Ubuntu' },
      guestPath,
    );
    expect(realpathSpy).toHaveBeenCalledWith(path.resolve(hostPath));
  });

  it.each([
    '/home/alice/.ssh/id_rsa',
    '/home/alice/.aws/credentials',
    '/root/.gnupg/private-keys-v1.d/key',
    '/root/.fmux/daemon-auth-token',
  ])('rejects a direct WSL home secret before conversion: %s', async (guestPath) => {
    const convert = vi.fn(() => ({
      ok: true as const,
      path: `\\\\wsl.localhost\\Ubuntu${guestPath.replace(/\//g, '\\')}`,
    }));

    await expect(resolveAccessiblePath(
      guestPath,
      { domain: 'wsl', cwd: '/home/alice/project', shell: 'wsl.exe', distro: 'Ubuntu' },
      convert,
    )).resolves.toBeNull();

    expect(convert).not.toHaveBeenCalled();
    expect(realpathSpy).not.toHaveBeenCalled();
  });

  it.each([
    '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.ssh\\id_rsa',
    '\\\\wsl$\\Ubuntu\\root\\.npmrc',
  ])('rejects a canonical WSL home secret reached through a link: %s', async (canonical) => {
    const guestPath = '/home/alice/project/link';
    const accessible = '\\\\wsl.localhost\\Ubuntu\\home\\alice\\project\\link';
    realpathSpy.mockResolvedValue(canonical);

    await expect(resolveAccessiblePath(
      guestPath,
      { domain: 'wsl', cwd: '/home/alice/project', shell: 'wsl.exe', distro: 'Ubuntu' },
      vi.fn(() => ({ ok: true as const, path: accessible })),
    )).resolves.toBeNull();

    // The UNC spelling verbatim: a Windows-shaped path is resolved in its own
    // shape, so this is also what distinguishes the gate from a platform
    // `path.resolve`, which on the POSIX CI legs would prefix it with the cwd.
    expect(realpathSpy).toHaveBeenCalledWith(accessible);
  });

  it('fails softly when WSL conversion requires a missing distro', async () => {
    await expect(resolveAccessiblePath(
      '/home/me/project',
      { domain: 'wsl', cwd: '/home/me/project', shell: 'wsl.exe' },
    )).resolves.toBeNull();
    expect(realpathSpy).not.toHaveBeenCalled();
  });

  it('accepts structured location payloads in file-tree handlers', async () => {
    const hostPath = path.join(home, 'project');
    realpathSpy.mockResolvedValue(hostPath);
    vi.spyOn(fs.promises, 'readdir').mockResolvedValue([] as never);
    registerFsHandlers();
    const calls = vi.mocked(ipcMain.handle).mock.calls;
    const readDir = calls.find(([channel]) => channel === 'fs:read-dir')?.[1];
    expect(readDir).toBeTypeOf('function');

    await expect(readDir!(
      {} as Electron.IpcMainInvokeEvent,
      {
        path: hostPath,
        location: { domain: 'host', cwd: hostPath, shell: 'pwsh.exe' },
      },
    )).resolves.toEqual([]);
    expect(realpathSpy).toHaveBeenCalled();
  });

  // Issue #21: `msys` is a legal wire domain. The handler used to re-declare
  // the SessionLocation contract itself and reject it, so a Git Bash pane got
  // an empty file tree.
  it('accepts an MSYS location and converts its guest path', async () => {
    const converted = 'C:\\dev\\proj';
    realpathSpy.mockResolvedValue(converted);
    vi.spyOn(fs.promises, 'readdir').mockResolvedValue([] as never);
    registerFsHandlers();
    const calls = vi.mocked(ipcMain.handle).mock.calls;
    const readDir = calls.find(([channel]) => channel === 'fs:read-dir')?.[1];
    expect(readDir).toBeTypeOf('function');

    await expect(readDir!(
      {} as Electron.IpcMainInvokeEvent,
      {
        path: '/c/dev/proj',
        location: {
          domain: 'msys',
          cwd: '/c/dev/proj',
          shell: 'C:\\Program Files\\Git\\bin\\bash.exe',
        },
      },
    )).resolves.toEqual([]);
    expect(realpathSpy).toHaveBeenCalledWith(converted);
  });

});

/**
 * The three-pass gate itself, which `fs.readDir` and `git:status` now share.
 * Asserted here on the export rather than through either handler, so the table
 * is the gate's own contract and not one channel's reading of it.
 *
 * Windows spellings and a Windows home throughout: MSYS and WSL locations only
 * exist on Windows, and the passes are string logic, so the table holds on
 * every CI leg.
 */
describe('refusesSensitivePath', () => {
  const HOME = 'C:\\Users\\tester';
  const MSYS_SHELL = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const msys = (cwd: string) => ({ domain: 'msys' as const, cwd, shell: MSYS_SHELL });
  let realpathSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(os, 'homedir').mockReturnValue(HOME);
    realpathSpy = vi.spyOn(fs.promises, 'realpath')
      .mockImplementation(async (target) => target as string) as never;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses the raw guest cwd before any conversion', async () => {
    await expect(refusesSensitivePath(msys('/c/Users/tester/.ssh'))).resolves.toBe(true);
    expect(realpathSpy).not.toHaveBeenCalled();
  });

  it('refuses a path that only collapses into a credential directory once resolved', async () => {
    // `..` is collapsed in the spelling the path is WRITTEN in, not the one the
    // running platform uses: this is a Windows path whichever OS reads it, and
    // a platform `path.resolve` on the POSIX legs would neither collapse the
    // segment nor keep the drive prefix, so nothing would match home.
    await expect(refusesSensitivePath(msys('/c/Users/tester/proj/../.ssh'))).resolves.toBe(true);
  });

  it('refuses a junction whose canonical target is a credential directory', async () => {
    realpathSpy.mockResolvedValue(`${HOME}\\.ssh` as never);
    await expect(refusesSensitivePath(msys('/c/dev/proj'))).resolves.toBe(true);
  });

  it('fails closed on a path it cannot canonicalise', async () => {
    realpathSpy.mockRejectedValue(new Error('ENOENT') as never);
    await expect(refusesSensitivePath(msys('/c/dev/proj'))).resolves.toBe(true);
  });

  it('clears an innocent location', async () => {
    await expect(refusesSensitivePath(msys('/c/dev/proj'))).resolves.toBe(false);
    expect(realpathSpy).toHaveBeenCalledWith('C:\\dev\\proj');
  });

  it('takes the path under test over the location cwd when given one', async () => {
    await expect(
      refusesSensitivePath(msys('/c/dev/proj'), '/c/Users/tester/.aws'),
    ).resolves.toBe(true);
  });

  it('does not refuse a guest path that has no host spelling', async () => {
    // Unconvertible is not sensitive. The raw pass already cleared the cwd, and
    // whether a distro-less WSL location may run anything is the execution
    // API's rule, not this gate's.
    await expect(refusesSensitivePath(
      { domain: 'wsl', cwd: '/home/me/proj', shell: 'wsl.exe' },
    )).resolves.toBe(false);
    expect(realpathSpy).not.toHaveBeenCalled();
  });
});

describe('fs:read-dir through the shared gate', () => {
  const HOME = 'C:\\Users\\tester';

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(os, 'homedir').mockReturnValue(HOME);
    vi.spyOn(fs.promises, 'realpath').mockImplementation(async (t) => t as string);
    vi.spyOn(fs.promises, 'readdir').mockResolvedValue([] as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses an MSYS path that resolves into a credential directory', async () => {
    registerFsHandlers();
    const readDir = vi.mocked(ipcMain.handle).mock.calls
      .find(([channel]) => channel === 'fs:read-dir')?.[1];
    expect(readDir).toBeTypeOf('function');

    await expect(readDir!(
      {} as Electron.IpcMainInvokeEvent,
      {
        path: '/c/Users/tester/proj/../.ssh',
        location: {
          domain: 'msys',
          cwd: '/c/Users/tester/proj',
          shell: 'C:\\Program Files\\Git\\bin\\bash.exe',
        },
      },
    )).resolves.toEqual([]);
    expect(fs.promises.readdir).not.toHaveBeenCalled();
  });
});
