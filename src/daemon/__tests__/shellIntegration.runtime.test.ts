/**
 * Runtime integration tests for OSC 133 shell integration.
 *
 * Unlike DaemonSessionManager.test.ts (which mocks node-pty), this suite
 * spawns real ConPTY / Git Bash processes to verify the end-to-end flow:
 *
 *   shell init → OSC 133 markers → OscParser → PromptEventLog
 *
 * Skipped when the shell is unavailable so the suite degrades cleanly on
 * Linux CI runners where only one of pwsh/bash exists.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ManagedSession } from '../DaemonSessionManager';
import { DaemonSessionManager } from '../DaemonSessionManager';
import type { PromptEvent } from '../PromptEventLog';

const SYS = process.env.SystemRoot || 'C:\\Windows';
const PF = process.env.ProgramFiles || 'C:\\Program Files';

const POWERSHELL = `${SYS}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const CMD_EXE = `${SYS}\\System32\\cmd.exe`;
const GIT_BASH = `${PF}\\Git\\bin\\bash.exe`;
const WSL_EXE = `${SYS}\\System32\\wsl.exe`;

const hasPowerShell = process.platform === 'win32' && fs.existsSync(POWERSHELL);
const hasGitBash = process.platform === 'win32' && fs.existsSync(GIT_BASH);

function probeWslBash(): boolean {
  if (process.platform !== 'win32' || !fs.existsSync(WSL_EXE)) return false;
  try {
    const probe = spawnSync(
      WSL_EXE,
      ['--exec', 'sh', '-lc', 'test "$(basename "$SHELL")" = bash && command -v bash >/dev/null'],
      { timeout: 8_000, windowsHide: true, stdio: 'ignore' },
    );
    return probe.status === 0 && !probe.error;
  } catch {
    return false;
  }
}

// Probe once at collection time. Machines without WSL, a default distro, or
// Bash skip cleanly instead of turning an optional runtime test into a hang.
const hasWslBash = probeWslBash();

// Allow ConPTY boot + prompt render + command echo round trip. Generous
// because a loaded GitHub Windows runner can be slow to cold-start
// powershell.exe and flush its first OSC 133 markers — at 8s this test
// intermittently timed out with "captured after baseline: []" (nothing
// emitted yet), a pure runner-speed flake, not a real regression. The happy
// path still resolves the instant the event arrives, so the higher ceiling
// only costs wall-clock on genuine failures.
const EVENT_TIMEOUT_MS = 30000;
const WSL_EVENT_TIMEOUT_MS = 12000;

/**
 * Wait for a PromptEvent that was recorded AFTER `baselineLength` events.
 * Using the baseline avoids matching stale initial markers (e.g. the D;0
 * from a fresh prompt render before the test's command was even issued).
 */
function waitForEventAfter(
  managed: ManagedSession,
  baselineLength: number,
  predicate: (e: PromptEvent) => boolean,
  label: string,
  timeoutMs = EVENT_TIMEOUT_MS,
): Promise<PromptEvent> {
  // Check already-captured events past the baseline first.
  const snap = managed.promptLog.snapshot();
  const existing = snap.slice(baselineLength).find(predicate);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      managed.bridge.off('prompt', onPrompt);
      const captured = managed.promptLog
        .snapshot()
        .slice(baselineLength)
        .map((e) => `${e.type}${e.exitCode !== undefined ? `(${e.exitCode})` : ''}`)
        .join(',');
      reject(
        new Error(
          `timed out waiting for ${label} — captured after baseline: [${captured}]`,
        ),
      );
    }, timeoutMs);

    const onPrompt = (payload: { sessionId: string; event: PromptEvent }) => {
      if (predicate(payload.event)) {
        clearTimeout(timer);
        managed.bridge.off('prompt', onPrompt);
        resolve(payload.event);
      }
    };
    managed.bridge.on('prompt', onPrompt);
  });
}

