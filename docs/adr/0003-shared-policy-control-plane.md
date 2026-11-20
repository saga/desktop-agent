# ADR-0003: Introduce a Shared Policy Control Plane

- Status: Accepted
- Date: 2026-11-20
- Owners: Desktop Agent maintainers

## Context

The current `policy.ts` module handles provider selection, quota detection, and fallback safety. It is not an authorization policy engine. Authorization is expressed through provider-specific SDK callbacks, which makes controls difficult to apply consistently as the product adds filesystem, process, network, MCP, Browser, Computer Use, Connector, and artifact-export capabilities.

The product needs one host-owned decision and enforcement model. It should be introduced incrementally and should not require replacing the Electron shell or current SDK adapters.

## Decision

Introduce a normalized Action Request and a shared host-side Policy Control Plane.

The control plane separates five responsibilities:

- **Policy Administration Point (PAP):** authoring, approval, versioning, and publishing policy.
- **Policy Information Point (PIP):** trusted identity, task, device posture, resource ownership, data classification, and destination context.
- **Policy Decision Point (PDP):** evaluate an action and return Allow, Deny, Require Approval, Step-up Authentication, or Allow with Constraints.
- **Policy Enforcement Point (PEP):** enforce the decision at the actual execution boundary, not merely in the prompt or UI.
- **Policy Audit:** correlate the policy version, decision, approval, action, and execution outcome.

Every Action Request must carry stable run and session identity, provider/tool identity, action category, normalized resource and parameters, destination where relevant, and a digest of the exact parameters. Decisions and approvals are short-lived and bound to the action digest. Any material parameter change requires a new decision.

The Renderer may present a decision request but cannot grant capabilities itself. A user approval cannot override an organizational Deny. High-risk operations fail closed when policy evaluation is unavailable.

All execution channels must converge on the same enforcement contract: filesystem, process, network, connectors, MCP, Browser, Computer Use, and artifact export. SDK adapters translate provider-specific requests; they do not own enterprise authorization policy.

## Rollout

1. Normalize Action Requests and centralize the existing local approval flow.
2. Add a local PDP/PEP for file and process execution, including resource and parameter binding.
3. Introduce Execution Profiles with OS-enforced filesystem, process, network, and resource limits.
4. Add Credential Broker and controlled network egress; apply data classification and DLP to model inputs, tools, artifacts, logs, and exports.
5. Extend enforcement to MCP, Browser, Computer Use, and enterprise Connectors.
6. Add policy administration, tamper-resistant audit, revocation, monitoring, Kill Switch, and incident response.

## Consequences

- New execution channels cannot introduce independent permission logic.
- The current SDK callback implementation remains a transitional local gate, not a complete PDP/PEP.
- This decision does not claim that enterprise policy administration, workload identity, DLP, network egress enforcement, or OS sandboxing already exists.
- Enterprise deployment remains blocked until enforcement points are implemented and tested across every execution path.
