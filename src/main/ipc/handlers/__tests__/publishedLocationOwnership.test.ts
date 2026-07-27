import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  updateCwd,
  updatePaneLocation,
  removePaneLocation,
  removeCwd,
  findPaneCommandTargetForLocation,
} from '../metadata.handler';
import { activeSessionLocation } from '../../../../renderer/utils/focusedSurface';
import type { Workspace } from '../../../../shared/types';

/**
 * Issue #46 — the contract between the two sides of a location.
 *
 * The renderer publishes "where the user is working" (`activeSessionLocation`);
 * main answers "which live pane is that" by exact `locationIdentity` match
 * (`findPaneCommandTargetForLocation`). Since #30 routed `git:status` through
 * the shared execution API, a published location that no live pane owns is
 * refused — silently, as no change badges at all.
 *
 * The renderer suite can only assert the SHAPE of what it publishes. This
 * asserts it in the terms main actually matches on, which is the half that
 * broke: a non-terminal surface froze its location at creation, so a pane that
 * had since `cd`'d away published an identity nothing owned.
 *
 * `focusedSurface` is pure (shared types + `paneTraversal`), so importing it
 * here costs nothing at runtime.
 */

vi.mock('electron', () => ({
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() },
  BrowserWindow: {},
}));

// Keep module import from reaching git / gh subprocesses.
vi.mock('../../../metadata/MetadataCollector', () => ({
  MetadataCollector: class {
    async getGitBranch(): Promise<string | null> { return null; }
  },
}));
vi.mock('../../../metadata/PrStatusCache', () => ({
  prStatusCache: { get: vi.fn(async () => null) },
}));

const { resolveWslDistro } = vi.hoisted(() => ({
  resolveWslDistro: vi.fn<(ctx: { shell: string }) => Promise<string | undefined>>(),
}));
vi.mock('../../../pty/wslDistro', () => ({ resolveWslDistro }));

const PTY_ID = 'pty-published-owner';

function reset(): void {
  removeCwd(PTY_ID);
  removePaneLocation(PTY_ID);
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

beforeEach(() => {
  // `getPaneCommandTarget` reclassifies through `classifySessionLocation`,
  // which reads the platform.
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  resolveWslDistro.mockReset();
  resolveWslDistro.mockResolvedValue(undefined);
  reset();
});

afterEach(() => {
  reset();
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
});

/** A WSL pane that has moved, with a file open from where it used to be. */
function workspaceWithStaleEditor(): Workspace {
  return {
    id: 'ws-1',
    name: 'Alpha',
    metadata: { cwd: 'C:\\dev\\mirror' },
    rootPane: {
      id: 'pane-1',
      type: 'leaf',
      surfaces: [
        {
          id: 'surface-term',
          ptyId: PTY_ID,
          shell: 'wsl.exe',
          cwd: '/home/me/proj/packages/api',
          location: {
            domain: 'wsl',
            cwd: '/home/me/proj/packages/api',
            shell: 'wsl.exe',
            distro: 'Ubuntu',
          },
        },
        {
          id: 'surface-editor',
          ptyId: '',
          shell: '',
          cwd: '',
          surfaceType: 'editor',
          editorFilePath: '/home/me/proj/a.ts',
          location: {
            domain: 'wsl',
            cwd: '/home/me/proj',
            shell: 'wsl.exe',
            distro: 'Ubuntu',
          },
        },
      ],
      activeSurfaceId: 'surface-editor',
    },
    activePaneId: 'pane-1',
  } as unknown as Workspace;
}

describe('issue #46 — what the renderer publishes is a location main can match', () => {
  it('reaches the live pane while a stale editor surface is active', () => {
    updatePaneLocation(PTY_ID, {
      domain: 'wsl', cwd: '/home/me/proj', shell: 'wsl.exe', distro: 'Ubuntu',
    });
    updateCwd(PTY_ID, '/home/me/proj');

    // Control: the pane is registered and reachable where it started, so a
    // miss below is the published location's fault and not the fixture's.
    expect(findPaneCommandTargetForLocation({
      domain: 'wsl', cwd: '/home/me/proj', shell: 'wsl.exe', distro: 'Ubuntu',
    })?.sessionId).toBe(PTY_ID);

    // The agent in the terminal moves; the editor's snapshot cannot follow.
    updateCwd(PTY_ID, '/home/me/proj/packages/api');

    // The fixture is only a drift scenario while the editor's frozen location
    // is one no live pane owns. Without this the test would keep passing after
    // someone edited the fixture into agreement, proving nothing.
    expect(findPaneCommandTargetForLocation({
      domain: 'wsl', cwd: '/home/me/proj', shell: 'wsl.exe', distro: 'Ubuntu',
    })).toBeUndefined();

    const published = activeSessionLocation(workspaceWithStaleEditor())!;
    expect(published).toBeTruthy();
    expect(findPaneCommandTargetForLocation(published)?.sessionId).toBe(PTY_ID);
  });
});
