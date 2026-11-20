# Architecture Decision Records

This directory contains the accepted architectural decisions for Desktop Agent.

| ADR | Decision | Status |
|---|---|---|
| [0001 — Host-enforced execution boundaries](0001-host-enforced-execution-boundaries.md) | Keep authorization in Electron Main, validate workspace paths and IPC, and treat SDK approval as consent rather than isolation. | Accepted |
| [0002 — Safe provider fallback](0002-safe-provider-fallback.md) | Do not replay a task after an approved operation may have produced side effects. | Accepted |
| [0003 — Shared policy control plane](0003-shared-policy-control-plane.md) | Normalize actions and enforce one host-owned policy across all execution channels. | Accepted |

An accepted ADR records a decision; it does not imply that every capability in its rollout plan has shipped. Implementation status and validation evidence should be updated as controls land.
