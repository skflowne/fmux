import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerFsHandlers, resolveAccessiblePath } from '../fs.handler';
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

describe('resolveAccessiblePath', () => {
  // An OS-native absolute home path: `path.join('C:', 'Users', 'tester')`
  // produces "C:/Users/tester" on Unix, which `path.resolve` treats as a
  // relative segment under the cwd.
  const home = process.platform === 'win32'
    ? path.join('C:', 'Users', 'tester')
    : path.join('/home', 'tester');
  let realpathSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    realpathSpy = vi.spyOn(fs.promises, 'realpath');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the canonical path for a target that exists', async () => {
    const canonical = path.join(home, 'project', 'src', 'index.ts');
    realpathSpy.mockResolvedValue(canonical);

    await expect(resolveAccessiblePath(path.join(home, 'project', 'src', '..', 'src', 'index.ts'))).resolves.toBe(canonical);
    // One canonicalisation, and the path returned is the one it produced.
    // Resolving a second time would both waste the syscall and open the window
    // where the second answer is a link the first was not.
    expect(realpathSpy).toHaveBeenCalledTimes(1);
  });

  it('returns null when canonicalization fails', async () => {
    realpathSpy.mockRejectedValue(new Error('ENOENT'));

    await expect(resolveAccessiblePath(path.join(home, 'project', 'missing.txt'))).resolves.toBeNull();
  });

  it('converts a WSL path before canonicalization', async () => {
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

  it('canonicalises a WSL UNC path in its own shape, not the running platform\'s', async () => {
    // The UNC spelling verbatim. `resolveInPathShape` picks win32 or posix from
    // how the path is WRITTEN, so this is what distinguishes it from a platform
    // `path.resolve`, which on the POSIX CI legs would prefix it with the cwd.
    const accessible = '\\\\wsl.localhost\\Ubuntu\\home\\alice\\project\\link';
    realpathSpy.mockResolvedValue(accessible);

    await expect(resolveAccessiblePath(
      '/home/alice/project/link',
      { domain: 'wsl', cwd: '/home/alice/project', shell: 'wsl.exe', distro: 'Ubuntu' },
      vi.fn(() => ({ ok: true as const, path: accessible })),
    )).resolves.toBe(accessible);

    expect(realpathSpy).toHaveBeenCalledWith(accessible);
  });

  it('collapses `..` in the spelling the path is written in', async () => {
    // A Windows path whichever OS reads it: a platform `path.resolve` on the
    // POSIX legs would neither collapse the segment nor keep the drive prefix.
    const accessible = 'C:\\Users\\tester\\proj\\..\\other';
    realpathSpy.mockImplementation(async (target: unknown) => target as string);

    await expect(resolveAccessiblePath(
      '/c/Users/tester/proj/../other',
      { domain: 'msys', cwd: '/c/Users/tester/proj', shell: 'C:\\Program Files\\Git\\bin\\bash.exe' },
      vi.fn(() => ({ ok: true as const, path: accessible })),
    )).resolves.toBe('C:\\Users\\tester\\other');
  });

  // A rooted backslash path is Windows-shaped only by virtue of running on
  // Windows — it carries neither a drive letter nor a UNC prefix — so this is
  // the one case the shape sniff alone would get wrong, and the one the
  // platform disjunct exists for. Windows-only by nature: the same string is a
  // legal single-segment filename on Linux.
  it.runIf(process.platform === 'win32')(
    'collapses a rooted backslash path where the host is what makes it Windows-shaped',
    async () => {
      const drive = path.win32.resolve('\\').slice(0, 2);
      realpathSpy.mockImplementation(async (target: unknown) => target as string);

      await expect(resolveAccessiblePath(
        '\\Users\\tester\\proj\\..\\other',
        { domain: 'host', cwd: '\\Users\\tester\\proj', shell: '' },
      )).resolves.toBe(`${drive}\\Users\\tester\\other`);
    },
  );

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
    expect(realpathSpy).toHaveBeenCalledWith(hostPath);
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
 * The cross-distro refusal, which is about WHICH filesystem an answer came
 * from and not about what is stored there — so both cases below use a plainly
 * innocent project directory. A credential path would be refused for a second,
 * independent reason and would not pin this guard at all.
 *
 * Driven through `fs:read-dir` rather than the helper, so the specs fail if the
 * guard exists but nothing calls it. An empty listing is also what a FAILED
 * read returns, so each refusal is pinned on the directory never being opened.
 */
describe('a path in another WSL distribution', () => {
  const UBUNTU = {
    domain: 'wsl' as const,
    cwd: '/home/alice/project',
    shell: 'wsl.exe',
    distro: 'Ubuntu',
  };
  const DEBIAN_PATH = '\\\\wsl.localhost\\Debian\\home\\alice\\project';
  let realpathSpy: ReturnType<typeof vi.spyOn>;
  let readdirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    realpathSpy = vi.spyOn(fs.promises, 'realpath')
      .mockImplementation(async (target) => target as string) as never;
    readdirSpy = vi.spyOn(fs.promises, 'readdir').mockResolvedValue([] as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function readDir(): (...args: unknown[]) => unknown {
    registerFsHandlers();
    const fn = vi.mocked(ipcMain.handle).mock.calls
      .find(([channel]) => channel === 'fs:read-dir')?.[1];
    if (!fn) throw new Error('fs:read-dir handler is not registered');
    return fn as (...args: unknown[]) => unknown;
  }

  it('is refused before conversion when the request names it outright', async () => {
    await expect(readDir()(
      {} as Electron.IpcMainInvokeEvent,
      { path: DEBIAN_PATH, location: UBUNTU },
    )).resolves.toEqual([]);

    expect(readdirSpy).not.toHaveBeenCalled();
    // Load-bearing, not colour: this is the ONLY thing separating this spec
    // from the canonical-pass one below. With `realpath` mocked to identity the
    // canonical here is the Debian path too, so the readdir pin alone would
    // stay green on a build that had lost the raw check entirely.
    expect(realpathSpy).not.toHaveBeenCalled();
  });

  it('is refused before the location is even asked for a host spelling', async () => {
    // The ordering claim the channel cannot make, since it supplies its own
    // conversion: nothing is converted, so the refusal cannot be a side effect
    // of conversion failing.
    const convert = vi.fn(() => ({ ok: true as const, path: DEBIAN_PATH }));

    await expect(resolveAccessiblePath(DEBIAN_PATH, UBUNTU, convert)).resolves.toBeNull();

    expect(convert).not.toHaveBeenCalled();
    expect(realpathSpy).not.toHaveBeenCalled();
  });

  it('is refused at the canonical path when a link reaches it', async () => {
    // Innocent raw and innocent converted: only the canonical pass can see
    // that the directory the pane would be shown lives in another guest.
    realpathSpy.mockResolvedValue(DEBIAN_PATH as never);

    await expect(readDir()(
      {} as Electron.IpcMainInvokeEvent,
      { path: '/home/alice/project', location: UBUNTU },
    )).resolves.toEqual([]);

    expect(realpathSpy).toHaveBeenCalledWith('\\\\wsl.localhost\\Ubuntu\\home\\alice\\project');
    expect(readdirSpy).not.toHaveBeenCalled();
  });
});

/**
 * Issue #48's headline complaint, as a spec: `cd ~/.ssh` in a pane used to
 * render an empty file explorer, indistinguishable from an empty directory,
 * with no error and the terminal an inch away showing the contents.
 *
 * Asserting the entries come back — not merely that the call succeeds — is the
 * point: `[]` is what the old refusal returned, so a spec that only checked for
 * no throw would pass against the blocklist it exists to prove is gone.
 */
describe('fs:read-dir in a credential directory', () => {
  const HOME = 'C:\\Users\\tester';

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(fs.promises, 'realpath').mockImplementation(async (t) => t as string);
    vi.spyOn(fs.promises, 'readdir').mockResolvedValue([
      { name: 'id_rsa', isDirectory: () => false, isSymbolicLink: () => false },
    ] as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists it, at the path the `..` collapsed to', async () => {
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
    )).resolves.toEqual([
      { name: 'id_rsa', path: path.join(`${HOME}\\.ssh`, 'id_rsa'), isDirectory: false, isSymlink: false },
    ]);
    // The converted-and-collapsed spelling, which also re-homes the `..` claim
    // the deleted blocklist specs used to carry.
    expect(fs.promises.readdir).toHaveBeenCalledWith(`${HOME}\\.ssh`, { withFileTypes: true });
  });
});