describe.runIf(hasPowerShell)('OSC 133 runtime — powershell.exe', () => {
  let manager: DaemonSessionManager;

  afterEach(() => {
    if (manager) manager.disposeAll();
  });

  it('captures command_start / command_end with exitCode 0 when echo is run', async () => {
    manager = new DaemonSessionManager();
    const id = `rt-pwsh-${Date.now()}`;
    manager.createSession({
      id,
      cmd: POWERSHELL,
      cwd: path.resolve(process.cwd()),
    });

    const managed = manager.getSession(id)!;
    const baseline = managed.promptLog.size;

    // PowerShell 5.1 with -NoExit + PSReadLine renders its first prompt
    // lazily — waiting for an initial marker would hang. Writing directly
    // is fine: the init script has already defined prompt + registered
    // the PSReadLine Enter hook before the REPL loop starts.
    managed.ptyProcess.write('echo wmux-osc-probe\r');

    const cmdStart = await waitForEventAfter(
      managed,
      baseline,
      (e) => e.type === 'command_start',
      'command_start',
    );
    expect(cmdStart.byteOffset).toBeGreaterThan(0);

    const cmdEnd = await waitForEventAfter(
      managed,
      baseline,
      (e) => e.type === 'command_end' && e.byteOffset >= cmdStart.byteOffset,
      'command_end after command_start',
    );
    expect(cmdEnd.exitCode).toBe(0);
    expect(cmdEnd.byteOffset).toBeGreaterThanOrEqual(cmdStart.byteOffset);

    const range = managed.promptLog.lastCompletedCommandRange();
    expect(range).not.toBeNull();
    expect(range!.exitCode).toBe(0);
    expect(range!.endOffset).toBeGreaterThanOrEqual(range!.startOffset);
  }, EVENT_TIMEOUT_MS + 2000);

  it('records a non-zero exit code when the command fails', async () => {
    manager = new DaemonSessionManager();
    const id = `rt-pwsh-fail-${Date.now()}`;
    manager.createSession({
      id,
      cmd: POWERSHELL,
      cwd: path.resolve(process.cwd()),
    });

    const managed = manager.getSession(id)!;
    const baseline = managed.promptLog.size;

    // Use the absolute path to cmd.exe — ConPTY's child doesn't always
    // inherit a PATH that includes System32 on every machine. `& "..."`
    // invokes it as an external command, so $LASTEXITCODE picks up the
    // exit status directly.
    managed.ptyProcess.write(`& "${CMD_EXE}" /c exit 7\r`);

    const cmdStart = await waitForEventAfter(
      managed,
      baseline,
      (e) => e.type === 'command_start',
      'command_start',
    );
    const cmdEnd = await waitForEventAfter(
      managed,
      baseline,
      (e) =>
        e.type === 'command_end' &&
        e.byteOffset >= cmdStart.byteOffset &&
        e.exitCode !== undefined &&
        e.exitCode !== 0,
      'command_end with non-zero exitCode',
    );
    expect(cmdEnd.exitCode).toBe(7);
  }, EVENT_TIMEOUT_MS + 2000);
});

describe.runIf(hasGitBash)('OSC 133 runtime — bash.exe (Git Bash)', () => {
  let manager: DaemonSessionManager;

  afterEach(() => {
    if (manager) manager.disposeAll();
  });

  it('emits initial prompt markers on shell startup', async () => {
    manager = new DaemonSessionManager();
    const id = `rt-bash-${Date.now()}`;
    manager.createSession({
      id,
      cmd: GIT_BASH,
      cwd: path.resolve(process.cwd()),
    });

    const managed = manager.getSession(id)!;

    // Bash's PROMPT_COMMAND fires when the initial prompt is rendered —
    // no user interaction required, so we can wait straight away.
    const promptStart = await waitForEventAfter(
      managed,
      0,
      (e) => e.type === 'prompt_start',
      'prompt_start',
    );
    expect(promptStart.byteOffset).toBeGreaterThanOrEqual(0);
  }, EVENT_TIMEOUT_MS + 2000);

  it('captures command_start / command_end with exitCode 0 when echo runs', async () => {
    manager = new DaemonSessionManager();
    const id = `rt-bash-exec-${Date.now()}`;
    manager.createSession({
      id,
      cmd: GIT_BASH,
      cwd: path.resolve(process.cwd()),
    });

    const managed = manager.getSession(id)!;
    await waitForEventAfter(managed, 0, (e) => e.type === 'prompt_end', 'initial prompt_end');

    const baseline = managed.promptLog.size;
    managed.ptyProcess.write('echo wmux-osc-probe\r');

    const cmdStart = await waitForEventAfter(
      managed,
      baseline,
      (e) => e.type === 'command_start',
      'command_start',
    );
    const cmdEnd = await waitForEventAfter(
      managed,
      baseline,
      (e) =>
        e.type === 'command_end' &&
        e.byteOffset >= cmdStart.byteOffset &&
        e.exitCode === 0,
      'command_end with exitCode 0',
    );
    expect(cmdEnd.byteOffset).toBeGreaterThanOrEqual(cmdStart.byteOffset);

    const range = managed.promptLog.lastCompletedCommandRange();
    expect(range).not.toBeNull();
    expect(range!.exitCode).toBe(0);
  }, EVENT_TIMEOUT_MS + 2000);

  it('records non-zero exit code from a failing command', async () => {
    manager = new DaemonSessionManager();
    const id = `rt-bash-fail-${Date.now()}`;
    manager.createSession({
      id,
      cmd: GIT_BASH,
      cwd: path.resolve(process.cwd()),
    });

    const managed = manager.getSession(id)!;
    await waitForEventAfter(managed, 0, (e) => e.type === 'prompt_end', 'initial prompt_end');

    const baseline = managed.promptLog.size;
    managed.ptyProcess.write('false\r');

    const cmdStart = await waitForEventAfter(
      managed,
      baseline,
      (e) => e.type === 'command_start',
      'command_start',
    );
    const cmdEnd = await waitForEventAfter(
      managed,
      baseline,
      (e) =>
        e.type === 'command_end' &&
        e.byteOffset >= cmdStart.byteOffset &&
        e.exitCode !== undefined &&
        e.exitCode !== 0,
      'command_end with non-zero exitCode',
    );
    expect(cmdEnd.exitCode).toBe(1);
  }, EVENT_TIMEOUT_MS + 2000);
});

