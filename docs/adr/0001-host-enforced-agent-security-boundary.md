# ADR-0001: Establish a Host-Enforced Security Boundary for Agent Actions

- Status: Accepted
- Date: 2026-11-20
- Decision owners: Desktop Agent maintainers

## Context

The initial desktop-agent implementation delegates tool execution to the Copilot and CodeBuddy SDKs. Permission callbacks ask the user to approve mutating or network-related operations, while read access is allowed based on lexical path checks.

This is useful for a local prototype, but it does not establish a reliable security boundary. A lexical path check can be bypassed through symbolic links; SDK permission callbacks do not provide OS-level process isolation; provider fallback can replay a task after partial side effects; and the application has no common action policy layer.

The product is intended to remain local-first and retain its existing Electron Host, Renderer, Preload, session store, and provider adapters. Security improvements should therefore be incremental rather than a wholesale rewrite.

## Decision

### 1. The Host is the security authority

The Electron main process, not the Renderer or model, owns authorization decisions. SDK adapters translate provider requests into host-understood actions; they must not independently define enterprise policy.

The Renderer may display requests and collect user decisions, but a Renderer response is not itself an authorization token. The Host validates the pending request, run identity, expiry, and action binding before accepting a decision.

### 2. Introduce a common Action Request and Policy Enforcement boundary

All future execution channels must use a common action representation containing, at minimum:

- run and session identity;
- provider and tool identity;
- action category;
- resource and normalized parameters;
- destination where applicable;
- risk and data classification where known;
- immutable parameter digest and request expiry.

A Policy Decision Point evaluates identity, task context, resource, action, destination, and policy. Policy Enforcement Points guard every actual execution path: filesystem, process, network, connectors, MCP, browser/computer use, and artifact export.

Until the full policy service exists, the Host applies conservative local rules and fails closed when it cannot establish that a request is within the permitted boundary.

### 3. Filesystem access must use canonical filesystem identity

Workspace checks must resolve the workspace and requested target through the filesystem, reject paths outside the canonical workspace, and fail closed when a target cannot be safely resolved. This is an incremental mitigation, not a complete defense against TOCTOU races. A hardened implementation should use directory-relative file operations and OS sandboxing where supported.

### 4. Provider fallback must not replay uncertain side effects

Automatic provider fallback is permitted only when the previous provider has not been approved to perform a side-effecting action. Once a mutating, execution, or external-write action is approved, a quota failure must terminate the run with an explicit partial-execution state rather than replaying the original prompt.

A future execution journal may support checkpoint-aware continuation, but replay without idempotency and durable operation state is prohibited.

### 5. Execution profiles and OS isolation are separate from approval

User approval is an authorization signal, not a sandbox. Shell and other process execution must move toward constrained Execution Profiles with explicit filesystem, network, process, and resource limits. Until those controls exist, the application must clearly treat arbitrary command execution as a high-risk capability and must not claim that the workspace path check confines a process.

### 6. Identity, credentials, network, and data controls

The architecture will evolve toward separate User Identity, Agent Workload Identity, and Connector Service Identity. Credentials should be brokered and scoped rather than exposed wholesale through the user's environment.

Network access must be mediated through controlled egress or registered connectors, including DNS/IP validation, redirect handling, private-network restrictions, and SSRF defenses. Data classification and DLP must apply to prompts, retrieved content, tool parameters, clipboard/screenshot data, artifacts, logs, and exports.

### 7. Audit and supply-chain controls

Security-relevant decisions and executions must be correlated by run, action, identity, provider, policy version, approval, and outcome. Agent definitions, Skills, MCP servers, connectors, tool schemas, dependencies, models, and application updates are supply-chain inputs and require provenance, version control, integrity validation, and a disable/revoke path.

## Consequences

Positive:
- Security decisions become consistent across providers and future execution channels.
- Path traversal and unsafe automatic replay can be mitigated without replacing the current architecture.
- The project gains a clear migration path from local approval prompts to policy-driven execution.

Trade-offs:
- Some operations will be denied when their paths or execution state cannot be verified.
- Automatic fallback becomes less aggressive after side effects.
- Strong process and network isolation requires platform-specific implementation and testing.
- Enterprise policy, credential brokering, DLP, and full audit remain staged work; this ADR does not claim they are already implemented.

## Implementation sequence

1. Fix canonical workspace path validation, strengthen IPC sender-frame checks, and prevent fallback after an approved side effect.
2. Introduce a shared Action Request, local PDP/PEP, immutable approval binding, and Execution Profiles.
3. Add OS-level process isolation, controlled network egress, credential brokering, data classification/DLP, audit, supply-chain verification, and incident response.

## Validation requirements

- Symlink targets outside the workspace are denied by both providers.
- A path that cannot be canonicalized is denied.
- IPC calls from a non-main frame are rejected.
- Invalid approval payloads and unknown/expired approval IDs are rejected.
- A quota failure after an approved side-effecting action does not start another provider.
- Security tests cover every newly introduced execution entry point.
