#!/usr/bin/env node
// wmux <-> OpenClaude hook bridge.
//
// Invoked by OpenClaude when one of its hooks fires (PostToolUse, Stop,
// SubagentStop, SessionStart). This script:
//   1. Determines the hook name from process.argv[2].
//   2. Reads the OpenClaude hook payload from stdin (JSON).
//   3. Builds the canonical AgentSignal envelope.
//   4. Reads the wmux auth token from ~/.wmux-auth-token.
//   5. Connects to the wmux main-process named pipe.
//   6. Sends an RPC: hooks.signal { ...envelope }
//   7. Logs the outcome to ~/.wmux/bridge.log.
//   8. Exits 0 ALWAYS (so a wmux problem never breaks OpenClaude).
//
// THIS FILE IS SELF-CONTAINED. It runs from inside an OpenClaude plugin
// where TypeScript transpilation is NOT available. Do not import anything
// from src/, integrations/shared/, or node_modules — only Node built-ins.
//
// Adapted from integrations/claude/bin/wmux-bridge.mjs for OpenClaude support.

import { readFileSync, existsSync, mkdirSync, appendFileSync, statSync, openSync, readSync, closeSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';

const HOOK_TIMEOUT_MS = 2000; // hard cap so we never slow OpenClaude
const BRIDGE_VERSION = '0.1.0';

// Retry transient connect failures within the HOOK_TIMEOUT_MS budget.
// A pipe that is ABSENT (ENOENT — wmux not running) is NOT retried.
const CONNECT_RETRY_BACKOFFS_MS = [100, 250];
const TRANSIENT_CONNECT_CODES = new Set([
  'EPERM', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EBUSY', 'EAGAIN',
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Cap stdin at 1MB to prevent OOM from large tool outputs.
const MAX_STDIN_BYTES = 1 * 1024 * 1024;

// ----- Hook name -> AgentSignal kind ---------------------------------------

const HOOK_TO_KIND = {
  PreToolUse: 'agent.awaiting_input',
  PostToolUse: 'agent.activity',
  Stop: 'agent.stop',
  SubagentStop: 'agent.subagent_stop',
  SessionStart: 'agent.session_start',
};

// ----- Path helpers (Node built-ins only) ---------------------------------

function getAuthTokenPath() {
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  return join(home, '.fmux-auth-token');
}

function getPipeName() {
  if (process.platform === 'win32') {
    const username = userInfo().username || 'default';
    return `\\\\.\\pipe\\wmux-${username}`;
  }
  return join(homedir() || '/tmp', '.fmux.sock');
}

function getBridgeLogPath() {
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  const dir = join(home, '.fmux');
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // mkdir failures fall through; appendFileSync below will also fail
    // and the catch in logEvent will silently drop.
  }
  return join(dir, 'bridge.log');
}

// Durable resume-binding spool dir for failed RPC calls.
function getResumeSpoolDir() {
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  const dir = join(home, '.fmux', 'resume-spool');
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // Fall through; the writeFileSync below will throw and be swallowed.
  }
  return dir;
}

// Persist one capture record, keyed by ptyId (last-write-wins per pane).
// Atomic via temp-then-rename. Never throws.
function spoolResumeBinding(record) {
  try {
    if (!record || !record.ptyId || !record.sessionId) return;
    const safe = String(record.ptyId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    if (!safe) return;
    const dir = getResumeSpoolDir();
    const file = join(dir, `${safe}.json`);
    const tmp = join(dir, `${safe}.${process.pid}.${randomUUID()}.json.tmp`);
    writeFileSync(tmp, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
    // Don't replace a spool file that already holds a NEWER capture.
    try {
      if (existsSync(file)) {
        const existing = JSON.parse(readFileSync(file, 'utf8'));
        if (typeof existing?.ts === 'number' && existing.ts > record.ts) {
          try { unlinkSync(tmp); } catch { /* ignore */ }
          return;
        }
      }
    } catch { /* replace a corrupt/unreadable existing spool */ }
    renameSync(tmp, file);
    logEvent('resume-spooled', { ptyId: record.ptyId, sessionId: record.sessionId });
  } catch (err) {
    logEvent('resume-spool-error', { error: String(err) });
  }
}

// ----- Logging (best-effort, never throws) --------------------------------

function logEvent(outcome, extra) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    bridge: BRIDGE_VERSION,
    pid: process.pid,
    hook: process.argv[2] ?? '?',
    outcome,
    ...(extra ?? {}),
  });
  try {
    appendFileSync(getBridgeLogPath(), line + '\n', { encoding: 'utf8' });
  } catch {
    // No writable home -> swallow.
  }
}

