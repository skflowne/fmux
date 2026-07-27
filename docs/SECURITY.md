# wmux Substrate — Security Model

> **Status:** Draft 1 (Phase 0 baseline). Companion to the [substrate protocol](./PROTOCOL.md) and the v3.0 [stability contract](./api/stability.md).
> **Audience:** plugin authors, integrators, security reviewers, and anyone trying to decide whether wmux fits a given threat model.

> **Fork note.** This document describes the wmux substrate as shipped by **Forge Mux** (`skflowne/fmux`). The security *model* is inherited from upstream wmux unchanged; the **on-disk paths are not**. Forge Mux uses its own namespace — `~/.fmux/`, `~/.fmux-auth-token` — so it can coexist with an upstream wmux install without sharing state. Paths below are the ones this build actually uses; `shared/constants.ts` is the single source of truth (`getWmuxHomeDir`, `getAuthTokenPath`, `getDaemonAuthTokenPath`). A dev/dogfood instance sets `WMUX_DATA_SUFFIX=-dev` and gets `~/.fmux-dev/` throughout. **Report vulnerabilities to this fork, not upstream — see §5.**

This document states the wmux substrate's security posture. It is deliberately narrow about what wmux protects against and explicit about what it does not. The substrate's identity is a small neutral core plus a plugin layer (§4 of `PROTOCOL.md`); the security model follows the same shape — small core guarantees, hard delegations to the OS, and a clear list of out-of-scope threats.

---

## 0. The substrate's security stance

wmux is a **terminal substrate, not a secure data vault**. Its job is to own panes, terminal I/O, and the event bus, and to expose a stable surface to external tools. It is not designed to be a confidentiality boundary against same-user adversaries on the same machine.

If a workflow demands strong at-rest confidentiality (compliance-grade key material, regulated PII, classified data), the correct primitive is OS-level isolation — Windows Sandbox, a Hyper-V or VirtualBox VM, a container — and wmux running inside it. wmux does not replace those primitives.

This is the same trade-off as `tmux` and most terminal multiplexers: persistence and recoverability are surface-level features, and confidentiality is delegated to the operating system.

---

## 1. What wmux guarantees

The following are first-class commitments. Regressions here are bugs.

### 1.1 At-rest file mode