describe.runIf(hasGitBash)('OSC 133 runtime — user .bashrc override fixture', () => {
  let manager: DaemonSessionManager;

  afterEach(() => manager?.disposeAll());

  it('installs markers after .bashrc replaces PS0 and PROMPT_COMMAND', async () => {
    const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-bashrc-override-'));
    fs.writeFileSync(
      path.join(fixtureHome, '.bashrc'),
      "PS0='user-ps0'\nPROMPT_COMMAND='printf user-prompt-command'\n",
      'utf8',
    );
    try {
      manager = new DaemonSessionManager();
      const id = `rt-bash-override-${Date.now()}`;
      const env = Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      );
      env.HOME = fixtureHome;
      manager.createSession({ id, cmd: GIT_BASH, cwd: fixtureHome, env });

      const managed = manager.getSession(id);
      if (!managed) throw new Error(`Bash runtime session ${id} was not created`);
      await waitForEventAfter(managed, 0, (e) => e.type === 'prompt_start', 'fixture prompt_start');
      const baseline = managed.promptLog.size;
      managed.ptyProcess.write('echo after-user-bashrc\r');
      const start = await waitForEventAfter(
        managed, baseline, (e) => e.type === 'command_start', 'fixture command_start',
      );
      const end = await waitForEventAfter(
        managed,
        baseline,
        (e) => e.type === 'command_end' && e.byteOffset >= start.byteOffset,
        'fixture command_end',
      );
      expect(end.exitCode).toBe(0);
      const exited = new Promise<void>((resolve) => {
        manager.once('session:died', (payload: { id: string }) => {
          if (payload.id === id) resolve();
        });
      });
      managed.ptyProcess.write('exit\r');
      await Promise.race([
        exited,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('fixture Bash did not exit')), 5_000),
        ),
      ]);
    } finally {
      manager?.disposeAll();
      // ConPTY releases the child's cwd asynchronously after kill. Give its
      // attach-console helper time to exit, then use Node's bounded Windows
      // EPERM retry rather than making correct marker assertions flaky at
      // fixture cleanup.
      await new Promise((resolve) => setTimeout(resolve, 250));
      fs.rmSync(fixtureHome, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      });
    }
  }, EVENT_TIMEOUT_MS + 2000);
});

describe.runIf(hasWslBash)('OSC 133 runtime — wsl.exe (Bash)', () => {
  let manager: DaemonSessionManager;

  afterEach(() => {
    if (manager) manager.disposeAll();
  });

  it('tracks a real WSL command as running from OSC 133 start through end', async () => {
    manager = new DaemonSessionManager();
    const id = `rt-wsl-bash-${Date.now()}`;
    manager.createSession({
      id,
      cmd: WSL_EXE,
      cwd: path.resolve(process.cwd()),
    });

    const managed = manager.getSession(id);
    if (!managed) throw new Error(`WSL runtime session ${id} was not created`);
    await waitForEventAfter(
      managed,
      0,
      (e) => e.type === 'prompt_start',
      'initial WSL prompt_start',
      WSL_EVENT_TIMEOUT_MS,
    );

    const baseline = managed.promptLog.size;
    // `read` gives us a deterministic, non-sleeping pause between C and D so
    // commandRunning can be observed while the real WSL Bash command owns the PTY.
    managed.ptyProcess.write('read -r __wmux_runtime_probe\r');
    const cmdStart = await waitForEventAfter(
      managed,
      baseline,
      (e) => e.type === 'command_start',
      'WSL command_start',
      WSL_EVENT_TIMEOUT_MS,
    );
    expect(managed.promptLog.isCommandRunning()).toBe(true);

    managed.ptyProcess.write('released\r');
    const cmdEnd = await waitForEventAfter(
      managed,
      baseline,
      (e) => e.type === 'command_end' && e.byteOffset >= cmdStart.byteOffset,
      'WSL command_end',
      WSL_EVENT_TIMEOUT_MS,
    );
    expect(cmdEnd.exitCode).toBe(0);
    expect(managed.promptLog.isCommandRunning()).toBe(false);
  }, WSL_EVENT_TIMEOUT_MS + 3000);
});
