# ADR-0003: Introduce a Shared Policy Control Plane

- Status: Accepted
- Date: 2026-11-20
- Owners: Desktop Agent maintainers

## Context

The current `policy.ts` module handles provider selection, quota detection, and fallback safety. It is not an authorization policy engine. Authorization is expressed through provider-specific SDK callbacks, which makes controls difficult to apply consistently as the product adds execution channels.

The product needs one host-owned enforcement contract, but the current application is a single-user local desktop tool. A remote policy administration service, elaborate PAP/PIP services, and a generic policy language would add complexity without a current use case.

## Decision

Keep the first implementation deliberately small:

1. SDK adapters translate provider requests into host-owned authorization checks.
2. Workspace read checks are shared and fail closed when paths or patterns cannot be validated.
3. Every other tool operation requires explicit host-mediated user approval.
4. Approval remains bound to the active run and expires; it is not a reusable capability.
5. Provider adapters do not independently invent authorization rules beyond translating their SDK request shape.
6. Do not introduce a remote PAP/PIP, policy DSL, role hierarchy, or policy administration UI until multi-user organizational policy is a real product requirement.

The current local decision outcomes are intentionally limited to **Allow**, **Deny**, and **Require user approval**. More granular decisions such as Step-up Authentication and Allow with Constraints should be added only when an execution channel can enforce them.

## Required execution boundary

The shared host policy is an authorization gate, not a sandbox. Any process execution still runs with the operating-system identity and privileges available to the SDK runtime. Enterprise-grade enforcement requires OS-level process isolation and restricted filesystem/network access.

Before adding new execution channels, each must use the same host authorization contract. Network, connector, MCP, browser, computer-use, and artifact-export support must not bypass it.

## Rollout

1. Share workspace read validation and keep all non-read tool actions behind host approval.
2. Add OS-enforced process and filesystem isolation before claiming constrained execution.
3. Add network egress restrictions and credential isolation if remote tools or enterprise data access are introduced.
4. Add data classification, DLP, durable audit, revocation, and incident response when enterprise deployment is in scope.

## Consequences

- The design avoids building a policy platform ahead of product requirements.
- The host remains the single place to evolve authorization behavior.
- Existing SDK adapters and Electron architecture remain intact.
- This ADR does not claim that OS sandboxing, network egress enforcement, credential brokering, DLP, or enterprise audit already exists.
- Enterprise deployment remains blocked until the relevant enforcement points are implemented and tested.
