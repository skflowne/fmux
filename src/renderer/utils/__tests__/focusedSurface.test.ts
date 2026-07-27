import { describe, it, expect } from 'vitest';
import {
  activeSessionLocation,
  focusedTerminalPtyId,
  reuseEquivalentSessionLocation,
  sessionLocationForSurface,
} from '../focusedSurface';
import type { Workspace } from '../../../shared/types';

function leaf(id: string, surfaces: any[], activeSurfaceId: string) {
  return { id, type: 'leaf', surfaces, activeSurfaceId } as any;
}

function ws(rootPane: any, activePaneId: string): Workspace {
  return { id: 'w1', name: 'w', rootPane, activePaneId } as any;
}

describe('focusedTerminalPtyId', () => {
  it('returns the active terminal surface ptyId', () => {
    const root = leaf('p1', [{ id: 's1', ptyId: 'pty-1', surfaceType: 'terminal' }], 's1');
    expect(focusedTerminalPtyId(ws(root, 'p1'))).toBe('pty-1');
  });

  it('treats missing surfaceType as terminal', () => {
    const root = leaf('p1', [{ id: 's1', ptyId: 'pty-9' }], 's1');
    expect(focusedTerminalPtyId(ws(root, 'p1'))).toBe('pty-9');
  });

  it('returns null when the active surface is a browser/editor', () => {
    const root = leaf('p1', [{ id: 's1', ptyId: '', surfaceType: 'browser' }], 's1');
    expect(focusedTerminalPtyId(ws(root, 'p1'))).toBeNull();
  });

  it('descends a branch tree to the active leaf', () => {
    const child = leaf('p2', [{ id: 's2', ptyId: 'pty-2', surfaceType: 'terminal' }], 's2');
    const root = { id: 'b', type: 'branch', children: [child] } as any;
    expect(focusedTerminalPtyId(ws(root, 'p2'))).toBe('pty-2');
  });

  it('returns null for undefined workspace or empty ptyId', () => {
    expect(focusedTerminalPtyId(undefined)).toBeNull();
    const root = leaf('p1', [{ id: 's1', ptyId: '', surfaceType: 'terminal' }], 's1');
    expect(focusedTerminalPtyId(ws(root, 'p1'))).toBeNull();
  });
});

