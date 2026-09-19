<!-- page: Agent protocol | 12 | where the validation runner and release delivery APIs are documented. -->
# Validation runner and delivery APIs

The [validation protocol](../validation.md) documents versioned environments, trusted registrations, immutable candidates, explicit dispatch/ACK, result collection and recovery. Use `graphyard validation` to inspect requests. Automatic runner execution is a later increment.

## Release and delivery API

The [delivery guide](../delivery.md) documents release builds, immutable release revisions with explicit membership, operator approvals, generation-fenced selection of an environment's expected release, leased observer and promoter identities, append-only deployment observations and the bounded sweep that derives verification. `GET /api/delivery` returns every environment's delivery state and the release registry; `GET /api/delivery/observations?environment=ID` pages an environment's observations; `POST /api/delivery/{build,release,approve,select,lease,observe,notify}` are the mutations, and `POST /api/delivery/sweep` is the operator's way to drain observations ahead of the two-second tick. A verified release adds `releaseDeliveries` to each included work item; it never changes the item's stage.
