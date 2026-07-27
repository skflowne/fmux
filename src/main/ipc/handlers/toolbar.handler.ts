import { ipcMain, dialog, BrowserWindow } from 'electron';
import { IPC } from '../../../shared/constants';
import { parseSessionLocation, type SessionLocation } from '../../../shared/sessionLocation';
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

export function registerToolbarHandlers(
  findLivePaneTarget: LivePaneTargetResolver = () => undefined,
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
  // sensitive-path refusal, so that check stays here explicitly: `fs.readDir`
  // still declines to list `~/.ssh`, and this channel must not report its
  // contents through git instead.
  ipcMain.removeHandler(IPC.GIT_STATUS);
  ipcMain.handle(IPC.GIT_STATUS, wrapHandler(IPC.GIT_STATUS, async (_event: Electron.IpcMainInvokeEvent, raw: unknown): Promise<string> => {
    const location = parseSessionLocation(raw);
    if (!location) return '';
    if (isSensitivePath(location.cwd, location)) return '';
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
