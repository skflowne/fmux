import { describe, it, expect } from 'vitest';
import { buildShimCmd, buildPathEditScript, deriveShimPaths } from '../cliShim';

describe('buildShimCmd', () => {
  it('discovers app-* dynamically, scopes ELECTRON_RUN_AS_NODE, and forwards args + exit code', () => {
    const cmd = buildShimCmd();
    expect(cmd).toContain('setlocal DisableDelayedExpansion');
    expect(cmd).toContain('set "ELECTRON_RUN_AS_NODE=1"');
    // Dynamic discovery: uses %~dp0 relative resolution, not hardcoded version
    expect(cmd).toContain('dir /b /ad /o-d');
    expect(cmd).toContain('%~dp0');
    expect(cmd).toContain('app-*');
    // Forwards args and exit code
    expect(cmd).toContain('%*');
    expect(cmd).toContain('endlocal & exit /b %ERRORLEVEL%');
    // CRLF line endings — cmd.exe is picky about bare LF in some contexts
    expect(cmd.includes('\r\n')).toBe(true);
    // No delayed expansion — a literal `!` in a path must survive
    expect(cmd).not.toContain('enabledelayedexpansion');
    // Full invocation: direct exec (no `call` — it re-expands %/^ in args),
    // exact quoting, and %* forwarding
    expect(cmd).toContain(
      '  "%~dp0..\\%%i\\wmux.exe" "%~dp0..\\%%i\\resources\\cli-bundle\\index.js" %*',
    );
    expect(cmd).not.toContain('call "');
    // No hardcoded version path
    expect(cmd).not.toMatch(/app-\d+(?:\.\d+)+[\\/]/);
  });
});

describe('buildPathEditScript', () => {
  it('add: reads raw (unexpanded) registry value and writes back as ExpandString', () => {
    const script = buildPathEditScript('C:\\Users\\u\\AppData\\Local\\wmux\\bin', 'add');
    // %VAR% entries must NOT be expanded-and-baked-in on rewrite
    expect(script).toContain('DoNotExpandEnvironmentNames');
    // REG_EXPAND_SZ must be preserved (SetEnvironmentVariable demotes to REG_SZ)
    expect(script).toContain('-Type ExpandString');
    // New shells must learn about the change without relogin
    expect(script).toContain('SendMessageTimeout');
    expect(script).toContain("'Environment'");
    // Idempotency: only writes when membership actually changes
    expect(script).toContain('if (-not $hit) { $parts += $bin; $changed = $true }');
    expect(script).toContain('if ($changed) {');
  });

  it('remove: filters only the exact bin entry', () => {
    const script = buildPathEditScript('C:\\wmux\\bin', 'remove');
    expect(script).toContain('if ($hit) {');
    expect(script).toContain('Where-Object');
    expect(script).toContain('-ne $bin');
  });

  it('escapes single quotes in the bin dir for the PowerShell literal', () => {
    const script = buildPathEditScript("C:\\odd'name\\bin", 'add');
    expect(script).toContain("$bin = 'C:\\odd''name\\bin'");
  });

  it('never uses setx or [Environment]::SetEnvironmentVariable', () => {
    for (const op of ['add', 'remove'] as const) {
      const script = buildPathEditScript('C:\\wmux\\bin', op);
      expect(script).not.toContain('setx');
      expect(script).not.toContain('SetEnvironmentVariable');
    }
  });
});

describe('deriveShimPaths', () => {
  it('derives version-independent bin dir + versioned cli-bundle path', () => {
    const { binDir, cliJsPath } = deriveShimPaths(
      'C:\\Users\\u\\AppData\\Local\\wmux\\app-3.2.0\\wmux.exe',
    );
    expect(binDir).toBe('C:\\Users\\u\\AppData\\Local\\wmux\\bin');
    expect(cliJsPath).toBe(
      'C:\\Users\\u\\AppData\\Local\\wmux\\app-3.2.0\\resources\\cli-bundle\\index.js',
    );
  });
});

// ─── darwin CLI shim (P3) ────────────────────────────────────────────────────
// Build a fake app bundle under real tmpdir to verify symlink install and ownership rules.
// Skipped on Windows: production calls this on darwin only (main/index.ts gate); Windows
// needs elevated symlink permission and different path separators — not a validation target.
// Runs on macOS and Linux only (both use POSIX symlinks).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach } from 'vitest';
import { installCliShimDarwin, deriveDarwinCliTarget, darwinShimNeedsRepair } from '../cliShim';

