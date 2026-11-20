# ADR-0002: Make Provider Fallback Safe Around Side Effects

- Status: Accepted
- Date: 2026-11-20
- Owners: Desktop Agent maintainers

## Context

The runtime can retry a task with CodeBuddy when Copilot reports quota exhaustion. A provider can, however, perform tool operations before returning the quota error. Replaying the original prompt may repeat file writes, shell commands, API calls or other external side effects.

The current SDK abstraction does not expose a durable, provider-independent operation journal or a reliable way to prove that a failed turn had no side effects.

## Decision

1. Keep automatic quota fallback only while no approved tool operation has been allowed during the current turn.
2. Once a permission callback approves an operation, mark the turn as potentially side-effecting. If the provider subsequently fails with a quota error, stop and surface the failure instead of replaying the whole prompt.
3. Do not infer that a provider performed no side effects merely because it returned an error or emitted no final response.
4. Future support for fallback after side effects requires a durable execution journal, stable operation identifiers, explicit idempotency contracts for external writes, checkpoints and a recovery protocol. A model-generated summary alone is not a sufficient checkpoint.

## Consequences

- Some quota failures will no longer fall back automatically after an approved operation, even if that operation was read-only. This conservative behavior avoids unsafe replay.
- The user may need to retry manually after inspecting the partial result.
- This is an intentional safety-over-availability trade-off.
- A future operation journal can restore more automatic fallback without reintroducing at-least-once side-effect ambiguity.

## Invariant

A task is never automatically replayed on another provider after the host has approved an operation that may have produced a side effect.