// ----- Transcript usage extraction ----------------------------------------

// Tail-read the last 64KB of a JSONL transcript and pull `usage` from
// the most recent assistant message. Returns null on any failure.
function extractUsageFromTranscript(transcriptPath) {
  try {
    if (!existsSync(transcriptPath)) return null;
    const stat = statSync(transcriptPath);
    const TAIL_BYTES = 64 * 1024;
    const readBytes = Math.min(TAIL_BYTES, stat.size);
    const offset = stat.size - readBytes;
    const buf = Buffer.alloc(readBytes);
    const fd = openSync(transcriptPath, 'r');
    try {
      readSync(fd, buf, 0, readBytes, offset);
    } finally {
      closeSync(fd);
    }
    const tail = buf.toString('utf8');
    const start = offset > 0 ? tail.indexOf('\n') + 1 : 0;
    const lines = tail.slice(start).split('\n').filter((l) => l.trim().length > 0);

    for (let i = lines.length - 1; i >= 0; i--) {
      let entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (entry && entry.type === 'assistant' && entry.message && entry.message.usage) {
        const u = entry.message.usage;
        const inputTokens = (typeof u.input_tokens === 'number' ? u.input_tokens : 0)
          + (typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0)
          + (typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0);
        const outputTokens = typeof u.output_tokens === 'number' ? u.output_tokens : 0;
        return {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        };
      }
    }
    return null;
  } catch (err) {
    logEvent('transcript-read-error', { error: String(err) });
    return null;
  }
}

// Extract permission mode from transcript. Returns one of the four known
// modes, or null.
const VALID_PERMISSION_MODES = new Set(['bypassPermissions', 'acceptEdits', 'plan', 'default']);
function extractPermissionModeFromTranscript(transcriptPath) {
  try {
    if (!existsSync(transcriptPath)) return null;
    const stat = statSync(transcriptPath);
    const TAIL_BYTES = 64 * 1024;
    const readBytes = Math.min(TAIL_BYTES, stat.size);
    const offset = stat.size - readBytes;
    const buf = Buffer.alloc(readBytes);
    const fd = openSync(transcriptPath, 'r');
    try {
      readSync(fd, buf, 0, readBytes, offset);
    } finally {
      closeSync(fd);
    }
    const tail = buf.toString('utf8');
    const start = offset > 0 ? tail.indexOf('\n') + 1 : 0;
    const lines = tail.slice(start).split('\n').filter((l) => l.trim().length > 0);

    for (let i = lines.length - 1; i >= 0; i--) {
      let entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (entry && (entry.type === 'user' || entry.type === 'permission-mode')
          && typeof entry.permissionMode === 'string'
          && VALID_PERMISSION_MODES.has(entry.permissionMode)) {
        return entry.permissionMode;
      }
    }
    return null;
  } catch (err) {
    logEvent('transcript-permission-read-error', { error: String(err) });
    return null;
  }
}

// Derive session id from transcript filename (stable across --resume).
function sessionIdFromTranscript(transcriptPath, fallback) {
  if (typeof transcriptPath === 'string' && transcriptPath.length > 0) {
    const base = transcriptPath.split(/[\\/]/).pop() ?? '';
    const id = base.replace(/\.jsonl$/i, '');
    if (id) return id;
  }
  return fallback;
}

// ----- stdin reader -------------------------------------------------------