describe.skipIf(process.platform === 'win32')('installCliShimDarwin', () => {
  let tmp: string;
  let execPath: string;
  let target: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-shim-'));
    // Fake app bundle: <tmp>/wmux.app/Contents/{MacOS/wmux, Resources/cli-bundle/index.js}
    const contents = path.join(tmp, 'wmux.app', 'Contents');
    fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
    fs.mkdirSync(path.join(contents, 'Resources', 'cli-bundle'), { recursive: true });
    execPath = path.join(contents, 'MacOS', 'wmux');
    target = path.join(contents, 'Resources', 'cli-bundle', 'index.js');
    fs.writeFileSync(target, '#!/usr/bin/env node\n', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('deriveDarwinCliTarget: MacOS executable → Resources/cli-bundle/index.js', () => {
    expect(deriveDarwinCliTarget(execPath)).toBe(target);
  });

  it('installs to fallback candidate when first fails (permissions) and returns guidance when PATH omits it', () => {
    const fallback = path.join(tmp, 'home', '.local', 'bin', 'wmux');
    // Put first candidate under read-only dir to force failure
    const roDir = path.join(tmp, 'ro');
    fs.mkdirSync(roDir, { recursive: true });
    fs.chmodSync(roDir, 0o500);
    const first = path.join(roDir, 'bin', 'wmux');
    const result = installCliShimDarwin(execPath, {
      homeDir: path.join(tmp, 'home'),
      envPath: '/usr/bin:/bin',
      candidates: [first, fallback],
    });
    fs.chmodSync(roDir, 0o700); // restore permissions for cleanup
    expect(result.status).toBe('installed');
    expect(result.linkPath).toBe(fallback);
    expect(fs.readlinkSync(fallback)).toBe(target);
    expect(result.guidance).toContain(path.dirname(fallback));
  });

  it('never touches foreign existing files (Homebrew etc.)', () => {
    const link = path.join(tmp, 'bin', 'wmux');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.writeFileSync(link, '#!/bin/sh\necho brew\n', 'utf8'); // regular file, not symlink
    const result = installCliShimDarwin(execPath, {
      homeDir: tmp,
      envPath: '/usr/bin',
      candidates: [link],
    });
    expect(result.status).toBe('foreign');
    expect(fs.readFileSync(link, 'utf8')).toContain('echo brew'); // unchanged
  });

  it('skips when symlink is already correct, updates when ours points at old target', () => {
    const link = path.join(tmp, 'bin', 'wmux');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    // "Ours" symlink pointing at old bundle
    const oldTarget = path.join(tmp, 'old.app', 'Contents', 'Resources', 'cli-bundle', 'index.js');
    fs.symlinkSync(oldTarget, link);
    const opts = { homeDir: tmp, envPath: path.dirname(link), candidates: [link] };
    const updated = installCliShimDarwin(execPath, opts);
    expect(updated.status).toBe('installed');
    expect(fs.readlinkSync(link)).toBe(target);
    // Re-run → already correct → skip
    const again = installCliShimDarwin(execPath, opts);
    expect(again.status).toBe('already');
  });

  // issue #505 — the marker must not gate out repair of a stale owned link.
  describe('darwinShimNeedsRepair', () => {
    it('owned link that targets a moved/old bundle needs repair', () => {
      const link = path.join(tmp, 'bin', 'wmux');
      fs.mkdirSync(path.dirname(link), { recursive: true });
      const oldTarget = path.join(tmp, 'old.app', 'Contents', 'Resources', 'cli-bundle', 'index.js');
      fs.symlinkSync(oldTarget, link); // owned shape, but not the current bundle
      expect(darwinShimNeedsRepair(execPath, { homeDir: tmp, candidates: [link] })).toBe(true);
    });

    it('owned link whose target no longer exists (DMG ejected) needs repair', () => {
      const link = path.join(tmp, 'bin', 'wmux');
      fs.mkdirSync(path.dirname(link), { recursive: true });
      // Points at the current-shaped target path, but the file is gone.
      fs.symlinkSync(target, link);
      fs.rmSync(target);
      expect(darwinShimNeedsRepair(execPath, { homeDir: tmp, candidates: [link] })).toBe(true);
    });

    it('correct link needs no repair', () => {
      const link = path.join(tmp, 'bin', 'wmux');
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(target, link);
      expect(darwinShimNeedsRepair(execPath, { homeDir: tmp, candidates: [link] })).toBe(false);
    });

    it('foreign symlink and absent link never need repair', () => {
      const foreign = path.join(tmp, 'bin', 'wmux');
      fs.mkdirSync(path.dirname(foreign), { recursive: true });
      fs.symlinkSync('/opt/homebrew/Cellar/wmux/bin/wmux', foreign); // not owned shape
      const absent = path.join(tmp, 'nope', 'wmux');
      expect(darwinShimNeedsRepair(execPath, { homeDir: tmp, candidates: [foreign, absent] })).toBe(false);
    });
  });
});