describe('activeSessionLocation', () => {
  it('uses the authoritative stored WSL location', () => {
    const location = {
      domain: 'wsl' as const,
      cwd: '/home/me/project',
      shell: 'wsl.exe',
      distro: 'Ubuntu',
    };
    const root = leaf('p1', [{
      id: 's1',
      ptyId: 'pty-1',
      cwd: '/home/me/project',
      shell: 'wsl.exe',
      location,
    }], 's1');

    expect(activeSessionLocation(ws(root, 'p1'))).toBe(location);
  });

  it('uses an authoritative stored location before requiring a legacy cwd', () => {
    const location = {
      domain: 'wsl' as const,
      cwd: '/home/me/project',
      shell: 'wsl.exe',
      distro: 'Ubuntu',
    };
    const root = leaf('p1', [{
      id: 's1',
      ptyId: 'pty-1',
      cwd: '',
      shell: '',
      location,
    }], 's1');

    expect(activeSessionLocation(ws(root, 'p1'))).toBe(location);
  });

  it('classifies a legacy surface without a persisted location', () => {
    const root = leaf('p1', [{
      id: 's1',
      ptyId: 'pty-1',
      cwd: 'C:\\dev\\fmux',
      shell: 'pwsh.exe',
    }], 's1');

    expect(activeSessionLocation(ws(root, 'p1'))).toEqual({
      domain: 'host',
      cwd: 'C:\\dev\\fmux',
      shell: 'pwsh.exe',
    });
  });

  // Issue #46 — a surface with no pty of its own publishes no working location.
  // An editor/diff/browser surface cannot be told where its pane has moved to
  // (`updateSurfaceLocation` keys on ptyId, and theirs is ''), so anything it
  // holds is a snapshot of the moment it was opened. The pane's live terminal
  // is the one owner of "where the user is working".
  it('publishes the pane terminal LIVE location, not the active editor snapshot', () => {
    const live = {
      domain: 'wsl' as const,
      cwd: '/home/me/proj/packages/api',
      shell: 'wsl.exe',
      distro: 'Ubuntu',
    };
    const root = leaf('p1', [
      { id: 's1', ptyId: 'pty-1', cwd: live.cwd, shell: 'wsl.exe', location: live },
      {
        id: 's2',
        ptyId: '',
        cwd: '',
        shell: '',
        surfaceType: 'editor',
        editorFilePath: '/home/me/proj/a.ts',
        // Frozen when the file was opened, before the terminal moved.
        location: { domain: 'wsl', cwd: '/home/me/proj', shell: 'wsl.exe', distro: 'Ubuntu' },
      },
    ], 's2');

    const published = activeSessionLocation(ws(root, 'p1'));
    expect(published).toEqual(live);
    // The distro has to survive: `findPaneCommandTargetForLocation` folds it
    // into the identity it matches on, and loses on a mismatch.
    expect(published).toMatchObject({ distro: 'Ubuntu' });
    // By reference — FileExplorerPopover and EditorPanel key effects on the
    // identity of this object, so minting a fresh one per call re-fires them.
    expect(published).toBe(live);
  });

  it.each(['editor', 'diff', 'browser'] as const)(
    'resolves a pane whose active surface is a %s from the pane terminal',
    (surfaceType) => {
      const live = {
        domain: 'wsl' as const,
        cwd: '/home/me/proj',
        shell: 'wsl.exe',
        distro: 'Ubuntu',
      };
      const workspace = {
        ...ws(leaf('p1', [
          { id: 's1', ptyId: 'pty-1', cwd: live.cwd, shell: 'wsl.exe', location: live },
          { id: 's2', ptyId: '', cwd: '', shell: '', surfaceType },
        ], 's2'), 'p1'),
        // The host mirror path a workspace fallback would wrongly hand back.
        metadata: { cwd: 'C:\\dev\\mirror' },
      } as Workspace;

      expect(activeSessionLocation(workspace)).toBe(live);
    },
  );

  it('falls back to the workspace when the pane holds no terminal at all', () => {
    const workspace = {
      ...ws(leaf('p1', [
        { id: 's1', ptyId: '', cwd: '', shell: '', surfaceType: 'editor' },
      ], 's1'), 'p1'),
      metadata: { cwd: '/home/me/proj' },
      profile: { shell: 'wsl.exe' },
    } as Workspace;

    expect(activeSessionLocation(workspace)).toEqual({
      domain: 'wsl',
      cwd: '/home/me/proj',
      shell: 'wsl.exe',
    });
  });

  it('prefers the pane active terminal over its siblings', () => {
    const first = { domain: 'host' as const, cwd: 'C:\\dev\\first', shell: 'pwsh.exe' };
    const active = { domain: 'host' as const, cwd: 'C:\\dev\\active', shell: 'pwsh.exe' };
    const root = leaf('p1', [
      { id: 's1', ptyId: 'pty-1', cwd: first.cwd, shell: 'pwsh.exe', location: first },
      { id: 's2', ptyId: 'pty-2', cwd: active.cwd, shell: 'pwsh.exe', location: active },
    ], 's2');

    expect(activeSessionLocation(ws(root, 'p1'))).toBe(active);
  });

  // Tab order is an arbitrary but DETERMINISTIC tie-break, not a claim about
  // which terminal the user meant. Nothing in issue #46 requires this order —
  // it exists so two panes with the same tabs never disagree.
  it('takes the first terminal in tab order when the active surface is not one', () => {
    const first = { domain: 'host' as const, cwd: 'C:\\dev\\first', shell: 'pwsh.exe' };
    const second = { domain: 'host' as const, cwd: 'C:\\dev\\second', shell: 'pwsh.exe' };
    const root = leaf('p1', [
      { id: 's1', ptyId: 'pty-1', cwd: first.cwd, shell: 'pwsh.exe', location: first },
      { id: 's2', ptyId: 'pty-2', cwd: second.cwd, shell: 'pwsh.exe', location: second },
      { id: 's3', ptyId: '', cwd: '', shell: '', surfaceType: 'editor' },
    ], 's3');

    expect(activeSessionLocation(ws(root, 'p1'))).toBe(first);
  });

  // A terminal in its reconnect window has no cwd but keeps its stored
  // location, and a stored location is authoritative — so it publishes ahead
  // of a live sibling. Stated rather than incidental: the walk this replaced
  // selected on a non-empty cwd and would have skipped it.
  it('lets a reconnecting terminal publish ahead of a live sibling', () => {
    const reconnecting = { domain: 'wsl' as const, cwd: '/home/me/proj', shell: 'wsl.exe' };
    const live = { domain: 'wsl' as const, cwd: '/home/me/other', shell: 'wsl.exe' };
    const root = leaf('p1', [
      { id: 's1', ptyId: 'pty-1', cwd: '', shell: '', location: reconnecting },
      { id: 's2', ptyId: 'pty-2', cwd: live.cwd, shell: 'wsl.exe', location: live },
      { id: 's3', ptyId: '', cwd: '', shell: '', surfaceType: 'editor' },
    ], 's3');

    expect(activeSessionLocation(ws(root, 'p1'))).toBe(reconnecting);
  });

  it('classifies the workspace fallback with the profile shell', () => {
    const workspace = {
      ...ws(leaf('p1', [], ''), 'p1'),
      metadata: { cwd: '/home/me/proj' },
      profile: { shell: 'wsl.exe' },
    } as Workspace;

    expect(activeSessionLocation(workspace)).toEqual({
      domain: 'wsl',
      cwd: '/home/me/proj',
      shell: 'wsl.exe',
    });
  });

  it('keeps a plain Windows host cwd when no profile shell is configured', () => {
    const workspace = {
      ...ws(leaf('p1', [], ''), 'p1'),
      metadata: { cwd: 'C:\\dev\\fmux' },
      profile: {},
    } as Workspace;

    expect(activeSessionLocation(workspace)).toEqual({
      domain: 'host',
      cwd: 'C:\\dev\\fmux',
      shell: '',
    });
  });
});

