<!-- page: Understand or contribute | 1 | invariants, boundaries. -->
# Architecture and correctness model

For a contributor: what makes a gate decision trustworthy.

## Boundary

Graphyard owns coordination decisions; a gate is a deterministic evaluation, never a model's judgment.

![Graphyard control-plane components; the text equivalent follows.](diagrams/control-plane-components.svg)

Text equivalent: agent sessions, the dashboard and a proof producer reach the **HTTP API and CLI**, which hands authenticated commands to the **coordination engine** — one advisory-locked transaction per mutation, no external I/O inside — writing the aggregate and its event together to **Postgres**. Jobs flow to the **reconciliation worker**, which exchanges pull-request, review, check, protection and merge facts with **GitHub**; the dashed arrow back is the signed webhook waking a job.

## Storage

- **Release, delivery, attribution and validation tables:** those protocols' immutable records.
- **`jobs`:** durable queue processed with `FOR UPDATE SKIP LOCKED`, acknowledged with the exact owner token.
- **`flow_facts` and `deployment_observations`:** the append-only projection [flow analytics](flow-analytics.md) reads, never part of gate evaluation.

## Transactions, assignments and evidence

- **Requirements and dependency edges:** revisable by [audited revision](coordination.md#revise-requirements-explicitly), refusing active ownership and cycles.

## Inverted coordination: typed actions and stateless executors

The control plane names what each item needs next and keeps a durable leased row for it; stateless executors claim those rows and run them ([operating them](executors.md)). `nextAction` (`src/model/next-action.ts`) is pure over the item, its graph and the clock, so two readers always agree without talking to each other.

- **Rows are durable** (`src/model/actions.ts`), written in the same advisory-locked transaction as every other decision; a row's id hashes what it binds, never when it was made, so a restart recognises the row it has. Executors are stateless — a credential, a host name, one handler per kind — and `actionJudgment` classifies each kind (`none` mechanical, `in-session` launches a session the model works inside, `in-step` *is* the judgment), the two `in-step` kinds never having a handler, so a ready-to-delivered cycle runs with no judgment in the loop; `llmRole` names the judgment inside what an action starts.
- **Three consecutive failures with an unchanged reason classify the row as stalled** rather than retrying. A row inside its backoff is claimable by nobody, so it appeared in no count and no list: an item that owed a review nobody could launch read exactly like an item with nothing to do. Stalling (`src/model/action-progress.ts`, which holds every reading of a row: state, the wait a failed attempt earns, whether it progresses, and what the queue holds). The classification is written onto the row so every reader says the same thing, and a stalled row rechecks once a minute rather than on the interval its attempts earned, so backoff earned while a blocking condition stood never outlives it; a differing reason ends the run.

None of this authorizes progression: an action is a fact about what is missing, and the gates still decide from evidence and verdicts alone.

## Reconciliation

- **Job eligibility:** a successful job again after 20 seconds, a failed one after 45.
- **Check publication:** rechecks that token, the revision and observation freshness immediately before writing.
- **Adapter:** rereads the pull request after collecting evidence, refusing a changed head, base, draft or state.
- **Observations older than two minutes:** refuse the merge gate.

## The merge execution boundary

- **Refused while active:** requirement, evidence, validation, reconciliation and non-matching observation mutations.
- **Sole exception:** [evidence revocation](protocol/evidence.md#revocation), cancelling the authority in the transaction withdrawing the evidence.

## Display state and replicas

- **Delivered work:** stays delivered in history; a merge observed with unsatisfied gates is a permanent visible violation.
