import { ipcMain, dialog, BrowserWindow } from 'electron';
import path from 'node:path';
import { IPC } from '../../../shared/constants';
import {
  parseSessionLocation,
  toHostAccessiblePath,
  type SessionLocation,
} from '../../../shared/sessionLocation';
import { wrapHandler } from '../wrapHandler';
import { git } from '../../git/git';
import { locationCommandTarget, type PaneCommandTarget } from '../../git/paneCommand';
import { isSensitivePath } from './fs.handler';

/** The live pane behind a location, when one exists — see metadata.handler's
 *  `findPaneCommandTargetForLocation`. Injected so this handler does not import
 *  the pane registry (and its PTY/metadata graph) to answer one channel. */
export type LivePaneTargetResolver = (
  location: SessionLocation,
) => PaneCommandTarget | undefined;

/**
 * The refusal `resolveAccessiblePath` used to carry into this channel.
 *
 * It checked the path at each spelling it passed through, and the raw guest cwd
 * is the one spelling that hides a credential directory: `/c/Users/me/.ssh` and
 * `/mnt/c/Users/me/.ssh` are only recognisable once converted to their Windows
 * form. So this checks the location as given AND as the host sees it — one
 * narrowing accepted with issue #30: the old third check ran on the `realpath`
 * of the converted path, which a guest path has no host answer for, so a symlink
 * into a blocked directory is no longer caught here.
 */
function refusesSensitivePath(location: SessionLocation): boolean {
  if (isSensitivePath(location.cwd, location)) return true;
  const accessible = toHostAccessiblePath(location, location.cwd);
  return accessible.ok && isSensitivePath(path.resolve(accessible.path), location);
}

export function registerToolbarHandlers(
  findLivePaneTarget: LivePaneTargetResolver,
): () => void {
  // The payload is a pane location (issue #21 AC 1): the toolbar's file explorer
  // invokes this with the pane's own cwd, which on Windows may be a Git Bash
  // `/c/...` or WSL `/home/...` path. `parseSessionLocation` accepts either a
  // structured location or a bare cwd string (a host location).
  //
  // From there the command goes through the shared execution API like every
  // other git call site (issue #30) — `git()` prepares it for the location's own
  // domain, so a WSL repo's status is produced by git IN THE GUEST rather than by
  // Windows git walking the 9p share. That needs the live pane behind the
  // location, because the active-session context the API demands for a guest is
  // the pane's; a location no pane is running in is refused there.
  //
  // The one thing lost with the old `resolveAccessiblePath` conversion is its
  // sensitive-path refusal, so that check stays here explicitly (see
  // `refusesSensitivePath`): `fs.readDir` still declines to list `~/.ssh`, and
  // this channel must not report its contents through git instead.
  ipcMain.removeHandler(IPC.GIT_STATUS);
  ipcMain.handle(IPC.GIT_STATUS, wrapHandler(IPC.GIT_STATUS, async (_event: Electron.IpcMainInvokeEvent, raw: unknown): Promise<string> => {
    const location = parseSessionLocation(raw);
    if (!location) return '';
    if (refusesSensitivePath(location)) return '';
    const target = findLivePaneTarget(location) ?? locationCommandTarget(location);
    const result = await git(['status', '--porcelain'], target);
    // Fail-soft, as the renderer expects: any refusal or git error is "no
    // badges", never a partial listing. Renderer parses with
    // shared/gitStatus.parsePorcelain.
    return result.code === 0 ? result.stdout : '';
  }));

  ipcMain.removeHandler(IPC.DIALOG_PICK_FILE);
  ipcMain.handle(IPC.DIALOG_PICK_FILE, wrapHandler(IPC.DIALOG_PICK_FILE, async (event: Electron.IpcMainInvokeEvent): Promise<string[]> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const opts = { properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'> };
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (result.canceled) return [];
    return result.filePaths;
  }));

  ipcMain.removeHandler(IPC.DIALOG_PICK_FOLDER);
  ipcMain.handle(IPC.DIALOG_PICK_FOLDER, wrapHandler(IPC.DIALOG_PICK_FOLDER, async (event: Electron.IpcMainInvokeEvent): Promise<string[]> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const opts = { properties: ['openDirectory'] as Array<'openDirectory'> };
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (result.canceled) return [];
    return result.filePaths;
  }));

  return () => {
    ipcMain.removeHandler(IPC.GIT_STATUS);
    ipcMain.removeHandler(IPC.DIALOG_PICK_FILE);
    ipcMain.removeHandler(IPC.DIALOG_PICK_FOLDER);
  };
}