async function readStdin() {
  const chunks = [];
  let total = 0;
  let truncated = false;
  return new Promise((resolve, reject) => {
    process.stdin.on('data', (c) => {
      if (total + c.length > MAX_STDIN_BYTES) {
        truncated = true;
        const remaining = MAX_STDIN_BYTES - total;
        if (remaining > 0) chunks.push(c.subarray(0, remaining));
        total = MAX_STDIN_BYTES;
        process.stdin.removeAllListeners('data');
        process.stdin.destroy();
        const buf = Buffer.concat(chunks).toString('utf8').trim();
        try {
          const parsed = buf ? JSON.parse(buf) : null;
          if (truncated) logEvent('stdin-truncated', { totalBytes: total });
          resolve(parsed);
        } catch (err) {
          if (truncated) logEvent('stdin-truncated', { totalBytes: total });
          reject(err);
        }
        return;
      }
      chunks.push(c);
      total += c.length;
    });
    process.stdin.on('end', () => {
      const buf = Buffer.concat(chunks).toString('utf8').trim();
      if (!buf) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(buf));
      } catch (err) {
        reject(err);
      }
    });
    process.stdin.on('error', reject);
  });
}

// ----- RPC over named pipe ------------------------------------------------

function sendRpc(pipePath, request, timeoutMs = HOOK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const sock = createConnection(pipePath);
    let buffer = '';
    let settled = false;
    let wrote = false;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* socket already dead */ }
      resolve(result);
    };

    const timer = setTimeout(() => {
      settle({ ok: false, error: 'timeout' });
    }, timeoutMs);

    sock.on('connect', () => {
      sock.write(JSON.stringify(request) + '\n');
      wrote = true;
    });
    sock.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl !== -1) {
        const line = buffer.slice(0, nl);
        clearTimeout(timer);
        try {
          settle(JSON.parse(line));
        } catch {
          settle({ ok: false, error: 'malformed-response' });
        }
      }
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      settle({ ok: false, error: 'connect-error', detail: err.code ?? err.message, retryable: !wrote });
    });
    sock.on('close', () => {
      clearTimeout(timer);
      settle({ ok: false, error: 'closed-without-response' });
    });
  });
}

// sendRpc with bounded connect retry for transient errors.
async function sendRpcWithRetry(pipePath, request) {
  const deadline = Date.now() + HOOK_TIMEOUT_MS;
  let attempt = 0;
  let last = { ok: false, error: 'timeout' };
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return last;
    last = await sendRpc(pipePath, request, remaining);
    if (last.error !== 'connect-error') return last;
    if (last.retryable === false
        || !TRANSIENT_CONNECT_CODES.has(last.detail)
        || attempt >= CONNECT_RETRY_BACKOFFS_MS.length) {
      return last;
    }
    const backoff = CONNECT_RETRY_BACKOFFS_MS[attempt++];
    if (Date.now() + backoff >= deadline) return last;
    await sleep(backoff);
  }
}

// ----- Main ---------------------------------------------------------------

