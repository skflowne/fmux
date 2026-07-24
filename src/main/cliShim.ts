/**
 * X4 — `fmux` CLI shim installation (Windows / Squirrel).
 *
 * The packaged app ships the bundled CLI at `<app>/resources/cli-bundle/index.js`.
 * To make `fmux` callable from any shell we drop a tiny `fmux.cmd` shim into
 * `<squirrelRoot>/bin` (a version-independent directory next to Update.exe)
 * and register that directory on the USER Path.
 *
 * Why regenerate on every install/update instead of locating `app-*` at
 * runtime: during `--squirrel-install` / `--squirrel-updated` the running
 * process IS the freshly installed version, so `process.execPath` is the
 * correct absolute target. A static absolute path keeps the shim trivial and
 * avoids fragile `dir /b /o-n` latest-version discovery in batch.
 *
 * PATH editing runs as ONE PowerShell invocation per operation (Squirrel
 * event handlers must not stall on serial spawns) and goes through the raw
 * registry, not [Environment]::Get/SetEnvironmentVariable:
 *   - read with GetValue(..., DoNotExpandEnvironmentNames) so existing
 *     `%VAR%` entries are NOT expanded-and-baked-in on rewrite,
 *   - write with Set-ItemProperty -Type ExpandString so REG_EXPAND_SZ is
 *     preserved (SetEnvironmentVariable demotes to REG_SZ),
 *   - broadcast WM_SETTINGCHANGE so newly opened shells see the change
 *     (a bare registry write never notifies Explorer).
 * `setx` is avoided entirely — it truncates values over 1024 chars.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { PRODUCT_CLI, PRODUCT_SLUG } from '../shared/productIdentity';

/**
 * Batch shim content. Uses `%~dp0` (the shim's own directory, `<squirrelRoot>/bin`)
 * to dynamically discover the latest `app-*` directory at runtime, instead of
 * hardcoding a version-specific path. This survives Squirrel updates even if
 * the `--squirrel-updated` handler fails to regenerate the shim.
 *
 * `dir /b /ad /o-d` lists directories matching `app-*` sorted newest-first
 * (by modification time). The first match is the current version.
 */
export function buildShimCmd(): string {
  return [
    '@echo off',
    // DisableDelayedExpansion explicitly: a parent `cmd /v:on` shell would
    // otherwise be inherited and eat literal `!` in forwarded arguments.
    'setlocal DisableDelayedExpansion',
    'set "ELECTRON_RUN_AS_NODE=1"',
    'for /f "delims=" %%i in (\'dir /b /ad /o-d "%~dp0..\\app-*" 2^>nul\') do (',
    // No `call` — it is only needed for batch files and would re-expand
    // %-sequences and carets in the forwarded arguments.
    `  "%~dp0..\\%%i\\${PRODUCT_SLUG}.exe" "%~dp0..\\%%i\\resources\\cli-bundle\\index.js" %*`,
    `  goto :${PRODUCT_SLUG}_done`,
    ')',
    `echo ${PRODUCT_CLI}: no app directory found in "%~dp0.." >&2`,
    'exit /b 1',
    `:${PRODUCT_SLUG}_done`,
    'endlocal & exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
}

/**
 * One-shot PowerShell script that adds/removes `binDir` on the user Path.
 *
 * The membership test is an exact, case-insensitive string match (PowerShell
 * `-eq` on strings is case-insensitive): install and uninstall always pass
 * the identical literal from deriveShimPaths, so no normalization beyond
 * trailing-separator trim is needed — and entries we did NOT add are passed
 * through byte-for-byte (quotes, `%VAR%` tokens and all).
 */
export function buildPathEditScript(binDir: string, op: 'add' | 'remove'): string {
  const escaped = binDir.replace(/'/g, "''");
  const mutate =
    op === 'add'
      ? `if (-not $hit) { $parts += $bin; $changed = $true }`
      : `if ($hit) { $parts = @($parts | Where-Object { $_.TrimEnd('\\','/') -ne $bin }); $changed = $true }`;
  return [
    `$bin = '${escaped}'.TrimEnd('\\','/')`,
    // Raw (unexpanded) read — keeps %VAR% entries intact across the rewrite.
    `$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)`,
    `$cur = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)`,
    `$parts = @($cur -split ';' | Where-Object { $_.Trim().Length -gt 0 })`,
    `$hit = [bool]($parts | Where-Object { $_.TrimEnd('\\','/') -eq $bin })`,
    `$changed = $false`,
    mutate,
    `if ($changed) {`,
    // ExpandString == REG_EXPAND_SZ — SetEnvironmentVariable would demote to REG_SZ.
    `  Set-ItemProperty -Path 'HKCU:\\Environment' -Name 'Path' -Value ($parts -join ';') -Type ExpandString`,
    // WM_SETTINGCHANGE broadcast so new shells pick the change up without relogin.
    `  $sig = '[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);'`,
    `  $w = Add-Type -MemberDefinition $sig -Name 'Win32SendMessageTimeout' -Namespace 'Fmux' -PassThru`,
    `  [System.UIntPtr]$res = [System.UIntPtr]::Zero`,
    `  $null = $w::SendMessageTimeout([System.IntPtr]0xffff, 0x1A, [System.UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$res)`,
    `}`,
  ].join('\n');
}

function powershellExe(): string {
  return path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

function runPathEdit(binDir: string, op: 'add' | 'remove'): void {
  execFileSync(
    powershellExe(),
    ['-NoProfile', '-NonInteractive', '-Command', buildPathEditScript(binDir, op)],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 },
  );
}

export interface ShimPaths {
  /** Version-independent dir that receives fmux.cmd — `<squirrelRoot>/bin`. */
  binDir: string;
  /** Bundled CLI entry inside the current version's resources. */
  cliJsPath: string;
}

/**
 * Derive shim locations from the current executable (squirrel layout).
 * Uses path.win32 explicitly: the shim is Windows-only (Squirrel), and the
 * POSIX path module would treat a `C:\…` execPath as one relative segment —
 * which is also why the unit test must pass on the macOS/Linux CI baseline.
 */
export function deriveShimPaths(execPath: string): ShimPaths {
  const appDir = path.win32.dirname(execPath); // …\wmux\app-X.Y.Z
  const rootDir = path.win32.resolve(appDir, '..'); // …mux (Update.exe lives here)
  return {
    binDir: path.win32.join(rootDir, 'bin'),
    cliJsPath: path.win32.join(appDir, 'resources', 'cli-bundle', 'index.js'),
  };
}

/**
 * Install/refresh the CLI shim and register the bin dir on the user PATH.
 * Best-effort: callers run this inside Squirrel event handlers where a
 * failure must never block install/update — throws are caught and logged.
 */
export function installCliShim(execPath: string): void {
  try {
    const { binDir, cliJsPath } = deriveShimPaths(execPath);
    if (!fs.existsSync(cliJsPath)) {
      console.warn(`[cliShim] cli-bundle missing at ${cliJsPath} — skipping shim install`);
      return;
    }
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, `${PRODUCT_CLI}.cmd`), buildShimCmd(), 'utf8');
    runPathEdit(binDir, 'add');
  } catch (err) {
    console.warn('[cliShim] shim install failed (non-fatal):', err);
  }
}

