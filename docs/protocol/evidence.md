<!-- page: Agent protocol | 9 | evidence submission, proof authority grants, and the post-deployment smoke proof. -->
# Evidence and proof authority

```json
{
  "proof": "integration:claim-safety",
  "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "baseSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "policyRevision": 1,
  "result": "pass",
  "executed": 32,
  "skipped": 0,
  "url": "https://github.com/OWNER/REPO/actions/runs/RUN"
}
```

SHA fields are full 40-character lowercase Git SHAs. Results are `pass` or `fail`. Counts must be nonnegative integers. For manual acceptance, executed means the number of criteria actually inspected, not a fabricated test count.

The server supplies evidence ID, identity, timestamp, and trust. Clients cannot set `trusted` or `producer`. Unknown fields are rejected. A producer may submit an unauthorized proof, but it remains untrusted. A producer is a trust boundary, not a guarantee that its test was well designed.

## Proof authority

Trust is decided against the live grant set inside each mutation transaction, never against process configuration. `POST /api/proof-grants/ID/grant` and `POST /api/proof-grants/ID/revoke` take `{ "patterns": [...], "reason": "...", "expectedRevision": N }` and require the `admin` role; `expectedRevision` is optional and refuses a stale write when supplied. A pattern is an exact proof name, a whole kind such as `integration:*`, or a bounded prefix such as `manual:gy-43/*`; nothing else parses. Grants apply only to `producer` principals — `worker`, `reader`, `coordinator` and `operator-agent` are refused with `403` — while `admin` holds the `manual:*` lane by role. Validation collector registrations are bounded by the same live authority, so revoking a grant immediately withdraws a collector's scope. Environment allowlists seed the grant store once at startup and decide nothing afterwards. See [Proof authority grants](../operations-reference.md#proof-authority-grants).

Work creation and every requirement revision record `proofGaps`: the required proof names that had no authorized producer at that moment. A nonempty list means the acceptance gate cannot be satisfied by anyone, and it is visible in `graphyard status`, `graphyard diagnose`, and the dashboard before the item is dispatched.

All required proof names must pass. Evidence is selected for the exact head/base/policy tuple. A later matching failure supersedes an earlier pass. Stale evidence is retained for audit without satisfying the current candidate. A record carrying a `reuse` block was derived for its head from an executed attempt's pass by a recorded [reuse decision](../evidence-reuse.md#reuse-decisions); it names the decision, the original evidence, the executed head and the attempt sequence, and any newer live attempt for the proof supersedes it.

### CI-produced evidence