// The OTHER door onto `Surface.location`, and the reason there are two (issue
// #46). `activeSessionLocation` above answers "where is the user working" and
// must ignore an editor entirely; this one answers "which machine is this
// surface's content on" and must still hand back the editor's own frozen value
// — that is what `fs.readFile` translates the file's absolute path with.
// Collapsing these two into one function is what put a snapshot on the wire.
describe('sessionLocationForSurface — where a surface CONTENT lives', () => {
  it('keeps an editor surface own frozen location', () => {
    const stored = {
      domain: 'wsl' as const,
      cwd: '/home/me/proj',
      shell: 'wsl.exe',
      distro: 'Ubuntu',
    };
    const editor = {
      id: 's1',
      ptyId: '',
      cwd: '',
      shell: '',
      surfaceType: 'editor',
      editorFilePath: '/home/me/proj/a.ts',
      location: stored,
    } as any;

    expect(sessionLocationForSurface(editor)).toBe(stored);
  });
});

describe('reuseEquivalentSessionLocation', () => {
  const upper = { domain: 'host' as const, cwd: '/Users/Me/Repo', shell: 'zsh' };
  const lower = { domain: 'host' as const, cwd: '/users/me/repo', shell: 'zsh' };

  it('reuses the previous reference on case-insensitive renderer platforms', () => {
    expect(reuseEquivalentSessionLocation(upper, lower, 'darwin')).toBe(upper);
    const windows = { domain: 'host' as const, cwd: 'C:\\Repo\\', shell: 'pwsh.exe' };
    expect(reuseEquivalentSessionLocation(
      windows,
      { ...windows, cwd: 'c:/repo' },
      'win32',
    )).toBe(windows);
  });

  it('keeps a new reference on case-sensitive renderer platforms', () => {
    expect(reuseEquivalentSessionLocation(upper, lower, 'linux')).toBe(lower);
  });
});
