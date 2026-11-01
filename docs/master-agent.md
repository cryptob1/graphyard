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

Completed cycles and a pane marked `working` alone establish no delivery progress. Diagnose failures with all gates intact.

When merge validation refuses a queued head for a shared base failure, the loop sends the diagnosis (including assertion or crash detail) and next repair action to the registered master, even if Herdr still labels it working. An absent master receives the unresolved cause in its launch handover. The cursor records `lastWake` and subject digests: repeated cycles and restarts do not prompt again for unchanged causes; changed details or base wake again, and resumed delivery clears the subject. Failed prompt delivery stays pending for retry. `master status` separates the coordinator's session state from `delivery`, naming a shared-base stall, its reason and next agent action. The master files or advances the repair without human approval; every test and merge requirement remains in force.

The same handoff includes unresolved worker blockers, failed launch/review/proof operations and abandoned requests, with affected work and the recorded reason. A failed deployment of the managed repository also reaches its master. Resolved causes disappear. While scoped work remains, `run.masterHeartbeatMinutes` (default 30) bounds the fallback re-prompt since the last wake or session start, including stale working labels; successful wakes reset that timer across loop restarts. Routine repair uses typed agent actions without relaxing gates.

### System-driven items

Items default to `systemDriven: true`. `master dispatch GY-N PROFILE` still uses normal eligibility, ownership and lease checks. Use typed actions without bypassing gates; attest required manual proofs for the exact head/base/policy.

### File user-facing items with an e2e: proof by default

Create and requirements enforce the [E2E rule and opt-out](validation.md#every-user-facing-item-carries-an-e2e-proof).

### Session liveness is reconciled, not trusted

Missing panes free role capacity after two consecutive misses, including across loop restarts. `blocked` frees a worker slot; the reason stays until master clears it.

## Automatic dispatch at submit

Control-plane acceptance reads executed unit/integration/E2E counts from the merge trial, not producer evidence. Sensitive changes also need manual attestations. Review is automatic; unanswered sessions retry, then record `dispatch.abandoned`. Producer APIs remain for integrations, but these candidates launch no producer sessions.
