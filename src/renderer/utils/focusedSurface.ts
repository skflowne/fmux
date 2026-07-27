import type { Workspace, Surface, PaneLeaf } from '../../shared/types';
import {
  classifySessionLocation,
  locationsEqual,
  parseSessionLocation,
  resolveSessionLocation,
  type SessionLocation,
} from '../../shared/sessionLocation';
import { findActiveLeaf } from './paneTraversal';

export function reuseEquivalentSessionLocation(
  previous: SessionLocation | undefined,
  next: SessionLocation | undefined,
  platform: NodeJS.Platform,
): SessionLocation | undefined {
  return previous && next && locationsEqual(previous, next, platform) ? previous : next;
}

/**
 * Where a surface's CONTENT lives — which machine its file or directory is on.
 * The renderer's ONE surface→location derivation: hand-rolled pane walkers that
 * re-spell `location ?? classify(...)` are how the two owners drifted apart.
 *
 * A stored location is authoritative even when the legacy surface cwd is
 * empty. Surfaces with neither return null.
 *
 * This is NOT "where the user is working" — see `sessionLocationForPane`. For a
 * surface with no pty of its own the two are different facts: an editor's file
 * does not move when its pane's terminal does.
 */
export function sessionLocationForSurface(surface: Surface | undefined): SessionLocation | null {
  if (!surface) return null;
  const stored = parseSessionLocation(surface.location);
  if (stored) return stored;
  if (!surface.cwd) return null;
  return resolveSessionLocation({
    shell: surface.shell,
    cwd: surface.cwd,
  });
}

/**
 * The working location a surface PUBLISHES, which only a terminal has (issue
 * #46). A browser, editor, or diff surface is created with `ptyId: ''`, and
 * `updateSurfaceLocation` keys on the ptyId — so whatever such a surface holds
 * is frozen at creation and structurally cannot follow the pane. Publishing it
 * hands consumers an identity no live pane owns: `git:status` then finds no
 * pane to run in and reports no change badges at all, silently.
 *
 * The predicate is on `surfaceType`, deliberately: a terminal in its reconnect
 * window carries a stored location with no cwd, and must still publish it.
 */
function publishedSessionLocation(surface: Surface | undefined): SessionLocation | null {
  if (!surface) return null;
  if ((surface.surfaceType ?? 'terminal') !== 'terminal') return null;
  return sessionLocationForSurface(surface);
}

/**
 * Where the user is working in a pane — the sole owner of that fact, and the
 * live one: it reads through to whichever terminal surface is publishing now.
 *
 * The pane's active terminal answers when there is one. Otherwise the first
 * terminal in tab order does, which is an arbitrary but deterministic tie-break
 * rather than a claim about which terminal the user meant.
 */
export function sessionLocationForPane(pane: PaneLeaf | null | undefined): SessionLocation | null {
  if (!pane) return null;
  const active = pane.surfaces.find((candidate) => candidate.id === pane.activeSurfaceId);
  const fromActive = publishedSessionLocation(active);
  if (fromActive) return fromActive;
  for (const surface of pane.surfaces) {
    const location = publishedSessionLocation(surface);
    if (location) return location;
  }
  return null;
}

/** Authoritative filesystem location for the active pane, including a
 * classification fallback for sessions persisted before `location`. */
export function activeSessionLocation(workspace: Workspace): SessionLocation | null {
  const leaf = findActiveLeaf(workspace.rootPane, workspace.activePaneId);
  const paneLocation = sessionLocationForPane(leaf);
  if (paneLocation) return paneLocation;
  // Workspace-level fallback, for a workspace whose active pane holds no
  // terminal yet. `WorkspaceProfile.shell` is optional, so retain a usable
  // plain-host cwd without one. A shell-less guest cwd is classified as host
  // here but stays fail-closed at the shared UNRESOLVED_GUEST_PATH guard before
  // main or daemon performs Windows filesystem work.
  const shell = workspace.profile?.shell ?? '';
  const cwd = workspace.metadata?.cwd ?? workspace.profile?.startupCwd;
  if (!cwd) return null;
  return classifySessionLocation(shell, cwd);
}

/**
 * Resolve the ptyId of the focused terminal surface, or null when no terminal
 * is focused (no workspace, non-terminal surface, or unbound ptyId). Toolbar
 * inject actions use null to disable themselves.
 */
export function focusedTerminalPtyId(workspace: Workspace | undefined): string | null {
  if (!workspace) return null;
  const leaf = findActiveLeaf(workspace.rootPane, workspace.activePaneId);
  if (!leaf) return null;
  const surface = leaf.surfaces.find((s) => s.id === leaf.activeSurfaceId);
  if (!surface) return null;
  const type = surface.surfaceType ?? 'terminal';
  if (type !== 'terminal') return null;
  return surface.ptyId ? surface.ptyId : null;
}