// ─── macOS (darwin) CLI shim ─────────────────────────────────────────────────
//
// DMG/ZIP installs have no Squirrel-style install hook, so on first launch we try once to
// symlink `/usr/local/bin/fmux` → <app bundle>/Contents/Resources/cli-bundle/index.js
// (fallback `~/.local/bin/fmux` on permission failure). The cli-bundle entry is an esbuild
// bundle with `#!/usr/bin/env node` shebang, so symlink + exec bit runs directly from shell
// (chmod does not change content hash, so codesign seal stays safe).
//
// Ownership rule: never touch an existing file that is not "ours" (symlink pointing at
// cli-bundle inside a Forge Mux app bundle) — avoids collision with Homebrew cask / upstream
// wmux. If ours but target is an old bundle path, refresh to current target.

/** Result of installCliShimDarwin. guidance is user-facing hint when non-null. */
export interface DarwinShimInstallResult {
  status: 'installed' | 'already' | 'foreign' | 'failed';
  linkPath: string | null;
  guidance: string | null;
}

/** Derive bundle CLI entry from darwin executable path. */
export function deriveDarwinCliTarget(execPath: string): string {
  // <bundle>/Contents/MacOS/fmux → <bundle>/Contents/Resources/cli-bundle/index.js
  const contentsDir = path.posix.resolve(path.posix.dirname(execPath), '..');
  return path.posix.join(contentsDir, 'Resources', 'cli-bundle', 'index.js');
}

/** Whether symlink target is cli-bundle inside a wmux app bundle ("ours"). */
export function isOwnedWmuxTarget(linkTarget: string): boolean {
  return linkTarget.endsWith('/Contents/Resources/cli-bundle/index.js');
}

/**
 * Install darwin CLI symlink. Tries candidate paths in order; permission-class failures
 * (EACCES/EPERM/EROFS/ENOENT) fall back to next candidate. Pure fs ops, never throws —
 * reports via DarwinShimInstallResult.
 */
