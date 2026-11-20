# ADR 0004: MXC command execution sandbox

- Status: Accepted
- Date: 2026-11-20

## Context

Provider SDK permission callbacks are authorization hooks, not operating-system isolation. A shell command approved by the user otherwise inherits the desktop user's host permissions, environment, filesystem access, and network access.

The application targets Windows and macOS and should not require routine administrator elevation or a separately installed container daemon.

## Decision

All shell and command execution is exposed through one host-owned MCP tool backed by Microsoft Execution Containers (MXC).

- macOS explicitly uses the MXC Seatbelt backend.
- Windows explicitly uses MXC ProcessContainer. Startup probes the exact request and accepts only the `base-container` tier.
- The application never invokes `wxc-host-prep.exe`, requests UAC, or silently falls back to an unsandboxed host process. If the required backend is unavailable or would require administrator preparation, command execution fails closed.
- A system Node.js 24 runtime launches the helper. Windows requires Node 24.21.0 or later for native stdio; macOS requires Node 24 or later. Electron's embedded Node runtime is not used for MXC.
- Both Copilot and CodeBuddy native shell tools are denied. Their MCP integration exposes only `run_command`.
- The sandbox grants write access to the selected workspace and a private temporary directory, read-only access to system/toolchain paths, keeps known host credential directories outside the filesystem allowlist, and denies network ingress and egress by default.
- Stop/cancellation is propagated to the MCP helper, which terminates the active MXC process handle.

## Consequences

This adds the MXC SDK and a small standalone MCP helper. The helper is unpacked from Electron ASAR and launched with the discovered system Node runtime.

The sandbox applies to command execution only. Provider-native file tools remain subject to Electron Main authorization and workspace path checks; this ADR does not claim that those operations are already OS-isolated.

Windows ProcessContainer currently provides its reported `base-container` tier, not an AppContainer or VM boundary. The application must not describe it as VM-level isolation. macOS Seatbelt depends on the platform sandbox implementation. Both backends require integration testing on supported OS versions.

Network access is intentionally unavailable to sandboxed commands in this first integration. A later network proxy must be separately designed and must not weaken the default-deny policy.