`unit:*` and `integration:*` proofs whose contract is registered in `scripts/contracts.mjs` are also produced without a producer session: the protected acceptance workflow runs every such proof of an item on each push to its candidate branch and publishes the results through one dedicated **CI producer** principal — a `producer` whose `runtime` is `github-actions` in `GRAPHYARD_PRINCIPALS`, granted `unit:*` and `integration:*` and nothing else (see [trusted test producers](../github.md#trusted-test-producers) for the workflow and [deployment](../deployment.md#ci-producer) for provisioning). Its records carry a run binding the reporter supplies:

```json
{
  "proof": "integration:claim-safety",
  "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "baseSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "policyRevision": 1,
  "result": "pass",
  "executed": 5,
  "skipped": 0,
  "url": "https://github.com/OWNER/REPO/actions/runs/RUN/attempts/ATTEMPT",
  "artifacts": [{ "kind": "log", "label": "GitHub Actions job integration:claim-safety", "availability": "external", "url": "https://github.com/OWNER/REPO/actions/runs/RUN/job/JOB" }],
  "ciRun": { "provider": "github-actions", "repository": "OWNER/REPO", "runId": "RUN", "runAttempt": 1, "jobId": 4242 }
}
```

`sha`, `baseSha` and `policyRevision` are read from the item's candidate record at run time, and the run URL is the evidence artifact. The lane is a trust boundary of its own, judged inside the mutation and refused — never stored untrusted — when any part fails:

- Only the CI producer may submit a `ciRun` binding, and it must submit one; any other producer, worker or operator sending `ciRun` is refused with `403`, and the CI producer sending none with `400`.
- Only `unit:*` and `integration:*` proofs are accepted from it. `manual:*` and `e2e:*` proofs — the post-deployment smoke proof included — are refused with `403` whatever the principal is granted: a `manual:*` grant made to the CI producer is inert. The proof must additionally be covered by its live grant.
- The control plane reads the named job back from GitHub through its own App (`GET /repos/OWNER/REPO/check-runs/JOB`, the `Checks: read` permission it already holds) before the transaction. The job must be GitHub Actions' own check run (the engine's trusted CI App set), belong to workflow run `runId`, have run on exactly the evidence `sha`, have completed, and have concluded `success` for a `pass` or otherwise for a `fail`. A mismatch refuses with `403`; a job GitHub cannot report, or a deployment without a GitHub integration, refuses with `503`.
- A record for the same proof, head, base and policy revision is accepted only from a strictly newer run attempt — a later run, or a later attempt of the same run. Re-running an older attempt, or re-publishing the same one, is refused with `409` so an older attempt can never overwrite a newer result.

The accepted record stores the verified binding as `ciRun` — the run id and attempt, the job id and name, the head GitHub reported, the conclusion, and when it was verified — beside the ordinary fields. It is selected, superseded, carried and revoked like any other trusted record. The reporter (`scripts/publish-acceptance.mjs`) makes the same checks against GitHub's Actions API before submitting, and refuses a run whose `head_sha` is not the candidate head or whose event is not `pull_request_target` or `workflow_dispatch`, the two whose workflow definition comes from the protected default branch.

### Revocation

`POST /api/work/:id/revoke` withdraws accepted evidence that should no longer authorize a candidate:

```json
{
  "proof": "integration:claim-safety",
  "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "baseSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "policyRevision": 1,
  "reason": "Reported run was attributed to the wrong artifact"
}
```

Only an `admin` (the human operator), or the trusted producer whose live [proof grant](#proof-authority) covers that exact proof name, may revoke; workers, coordinators, other producers and operator agents are refused. The tuple is pinned deliberately: a request that matches no trusted record refuses with 404 rather than silently withdrawing nothing.

Revocation withdraws *every* trusted record for that tuple, and every record derived from one of them by reuse, so an older accepted run cannot quietly re-authorize the same candidate or a later head. Records are annotated, never deleted; each keeps a `revocation` object naming the actor, reason and time. The acceptance gate then names the withdrawal explicitly instead of reporting the proof as merely unmeasured, and reconciliation republishes a refusing GitHub check. A later trusted run for the same candidate satisfies acceptance again; the merge queue, however, ejects a revoked entry as it would a failed proof, so the ejected commit does not re-enter and a new candidate lands at the back of the queue.

Revocation may interrupt an active merge execution until the broker's transactional provider-commit boundary; it then serializes before the commit and cancels it, or serializes after it and refuses because the provider mutation is already irrevocably in flight. That refusal does not lapse with the execution's expiry: a committed execution stays on the record until a GitHub observation settles the provider outcome — the merge is attributed, or the pull request is observed still unmerged after the authority ran out — and only then does the tuple become revocable again. See [the merge broker](../github.md#enforcement-boundary). Delivered work is immutable and refuses revocation: use a follow-up task.

`e2e:deploy-smoke` is the one proof submitted after delivery. For it, `sha` is the deployed commit the checks ran against — the one recorded by the `deployment` command — and `baseSha` is the item's merge commit. It is accepted only from a producer granted that proof, only when the work policy sets `deploySmoke`, only after the deployment observation exists, and only with exactly those two commits and the current policy revision; any other submission is refused rather than stored untrusted. The result is recorded as `delivery.smoke`.
