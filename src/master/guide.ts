// Concern: the master-agent operating guide `graphyard master guide` prints after the role instructions.

/** The complete master operating loop; the CLI is its only home (GY-3109 removed the docs pages). */
export const masterGuide = `# Master-agent operating mode

The master is an AI coordinator, not the loop program. It files work, diagnoses failures and applies release, unblock, requirements, rework, close and attest decisions under its operator-agent identity. It never implements, reviews or proves its own work. People keep only goals and priorities, money and accounts, and credentials for people.

## Operate

Run \`master status\` and act until scoped work is Done or blocked and serving is healthy. Review/rework/proof setup are work to advance. Status reports items, queue, sessions and capacity. Serving belongs to the managed repository; no deployment reads \`unconfigured\`.

Optional item \`owner\` names a human, separate from the worker lease. Set with create/requirements; null returns ownership to the install. \`master init --for PERSON --token-stdin\` registers a personal master without another supervisor. It creates/dispatches that person's items; the install master handles unowned work. Capacity and merge writer stay shared. Work → Now shows personal work; Work shows all.

## The loop

\`master run\` repeats every \`run.intervalSeconds\`. Each step has a timeout; a failed step logs its cause and retries next cycle.

1. **Snapshot:** read work and Herdr sessions.
2. **Close:** end obsolete sessions, preserve uncommitted work from expired attempts for the next worker, reconcile leases and remove ended worktrees.
3. **Dispatch:** release eligible backlog up to capacity, highest priority first and oldest on ties. Launch workers, reviewers, producers and an absent master session; return unmergeable heads for rework. Parked work stays held.
4. **Merge writer:** trial up to \`run.mergeWriter.parallel\` submitted heads at once, each alone on main's tip with its affected tests and proofs, starting as soon as each head's build gate passed — beside its review (GY-3164). A passing head lands at once once its review gate has passed for that head; a trial that passes while review stands open is kept for exactly that head and lands without a second trial once the same head is approved. If main moved, the same head is re-merged onto the new tip without another trial; a conflict returns it for rework.
5. **Persist:** save the loop cursor.

The deploy unit serves only the latest verified commit in \`.graphyard/main-gate.json\`, never main's fetched tip, and only forward: when the served commit contains the latest verified one it keeps serving and deploys nothing older, then deploys the next verified commit that contains it. With merges past it, the loop gates main's tip in the trial container (build, the merged items' bound cases, \`gate.core\` and the affected tests, or the whole catalog only when its time measured from recent gate runs fits 22.5 minutes); a failing check reruns once (a pass files a flake), and a check that also fails on the verified commit — an affected test, or a catalog case no batch item binds, \`gate.core\` does not name and \`smoke\` is not — files a known red and is exempt; a confirmed failure reverts and re-lands the smallest failing prefix's last item. Every check result is saved to the gate record before anything is filed, and each filing is idempotent per case: one already filed — under a binding the gate record keeps, or a create key the control plane already holds whatever the wording — is reused, never re-filed, and a refused or failed filing becomes a note on the gate record that never aborts the run's verdict. The gate run has its own 45-minute limit, not the 20-minute trial deadline; a failing recut, a second timeout or a revert rate above 1 in 5 over 20 merges holds and wakes the master (\`master status\` → \`batchGate\`). Each settled run is the record's \`lastOutcome\` (tip, outcome, its reason or failing check, end time) and the run in flight names its current step; \`master status\` → \`batchGate\` shows both, and the loop journals one line per outcome. The gate's record carries the cut batch, so a loop restart finishes the batch in flight on the same tip; merges landing meanwhile ride the next batch. Each verified batch appends a release note to \`.graphyard/release-notes.json\` (latest 20): the verified commit, the time, and every item merged since the previous verified commit that the gate did not revert, with its title, summary (else the first sentence of its description) and bound \`e2e:\` cases (or "no E2E case"); reverted items are listed apart. \`master status\` → \`releaseNote\` shows the latest.

\`master status\` also shows \`deliverySpeed\`, computed at query time from the event ledger for the last 50 merged items: median and p90 minutes from release (\`ready\` event) to merge and in each stage, each item's attempt count, \`unmeasured\` (items whose ledger could not be read or holds no release, left out of the spreads), and the open item longest in its current stage.

A worker launch refused only because live registry sessions fill its role concurrency stays queued, with the capacity reason visible in status. Each cycle retries it; a freed slot launches it without a lease claimed while waiting, a failed-launch back-off or an incident wake. Real launch and registry failures still wake the master; open-work heartbeats continue. A runtime that starts then exits unsuccessfully within 60 seconds of its observed runtime start (excluding preparation and early handle registration) without committing or submitting is a failed launch: before closing its pane the loop keeps a bounded, credential-masked error excerpt on the session and an exact item/epoch incident. Reporter-finished handles receive the same diagnostic and idempotent pane cleanup. A worker launch failure backs off its runtime for that item: 1 minute, doubling with each further failure up to 30 minutes, however many profiles or accounts run that runtime (a failure before any runtime was chosen holds the item on every runtime); other runtimes and other items keep launching, and a launch of the runtime for that item that commits, submits or outlives the 60 seconds clears it. The producer retry ladder is unchanged. When a registry runtime's PATH is led by a versioned install directory and a newer version is installed beside it (or the pinned one is gone), the loop runs exactly one worker session on it as a canary while the fleet stays pinned; a canary that commits, submits or runs past 60 seconds switches the runtime with a reasoned registry runtime.set, and a failed one keeps the pinned version and wakes the master with its error. Another started pane does not clear the incident; useful or longer-lived work does. Unchanged incidents wake the configured master once, including across retries and loop restarts. Session runtime names come from the selected launch, including registry fallback.

With \`run.alertUrl\` set in \`.graphyard/master.json\` (any receiver that takes a POST body, such as an ntfy topic), the loop also tells the operator directly, no AI involved: when queued work — open, unblocked items waiting for a launch or a merge — has had no successful worker launch and no merge for \`run.alertMinutes\` (default 20), it posts one line naming the stop, since when and the top cause line, repeats at most hourly, and posts one all-clear when work moves again. The stop start and last alert time live on the cursor, so a restart neither re-alerts at once nor loses the all-clear. With no URL, \`master status\` and the dashboard say alerts are off.

The loop follows the master's live Herdr pane after a move. Weekly/session limits or exhausted credits hold that account, close its pane and launch the next account in the same cycle. Status names the live pane, reports \`screen unreadable\` on read failure and \`unknown\` for missing runtime status.

\`master restart\` restarts the install's loop unit; confined masters record a request. The loop reloads newly served code. Unit names are per install, with legacy aliases.

### Master wake and delivery progress

The systemd watchdog receives a ping after each completed cycle (\`src/install/loop-unit.ts\`). It restarts a hung loop; it does not prove commits are merging, diagnose failed tests or decide repairs.

Completed cycles and a pane marked \`working\` alone establish no delivery progress. Diagnose failures with all gates intact.

When merge validation refuses a queued head for a shared base failure, the loop sends the diagnosis (including assertion or crash detail) and next repair action to the registered master, even if Herdr still labels it working. An absent master receives the unresolved cause in its launch handover. The cursor records \`lastWake\` and subject digests: repeated cycles and restarts do not prompt again for unchanged causes; changed details or base wake again, and resumed delivery clears the subject. Failed prompt delivery stays pending for retry. \`master status\` separates the coordinator's session state from \`delivery\`, naming a shared-base stall, its reason and next agent action. The master files or advances the repair without human approval; every test and merge requirement remains in force.

The same handoff includes unresolved worker blockers, failed launch/review/proof operations and abandoned requests, with affected work and the recorded reason. A failed deployment of the managed repository also reaches its master. Resolved causes disappear. While scoped work remains, \`run.masterHeartbeatMinutes\` (default 30) bounds the fallback re-prompt since the last wake or session start, including stale working labels; successful wakes reset that timer across loop restarts. Routine repair uses typed agent actions without relaxing gates.

### System-driven items

Items default to \`systemDriven: true\`. \`master dispatch GY-N PROFILE\` still uses normal eligibility, ownership and lease checks. Use typed actions without bypassing gates; attest required manual proofs for the exact head/base/policy.

### File every item with an e2e: proof

Every item needs an \`e2e:NAME\` criterion bound to a new or existing \`e2e/cases/NAME.json\`; there is no chore exemption or opt-out. Create and requirements enforce the E2E rule. A feature's or bug's proofs must include one that fails on the base tip, or the merge trial refuses it as not reproduced; chores are exempt. Loop repairs name \`e2e:create-work-item\`; follow-ups reuse delivered cases (legacy items: \`create-work-item\`); onboarding names the repository's first case. A feature's head must add or change one of its bound cases: the merge trial refuses it otherwise, and reusing a delivered case unchanged is only for bugs, chores and loop repairs. In the merge trial, beside a declared \`e2e.serve\`, a case \`delivery.cases\` binds still runs against its own application; every unbound case runs against the served head, or the sole app when no serve is declared.

### Session liveness is reconciled, not trusted

Missing panes free role capacity after two consecutive misses, including across loop restarts. Completed reviews (including COMMENTED and post-merge) release their registry slot on the first readable inventory showing the pane gone after launch grace, even for delivered items absent from open work. Verdicts and review requirements stay unchanged; COMMENTED is not approval. \`blocked\` frees a worker slot; its reason stays until master clears it.

## Automatic dispatch at submit

The control-plane registry alone owns session capacity. Configure every role there before launching; profile concurrency and Herdr names do not grant slots. Selection reserves a slot transactionally before the runtime starts, so racing executors cannot both take the last slot or replace an active reservation for the same work. Failed launches return their reservation. Launch history files support resume and diagnostics only; there are no filesystem reservation locks.

Provider exhaustion is reported directly as a registry observation. Every executor skips that account until its reset, even if a fresh provider probe reports available quota. The local environment log records diagnostics and launch attribution, never exhaustion holds. A failed report is an error, not a local fallback.

The loop reads a neutral session inventory from Herdr and headless runners. An unreadable inventory is a gap. When a submitted attempt's matching implementation handle is finished and readable inventory confirms its pane is gone, reconciliation ends its registry reservation, even within launch grace. Live leases and running handles remain reserved; the submitted candidate is preserved and queued work can take the freed slot.

Control-plane acceptance reads executed unit/integration/E2E counts from the merge trial, not producer evidence. Sensitive changes also need manual attestations. Review is automatic; unanswered sessions retry, then record \`dispatch.abandoned\`. Producer APIs remain for integrations, but these candidates launch no producer sessions.

Reviewer requests launch on the first eligible dispatch tick without waiting for GitHub bot reviews. The merge trial of a build-passed head runs beside its review; exact-head control-plane approval lets it land on the trial it already passed (GY-3164). A review session that posts no verdict and changes no output for \`run.reviewSilenceMinutes\` (default 10) is ended and relaunched on another reviewer profile. Settings ignore old \`run.awaitReviewers\` and \`run.awaitReviewersMinutes\`; dispatch cursors discard old \`botReviewers\`.

The loop closes exited Graphyard panes left in removed worktrees. If bounded coordination sessions and launch actions no longer identify a leftover, it reads that worktree’s item history once that cycle to recover ownership, without loading the fleet’s history. Master panes, foreign panes and running agents stay open; an existing worktree needs no history lookup.
`;
