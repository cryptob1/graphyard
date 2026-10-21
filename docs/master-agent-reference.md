<!-- page: Operate Graphyard | 7 | typed actions -->
# Master-agent reference

## Items and human waits

Human: `park GY-N EPOCH KIND NEEDED --ask ASK --recommend TEXT --why WHY [--choice LABEL]… -- REASON` ([the dashboard](onboarding.md#the-dashboard)); `answer GY-N …`; criterion-rewrite asks refused.

## Promotion to autonomy

`graphyard master promote --admin-token-stdin` makes installs autonomous; needs a reviewer profile; provisions operator-agent, approver.

## Conflict avoidance

Dispatch is optimistic (overlap holds nothing); `git merge-tree` reports `conflicts`.

## GitHub administration through the browser

Graphyard's one remote credential is the merge writer's deploy key ([install](install.md)). `master browser app-permissions|installation-accept|capture` therefore refuse, naming the missing credential. On classifier refusals `master harness claude|codex --apply` writes `.claude/settings.local.json` rules denying `gh pr merge`/`review`, token-minting or mutating `gh api`; `harness` drift is reapplied each cycle.

## Typed actions

`nextAction`: `dispatch`/`request-review`/`request-rework`/`approve-scope`/`resync`/`reclaim`/`merge`/`escalate`. `dispatch`/`request-review` complete if a session answers the head. Three failures, unchanged reason: stalled rather than retrying; backoff never outlives it.

## Recovery

Dead supervisor fences item; `containment` lists survivors: `settleable: true` → loop settles; past grace `master settle-containment GY-N REASON`. Explained `lease-loss` settles by reconciliation or `admin` `resolve … --attestation`; `security-concern`, `requirement-weakening`, `evidence-policy-conflict` need a two-party decision.

### Producer-runtime faults

Unacted producer requests relaunch on untried profile.

## Fault classes

`faultClass` (`master status` `faults`): a past-threshold class is one attention line, never an item; a cycle over 60s is attention, never an item; an unbound [stall](operations.md#master-coordination-loop) wakes the master session once per run at three failing cycles (bound: remedy refused, unverified or failing at six); `master status` lists each stall's signature, count, remedy, owner, filing nothing; a queue-held trial, push or `base failure` refusal is the writer's motion, never a fault. Review unlaunched 15min: `concurrency-starved`/`review-settlement`/`launch-review`.

## Merge trial

The merge writer's trial, the only trial: the merge commit's build and affected tests (dashboard changes: `npx playwright install chromium`, then `npm run test:browser`), credential-free in a sticky tmp-reclaimed `TMPDIR`, killed after 20 minutes.

## Pipeline speed

Target: submit→merge p50 ≤30min, p90 ≤60min (`scripts/measure-pipeline-speed.mjs`). `leadTime` (top bar, `master status`): median released→merged, last 10 merges. Steps calling an approver, decision or session budget two-fifths of the interval (30s floor), each call 10s or what's left; a slower one is carried (`waiting`, no fault), retried next cycle, joining it or consuming its answer, kept while its row stands; spent, it starts none; one `decision.*` ledger read names moved items, an unmoved history is kept unread.
