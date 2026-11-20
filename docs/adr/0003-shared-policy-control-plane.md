# ADR-0003: Keep Local Authorization Small and Host-Owned

- Status: Accepted
- Date: 2026-11-20

## Context

Provider adapters previously implemented different implicit-read allowlists. That made the meaning of "safe read" depend on SDK-specific tool names and input shapes. The application is currently a single-user local desktop tool; it does not yet need a remote policy service, generic policy language, role hierarchy, or administration UI.

## Decision

Keep the first local policy deliberately small. Both adapters use the same host-owned rule: only an explicit single-file `Read` whose canonical target exists inside the selected workspace may proceed without approval. Directory listing, globbing, search, skills, task tools, shell, network, writes, and all unknown tools require the host approval callback. A failed or ambiguous check is never implicitly allowed.

The Renderer may present an approval request but cannot grant capabilities itself. Approval remains bound to the pending callback and active run. SDK adapters translate provider-specific requests; they do not define separate implicit-trust allowlists.

Do not add PAP/PIP services, a remote policy server, a generic rule language, or an enterprise administration UI until the product has multiple policy sources and actual enterprise deployment requirements. OS sandboxing remains a separate enforcement requirement and cannot be simulated by prompts or approval dialogs.

## Rollout

1. Share the narrow implicit-read rule across providers.
2. Keep all other tool actions behind host-mediated approval.
3. Add OS-enforced process isolation and race-resistant file access before treating execution approval as a security boundary.
4. Add network, credential, data, and audit controls when those execution paths are introduced.

## Consequences

- More SDK tools may ask for approval than before. This is intentional: unknown and compound tools are not silently trusted.
- The policy surface stays small and testable.
- This local gate is not a substitute for an OS sandbox, network egress control, or enterprise authorization services.