async function main() {
  const hookName = process.argv[2];
  if (!hookName || !HOOK_TO_KIND[hookName]) {
    logEvent('unknown-hook-name', { argv: process.argv });
    return; // exit 0 below
  }

  let payload;
  try {
    payload = await readStdin();
  } catch (err) {
    logEvent('malformed-stdin', { error: String(err) });
    return;
  }
  // Empty stdin is allowed for SessionStart per OpenClaude spec.
  if (payload === null && hookName !== 'SessionStart') {
    logEvent('empty-stdin', { hook: hookName });
    return;
  }

  // PreToolUse fires per tool call; we only treat AskUserQuestion as
  // "awaiting input".
  if (hookName === 'PreToolUse'
      && !(payload && payload.tool_name === 'AskUserQuestion')) {
    logEvent('skip-pretooluse', { tool: payload && payload.tool_name });
    return;
  }

  const tokenPath = getAuthTokenPath();
  if (!existsSync(tokenPath)) {
    logEvent('no-auth-token', { path: tokenPath });
    return;
  }
  let token;
  try {
    token = readFileSync(tokenPath, 'utf8').trim();
  } catch (err) {
    logEvent('auth-token-read-error', { error: String(err) });
    return;
  }
  if (!token) {
    logEvent('empty-auth-token', {});
    return;
  }

  // Prefer payload.cwd when OpenClaude provides it.
  const payloadCwd = (payload && typeof payload.cwd === 'string' && payload.cwd.length > 0)
    ? payload.cwd
    : null;

  // Token usage extraction from transcript_path.
  const transcriptPath = (payload && typeof payload.transcript_path === 'string' && payload.transcript_path.length > 0)
    ? payload.transcript_path
    : null;

  let usage = null;
  const isStopClass = hookName === 'Stop' || hookName === 'SubagentStop';
  if (isStopClass && transcriptPath) {
    usage = extractUsageFromTranscript(transcriptPath);
  }

  // Capture permission mode on SessionStart and stop-class hooks.
  let permissionMode;
  const isSessionStart = hookName === 'SessionStart';
  if ((isSessionStart || isStopClass) && transcriptPath) {
    permissionMode = extractPermissionModeFromTranscript(transcriptPath) ?? undefined;
  }

  // Env-first routing identifiers from wmux pane environment.
  const envWorkspaceId =
    typeof process.env.WMUX_WORKSPACE_ID === 'string' && process.env.WMUX_WORKSPACE_ID.length > 0
      ? process.env.WMUX_WORKSPACE_ID
      : undefined;
  const envSurfaceId =
    typeof process.env.WMUX_SURFACE_ID === 'string' && process.env.WMUX_SURFACE_ID.length > 0
      ? process.env.WMUX_SURFACE_ID
      : undefined;
  const envPtyId =
    typeof process.env.WMUX_PTY_ID === 'string' && process.env.WMUX_PTY_ID.length > 0
      ? process.env.WMUX_PTY_ID
      : undefined;

  // Build the AgentSignal envelope.
  const envelope = {
    kind: HOOK_TO_KIND[hookName],
    agent: 'openclaude',
    agentSessionId: sessionIdFromTranscript(
      transcriptPath,
      (payload && typeof payload.session_id === 'string') ? payload.session_id : undefined,
    ),
    workspaceId: envWorkspaceId,
    surfaceId: envSurfaceId,
    ptyId: envPtyId,
    cwd: payloadCwd ?? process.cwd(),
    payload: {
      ...(payload ?? {}),
      ...(usage ? { usage } : {}),
      ...(permissionMode ? { permissionMode } : {}),
    },
    ts: Date.now(),
  };

  // Diagnostic dump for verification harnesses.
  if (process.env.WMUX_BRIDGE_DEBUG === '1') {
    const { payload: envelopePayload, ...envelopeMeta } = envelope;
    const usageOnly = envelopePayload && envelopePayload.usage ? { usage: envelopePayload.usage } : {};
    const permOnly = envelopePayload && envelopePayload.permissionMode
      ? { permissionMode: envelopePayload.permissionMode }
      : {};
    process.stderr.write(
      `WMUX_BRIDGE_DEBUG_ENVELOPE=${JSON.stringify({ ...envelopeMeta, payloadKeys: Object.keys(envelopePayload ?? {}), ...usageOnly, ...permOnly })}\n`,
    );
  }

  const request = {
    id: `bridge-${randomUUID()}`,
    method: 'hooks.signal',
    params: envelope,
    token,
  };

  const rpcResult = await sendRpcWithRetry(getPipeName(), request);

  // Unwrap both RPC layers.
  const outerOk = rpcResult && rpcResult.ok === true;
  const innerOk = outerOk && rpcResult.result && rpcResult.result.ok === true;

  if (innerOk) {
    logEvent('ok', { hook: hookName });
  } else if (outerOk) {
    logEvent('rpc-rejected', {
      hook: hookName,
      reason: rpcResult.result?.reason ?? 'unknown',
    });
  } else {
    logEvent('rpc-failed', {
      hook: hookName,
      error: rpcResult?.error ?? 'unknown',
      detail: rpcResult?.detail,
    });
  }

  // Spool failed lifecycle captures for daemon recovery.
  const isLifecycle = envelope.kind === 'agent.session_start'
    || envelope.kind === 'agent.stop'
    || envelope.kind === 'agent.subagent_stop';
  if (!innerOk && isLifecycle && envPtyId && envelope.agentSessionId) {
    spoolResumeBinding({
      ptyId: envPtyId,
      agent: 'openclaude',
      sessionId: envelope.agentSessionId,
      cwd: envelope.cwd,
      transcriptPath: transcriptPath ?? undefined,
      permissionMode: permissionMode ?? undefined,
      workspaceId: envWorkspaceId,
      ts: envelope.ts,
    });
  }
}

// Run; never throw upward.
main()
  .catch((err) => {
    logEvent('uncaught', { error: String(err) });
  })
  .finally(() => {
    process.exit(0);
  });
