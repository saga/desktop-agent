# ADR-0001: Establish Host-Enforced Execution Boundaries

- Status: Accepted
- Date: 2026-11-20
- Owners: Desktop Agent maintainers

## Context

The initial implementation delegates tool execution to the Copilot and CodeBuddy SDKs. The host receives permission callbacks and asks the user to approve operations, while read access is constrained with lexical path checks.

A user confirmation is useful for intent and consent, but it is not an execution sandbox. The SDK process may still run with the local user's operating-system privileges. Lexical path checks also do not prevent a path inside the workspace from resolving through a symbolic link to a file outside it. Renderer-to-main IPC must be restricted to the trusted top-level application frame, not merely any frame belonging to the same WebContents.

The application is currently a local-first prototype. It does not yet have a corporate policy service, credential broker, network egress proxy, DLP system, or OS-level sandbox.

## Decision

1. Keep Electron Main as the trusted host boundary. Renderer code must never receive Node.js access or arbitrary IPC primitives.
2. Validate IPC calls against the current application WebContents and its main frame. Validate untrusted IPC argument types and bind approval responses to the active run.
3. Resolve workspace roots and requested read paths through the filesystem before allowing access. Reject paths that resolve outside the selected workspace; fail closed when the root or target cannot be resolved.
4. Treat SDK permission callbacks as user-consent gates, not as proof of OS-level isolation. Never describe the current implementation as a sandbox.
5. Introduce a shared Action/Policy boundary before adding more execution channels. File, process, network, connector, MCP, browser and computer-use operations must eventually pass through an enforceable host-side policy decision and execution boundary.
6. Treat OS-level process isolation, filesystem handles/openat-style race resistance, network egress restrictions, credential brokering and DLP as required follow-up work before enterprise deployment.

## Consequences

- Workspace reads gain protection against ordinary symlink escapes and lexical traversal.
- This check still has a time-of-check/time-of-use race if an attacker can mutate the workspace concurrently. It is defense in depth, not a substitute for an OS sandbox or descriptor-relative filesystem operations.
- Existing SDK adapters remain in place; this ADR does not require a broad rewrite.
- The product must communicate that approval is per operation and does not reduce the privileges of the underlying process.
- Enterprise readiness remains blocked until the follow-up controls are implemented and tested.

## Current implementation status

Implemented in the host and provider adapters:
- Canonical real-path checks for existing workspace reads in both providers.
- Main-frame IPC sender validation, including application URL validation.
- Approval responses bound to the active run, with a three-minute timeout.
- Quota fallback blocked after an approved action that may have side effects.
- Cancellation checks before admitting new provider tool requests.

Still required before enterprise deployment:
- Descriptor-relative file access or an OS sandbox to close TOCTOU races.
- Constrained process execution, network egress control, credential brokering, DLP, and a common PDP/PEP.
- Durable action journal, tamper-resistant audit, revocation, and incident response.

## Security invariants

- A read request that cannot be proven to resolve inside the selected workspace is denied.
- A child frame cannot invoke privileged IPC.
- A stale or malformed approval response cannot authorize a different or completed run.
- A user-approved operation is not implicitly authorized for later operations.