- POSIX (`macOS`, `Linux`): `~/.fmux/` and every file inside it are created with mode `0o600` (owner read/write only). Directories are `0o700`.
- Windows: `%USERPROFILE%\.fmux\` inherits the default user profile ACL. The substrate relies on the OS user profile boundary as the trust line — same-user processes can read substrate files; other users on the same machine cannot.

> **Note (2026-05-16):** an earlier draft of this document described additional Windows-side `icacls` hardening and cloud-sync exclusion signals applied by the daemon on startup. That code path produced a broken ACL state in user-dogfood testing (lock-out of the owner) and was reverted. Any future hardening over what `0o600` / the default user profile ACL provides will be re-introduced only after dogfood passes on a real `%USERPROFILE%\.fmux\` directory, not just a fresh-tmpdir dynamic test.

### 1.2 Named Pipe authentication

The wmux daemon exposes its RPC surface over a Windows Named Pipe (or Unix socket on POSIX). Every connection must present a per-user auth token; clients without it are rejected before any RPC is dispatched. See `PROTOCOL.md` §5 for the full token model.

**The token.** A random UUIDv4 (122 bits), persisted to disk and reused across boots, rotated only on explicit request. Two distinct tokens exist:

| Token | Path | Helper |
|---|---|---|
| Main pipe | `%USERPROFILE%\.fmux-auth-token` (POSIX: `~/.fmux-auth-token`) | `getAuthTokenPath()` |
| Daemon control pipe | `~/.fmux/daemon-auth-token` | `getDaemonAuthTokenPath()` |

The daemon token lives *inside* the data directory rather than carrying the suffix in its filename, so a dev instance gets `~/.fmux-dev/daemon-auth-token` instead of colliding with production. Both files are mode `0o600` and written via the `secureWriteTokenFile` helper.

**Windows ACL rebuild.** The DACL is rebuilt so the only surviving entry is Full control for the current user: inheritance is disabled and discarded, and every pre-existing ACE — inherited **or** explicit — is removed, so no other local account can read it.

The owner is named by **SID**, not by `%USERNAME%`. A non-ASCII profile name (e.g. a Korean account) gets mangled by native ACL tooling into a ghost principal, which previously granted Full control to a non-existent account and locked the real owner out of their own token file. If the SID cannot be resolved (e.g. `whoami` is unavailable) the helper falls back to the account name **only when it is pure ASCII**; for a non-ASCII or empty name it refuses to harden rather than risk re-introducing the mangle, failing safe — the write path deletes the token and errors, and the re-harden path is a best-effort no-op leaving the existing ACL untouched.

**Why `FileInfo.SetAccessControl`.** The rebuild uses the .NET `FileInfo.SetAccessControl` overload (DACL section only — never owner/group/SACL), so it needs no special privilege and succeeds on the already-protected token left by older versions. Two primitives that do **not** work here (issue #124):

- `icacls /grant:r *<sid>:F /inheritance:r` leaves a pre-existing explicit broad ACE (e.g. `Everyone:(R)`) in place — the file stays world-readable.
- The PowerShell `Set-Acl` cmdlet tries to re-stamp the owner/group section and throws `SeSecurityPrivilege` on that same upgrade-from-icacls state.

On SKUs where PowerShell is unavailable the helper falls back to `icacls`: owner Full control, `/inheritance:r`, then explicit `/remove:g` of the well-known broad principals (`Everyone`, `BUILTIN\Users`, `Authenticated Users`, `INTERACTIVE`) by SID.

The same hardening is re-applied on **every load** via `reHardenTokenFileAcl` (RCA A12 / v2.14.0), not just on first write.

### 1.3 Packaging fuse posture

The shipped Electron build sets these fuses (`forge.config.ts`), recorded here so the disabled ones are on the record and not mistaken for oversights:

- `EnableCookieEncryption`: **on**.
- `EnableNodeOptionsEnvironmentVariable` / `EnableNodeCliInspectArguments`: **off**.
- `OnlyLoadAppFromAsar`: **on** — the app only loads from the packaged asar.
- `EnableEmbeddedAsarIntegrityValidation`: **off** — *intentional*. The `postPackage` hook repacks `app.asar` to bundle `node-pty`, which changes the asar hash; enabling this fuse would FATAL at runtime. `OnlyLoadAppFromAsar` still constrains load origin.
- `RunAsNode`: **on** — *required*. The background daemon is spawned as a detached Node process from `wmux.exe` via `ELECTRON_RUN_AS_NODE=1`. Acceptable for a terminal multiplexer that already executes arbitrary shell commands.

The in-app updater downloads the `Setup.exe` itself and verifies a pinned SHA-256 (published in `update-manifest.json` by CI) before launching it — fail-closed, so a tampered or unverifiable artifact is never run. Authenticode code signing of the installer + update artifacts is **not yet in place** (pending a code-signing certificate); until it lands, direct downloads still trip the SmartScreen "unknown publisher" prompt — and on Windows 11 devices with Smart App Control enforcing, the unsigned installer may be blocked outright with no override (see [#200](https://github.com/openwong2kim/wmux/issues/200); winget/Chocolatey or build-from-source are the workarounds) — and the updater's trust floor is the SHA-256 pin, not a signature. See the release pipeline (`.github/workflows/release.yml`).

---

## 2. What wmux delegates to the operating system

| Concern | OS primitive |
|---|---|
| At-rest disk encryption | BitLocker (Windows), FileVault (macOS), LUKS / dm-crypt (Linux) |
| Process-to-process isolation | OS user accounts, ACLs, process tokens |
| Memory protection | OS memory manager (no `mlock`, no pinning) |
| Pagefile / swap leak | OS-level pagefile encryption (BitLocker on Windows, encrypted swap on macOS/Linux) |
| Crash-dump scrubbing | OS crash-dump policy (Windows Error Reporting opt-out, etc.) |
| Network confidentiality (PTY over remote shells) | The user's SSH / VPN / TLS stack |
| Folder-level access restriction | The OS user profile ACL (Windows) / `0o700` mode (POSIX) |
| Cloud-sync / backup exclusion | The user's sync / backup tool's own ignore configuration |

If your threat model requires any of these, configure the OS layer. wmux does not duplicate them.

---

## 2.5 Declared but not guaranteed: per-plugin permissions

MCP plugins declare `wmuxPermissions` in their manifest, and the substrate parses and validates that grammar today (`main/mcp/permissionGrammar.ts`, `main/pipe/handlers/mcp.rpc.ts`). The *intended* contract is enforcement at four points — method · path · event · workspace claim — on every RPC and event delivery, so that a plugin without `pane.read` for a given pane never sees that pane's content via the substrate API.

**This is stated as intent, not as a §1 guarantee, because enforcement is not complete.** Do not rely on it to isolate an untrusted plugin. An earlier revision of this document listed it under §1 alongside guarantees whose regressions are bugs; that was wrong — you cannot regress what is not built — and it cited a planning document that does not exist in this repository.

Even fully implemented it would not be a sandbox: a same-user plugin process can read disk files directly without going through the substrate, and plugin disk access is governed by §1.1. Treat plugins as code you have chosen to run as yourself.

---

## 3. What wmux does NOT try to protect against

Stated explicitly so reviewers and operators don't infer guarantees that don't exist.

- **Same-user malware or unauthorized processes.** A process running as the same user can read `~/.fmux/` directly, attach a debugger to the daemon, or inspect process memory. No application-level mitigation defeats this.

  This is load-bearing, not boilerplate: it is why the app does **not** ship path blocklists on its own file-reading APIs. Such a control would be an application-level mitigation for exactly the threat named here, defeated by any pane the user (or an agent) can already type into.
- **Pagefile / swap leak of PTY bytes.** Scrollback lives in process memory and is subject to normal OS paging. Use OS-level pagefile encryption if this matters.
- **Crash dumps.** A daemon or renderer crash may produce a dump containing scrollback bytes. Disable crash dumps at the OS level if this matters.
- **GPU / framebuffer memory inspection.** Rendered terminal text passes through the GPU; same-user GPU memory access can recover it.
- **Side-channel timing attacks** against PTY input or rendering.
- **Cloud sync engines mirroring `~/.fmux/`.** If a user has redirected their profile root to OneDrive Known Folder Move or set up Windows Backup over the profile, scrollback gets mirrored. The user must add an exclusion in their backup tool — wmux does not.
- **Compromised plugins running as the same user.** Permission enforcement (§2.5) is declared intent, not a guarantee, and defends documented substrate access only. A compromised plugin process can do anything its user account can do.
- **Network-level attacks on PTY data carried over shells the user opens.** wmux is the multiplexer; SSH / VPN / TLS are the user's responsibility.

---

## 4. For high-sensitivity workflows

If a session is sensitive enough that the above out-of-scope items matter, the correct posture is OS-level isolation:

- **Short-lived secret handling** (env dumps, key prints, AWS CLI output): run the shell inside a transient Windows Sandbox or Hyper-V VM. Close the sandbox when done. wmux outside the sandbox never sees the bytes.
- **Compliance-regulated workflows** (PCI, HIPAA, classified): run wmux inside a regulated VM with the appropriate disk encryption, swap encryption, and crash-dump policy. The substrate's `~/.fmux/` lives inside the VM and inherits the VM's protections.
- **Multi-tenant developer machines** where the user account itself is not trusted: do not use wmux. The substrate explicitly does not protect against same-user adversaries.

There is no per-session "secure mode" toggle in wmux. The substrate is neutral: every session gets the same persistence and recovery guarantees described in `PROTOCOL.md`, and confidentiality is achieved by OS-level isolation, not by per-session opt-outs.

---

## 5. Reporting security issues

Security issues should be reported privately, **to this fork**: use GitHub's "Report a vulnerability" workflow on [`skflowne/fmux`](https://github.com/skflowne/fmux/security/advisories/new). Please do not file public issues for security-relevant findings until a fix is available.

Report to upstream [`openwong2kim/wmux`](https://github.com/openwong2kim/wmux) instead only if the defect is in inherited upstream code and affects upstream users independently of Forge Mux's changes. If in doubt, report here — we will forward it.

What we consider a security issue:

- A defect that violates a §1 guarantee (e.g., a code path that writes a substrate file with broader ACL than stated).
- A documented substrate surface that returns data to a plugin without honoring `wmuxPermissions` — **once §2.5 enforcement lands**. Until then this is a feature gap, not a vulnerability, and belongs in a normal issue.
- A token-handling defect in the Named Pipe / socket layer.
- Substrate-side parsing or deserialization defects exploitable from the plugin side.

What we do not consider a wmux security issue:

- Same-user disclosure paths covered by §3.
- Cloud-sync engines mirroring `~/.fmux/` (configure the sync tool, see §2 and §3).
- PTY content disclosure through tools the user runs *inside* a pane (that's the inner program's surface, not wmux's).

---

## 6. Change log

| Date | Change |
|---|---|
| 2026-07-27 | Forge Mux fork audit. (a) §5 was directing vulnerability reports to the upstream wmux repository, which this fork does not control — now routed to `skflowne/fmux`. (b) On-disk paths corrected from `~/.wmux/` to the `~/.fmux/` namespace this fork actually uses (`shared/constants.ts`); the 2026-05-16 row below is left as written, being a record of what happened upstream at the time. (c) Per-plugin permission enforcement moved out of §1 "guarantees" into §2.5 "declared but not guaranteed" — it was listed among commitments whose regressions are bugs while enforcement is incomplete, and cited `plans/generic-wandering-teapot.md`, which does not exist in this repository. Old §1.4 renumbered to §1.3. (d) §1.2 split into subsections; no technical claim changed. (e) §3 now states explicitly that the same-user carve-out is why the app ships no path blocklists on its own read APIs. |
| 2026-05-16 | Initial draft (#41). Declared icacls + attrib + notice-file hardening signals + `mcp.claimWorkspace` enforcement. |
| 2026-05-16 | Reverted icacls/attrib/notice-file claims (§1.2 and §1.3 of the original draft). Dogfood on a real `%USERPROFILE%\.wmux\` directory produced a broken ACL state (`/inheritance:r` removed the owner's WRITE_DAC, and the subsequent `/grant:r` failed silently). The dynamic test (`scripts/substrate-hardening-dynamic.mjs`) had passed on a fresh `mkdtempSync` directory whose ACL constitution is different from a long-lived profile-scoped folder; the test did not catch the production-only regression. Phase 3.2 hardening will be re-attempted only after a hardening helper that (a) grants the owner explicit `(OI)(CI)F` *before* removing inherited ACEs and (b) is dogfooded against a real user profile passes. |
