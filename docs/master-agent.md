<!-- page: Operate Graphyard | 5 | coordinate work and diagnose stalls -->
# Master-agent operating mode

The master is an AI coordinator, not the loop program. It files work, diagnoses failures and applies release, unblock, requirements, rework, close and attest decisions under its operator-agent identity. It never implements, reviews or proves its own work. People keep only goals and priorities, money and accounts, and credentials for people.

## Operate

Run `master status` and act until scoped work is Done or blocked and serving is healthy. Review/rework/proof setup are work to advance. Status reports items, queue, sessions and capacity. Serving belongs to the managed repository; no deployment reads `unconfigured`.

Optional item `owner` names a human, separate from the worker lease. Set with create/requirements; null returns ownership to the install. `master init --for PERSON --token-stdin` registers a personal master without another supervisor. It creates/dispatches that person's items; the install master handles unowned work. Capacity and merge writer stay shared. Work → Now shows personal work; Work shows all.

## The loop

`master run` repeats every `run.intervalSeconds`. Each step has a timeout; a failed step logs its cause and retries next cycle.

1. **Snapshot:** read work and Herdr sessions.
2. **Close:** end obsolete sessions, preserve uncommitted work from expired attempts for the next worker, reconcile leases and remove ended worktrees.
3. **Dispatch:** release eligible backlog up to capacity, highest priority first and oldest on ties. Launch workers, spec checks, reviewers, producers and an absent master session; return unmergeable heads for rework. Parked work stays held.
4. **Merge writer:** trial and merge submitted heads in order ([delivery](delivery.md)).
5. **Persist:** save the loop cursor.

`master restart` restarts the install's loop unit; confined masters record a request. The loop reloads newly served code. [Unit names](delivery.md#continuous-deployment) are per install, with legacy aliases.

### Master wake and delivery progress

The systemd watchdog receives a ping after each completed cycle (`src/supervisor.ts`). It restarts a hung loop; it does not prove commits are merging, diagnose failed tests or decide repairs.

At this worktree's base, the loop adopts or launches a master and replaces exited or provider-limited panes. It does not prompt an existing master about delivery failures. GY-3047's submitted candidate `ca55ddb7c2a7` adds prompts for changed blockers, failed operations, review/proof launches, shared-base failures and deployment failures, plus a bounded heartbeat while open work remains. That candidate is pending work, not evidence that a deployed install has it. Check the serving and loaded commits before relying on those wakes.

Completed cycles and a pane marked `working` alone establish no delivery progress. Diagnose failures with all gates intact.

### System-driven items

Items default to `systemDriven: true`. `master dispatch GY-N PROFILE` still uses normal eligibility, ownership and lease checks. Use typed actions without bypassing gates; attest required manual proofs for the exact head/base/policy.

### File user-facing items with an e2e: proof by default

Create and requirements enforce the [E2E rule and opt-out](validation.md#every-user-facing-item-carries-an-e2e-proof).

### Session liveness is reconciled, not trusted

Missing panes free role capacity after two consecutive misses, including across loop restarts. `blocked` frees a worker slot; the reason stays until master clears it.

## Automatic dispatch at submit

Control-plane acceptance reads executed unit/integration/E2E counts from the merge trial, not producer evidence. Sensitive changes also need manual attestations. Review is automatic; unanswered sessions retry, then record `dispatch.abandoned`. Producer APIs remain for integrations, but these candidates launch no producer sessions.
