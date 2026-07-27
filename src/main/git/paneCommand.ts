import {
  createSessionCommandTarget,
  hostLocation,
  locationIdentity,
  prepareLocationCommand,
  type LocationError,
  type SessionCommandTarget,
  type SessionLocation,
} from '../../shared/sessionLocation';

export type PaneCommandTarget = SessionCommandTarget;

export function paneCommandIdentity(target: PaneCommandTarget): string {
  return locationIdentity(target.location);
}

export function preparePaneCommand(
  target: PaneCommandTarget,
  executable: string,
  args: readonly string[],
): { ok: true; file: string; args: string[]; cwd?: string }
  | { ok: false; error: LocationError } {
  if (
    target.location.domain === 'wsl'
    && (
      !target.activeContext?.active
      || target.activeContext.sessionId !== target.sessionId
    )
  ) {
    return { ok: false, error: 'ACTIVE_CONTEXT_REQUIRED' };
  }
  return prepareLocationCommand(target.location, executable, args, target.activeContext);
}

export function hostCommandTarget(cwd: string): PaneCommandTarget {
  return createSessionCommandTarget(`host:${cwd}`, hostLocation(cwd));
}

/**
 * A target for a location with no live session behind it.
 *
 * Deliberately carries no active context, so the domains that need one — WSL —
 * are refused here rather than starting a distro to answer for a location
 * nothing is running in. Host and MSYS need none and behave as they always do.
 */
export function locationCommandTarget(location: SessionLocation): PaneCommandTarget {
  return { sessionId: `location:${locationIdentity(location)}`, location };
}