export function installCliShimDarwin(
  execPath: string = process.execPath,
  opts: { homeDir?: string; envPath?: string; candidates?: string[] } = {},
): DarwinShimInstallResult {
  const homeDir = opts.homeDir ?? (process.env.HOME || '');
  const envPath = opts.envPath ?? (process.env.PATH || '');
  const target = deriveDarwinCliTarget(execPath);

  if (!fs.existsSync(target)) {
    console.warn(`[cliShim] cli-bundle missing at ${target} — skipping darwin shim install`);
    return { status: 'failed', linkPath: null, guidance: null };
  }
  // Ensure exec bit for shebang execution (packaging may drop bits). best-effort.
  try {
    fs.chmodSync(target, 0o755);
  } catch { /* best-effort */ }

  const fallbackDir = path.posix.join(homeDir, '.local', 'bin');
  const candidates = opts.candidates ?? [`/usr/local/bin/${PRODUCT_CLI}`, path.posix.join(fallbackDir, PRODUCT_CLI)];

  for (const linkPath of candidates) {
    // Check existing entry — if not ours, stop immediately on any candidate
    // (Homebrew cask / upstream wmux may already provide a same-named binary).
    let existing: fs.Stats | null = null;
    try {
      existing = fs.lstatSync(linkPath);
    } catch { /* absent — create fresh */ }

    if (existing) {
      if (!existing.isSymbolicLink()) {
        return { status: 'foreign', linkPath, guidance: null };
      }
      let linkTarget = '';
      try {
        linkTarget = fs.readlinkSync(linkPath);
      } catch { /* read failure → treat as foreign */ }
      if (linkTarget === target) {
        return { status: 'already', linkPath, guidance: null };
      }
      if (!isOwnedWmuxTarget(linkTarget)) {
        return { status: 'foreign', linkPath, guidance: null };
      }
      // Ours but points at old bundle — try refresh to current target.
      try {
        fs.unlinkSync(linkPath);
      } catch {
        continue; // no permission → fall back to next candidate
      }
    }

    try {
      fs.mkdirSync(path.posix.dirname(linkPath), { recursive: true });
      fs.symlinkSync(target, linkPath);
    } catch {
      continue; // EACCES/EPERM/EROFS etc. → next candidate
    }

    // Return guidance when fallback dir is not on PATH.
    const linkDir = path.posix.dirname(linkPath);
    const onPath = envPath
      .split(':')
      .some((p) => p.replace(/\/+$/, '') === linkDir);
    const guidance = onPath
      ? null
      : `${PRODUCT_CLI} CLI installed at ${linkPath}, but ${linkDir} is not on your PATH. ` +
        `Add it with: echo 'export PATH="${linkDir}:$PATH"' >> ~/.zshrc`;
    return { status: 'installed', linkPath, guidance };
  }

  return { status: 'failed', linkPath: null, guidance: null };
}

/**
 * Whether a wmux-OWNED darwin shim exists but no longer targets the current
 * bundle — a stale target (app moved) or a target that no longer exists on disk
 * (DMG ejected). Used so the one-time install marker does not gate out repair:
 * the first packaged launch can happen from a DMG/ZIP temp path, and once that
 * volume is gone the owned symlink points at a dead file forever otherwise.
 *
 * Returns false for a correct link (no repair), for foreign links/files (never
 * touch a Homebrew cask etc.), and when no candidate link exists (respect the
 * one-time-attempt intent for failed/absent installs). Pure fs, no throw.
 */
export function darwinShimNeedsRepair(
  execPath: string = process.execPath,
  opts: { homeDir?: string; candidates?: string[] } = {},
): boolean {
  const homeDir = opts.homeDir ?? (process.env.HOME || '');
  const target = deriveDarwinCliTarget(execPath);
  const fallbackDir = path.posix.join(homeDir, '.local', 'bin');
  const candidates = opts.candidates ?? [`/usr/local/bin/${PRODUCT_CLI}`, path.posix.join(fallbackDir, PRODUCT_CLI)];

  for (const linkPath of candidates) {
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(linkPath);
    } catch {
      continue; // absent — respect one-time-attempt intent, no repair
    }
    if (!st.isSymbolicLink()) continue; // foreign real file — leave it
    let linkTarget = '';
    try {
      linkTarget = fs.readlinkSync(linkPath);
    } catch {
      continue;
    }
    if (!isOwnedWmuxTarget(linkTarget)) continue; // foreign symlink — leave it
    // Owned link: repair if it points somewhere other than the current bundle,
    // or if its target no longer exists on disk.
    if (linkTarget !== target || !fs.existsSync(linkTarget)) return true;
  }
  return false;
}

/** Remove the shim and strip the bin dir from the user PATH. Best-effort. */
export function uninstallCliShim(execPath: string): void {
  try {
    const { binDir } = deriveShimPaths(execPath);
    try {
      fs.rmSync(binDir, { recursive: true, force: true });
    } catch { /* best-effort */ }
    runPathEdit(binDir, 'remove');
  } catch (err) {
    console.warn('[cliShim] shim uninstall failed (non-fatal):', err);
  }
}
