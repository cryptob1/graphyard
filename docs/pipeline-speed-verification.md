<!-- page: Operate Graphyard | 12 | post-merge verification of the pipeline-speed criteria: the commands that read the deployed control plane, and what they found. -->
# Pipeline-speed verification

Two of [GY-54](master-agent-reference.md#pipeline-speed)'s criteria are measurements of a running deployment, not properties of a diff: CI must publish trusted evidence automatically once the change is live, and routine deliveries merged *after* it is live must land inside the speed target. Neither can be demonstrated by the change that makes it true, so they are verified here, after the merge, against the deployment that serves it.

Everything below reads the deployed control plane or GitHub. Nothing is asserted from the repository. Each record is dated, and a verdict is only as current as the record under it: re-run the procedure before citing one.

| Criterion | What it requires | Read from |
| --- | --- | --- |
| AC-1 `manual:speed-ci-proofs-live-postmerge` | CI publishes trusted `unit:`/`integration:` evidence with no hand-started run, for an item whose contracts are registered on `main`, with cached dependencies; `manual:` proofs in `producerProofs` are requested at submit | `/api/work-snapshot` evidence records, the GitHub Actions run each one names, and the item's dispatch requests |
| AC-2 `manual:speed-target-met-postmerge` | Over at least ten routine deliveries merged after the deployment, submit→merge p50 ≤ 30 min and p90 ≤ 60 min | `scripts/measure-pipeline-speed.mjs` against the deployed timelines |

The deployment instant is the one recorded on GY-54's delivery — `delivery.deployment.at`, `2026-09-20T16:57:11.865Z`, covering merge `c6da88f5332c` exactly. Every window below starts there.

## AC-1 — CI publishes trusted evidence automatically

### The procedure

Each clause is read separately; a clause nobody can read is reported unverified, never assumed.

```sh
# 1. Every CI publication since the deployment: when, which proof, which producer, which run.
curl -sH "Authorization: Bearer $GRAPHYARD_TOKEN" "$GRAPHYARD_URL/api/work-snapshot" |
  jq -r '.work[].evidence[]
         | select(.provenance.provider == "github-actions" and .at > "2026-09-20T16:57:11.865Z")
         | [.at, .proof, .producer, .provenance.runId] | @tsv'

# 2. What started each run, and whether a person did: workflow_dispatch is the master loop's own
#    `gh workflow run` (src/master-daemon.ts, requestProof); pull_request_target is the push itself.
gh api repos/OWNER/REPO/actions/runs/RUN_ID \
  --jq '{event, run_started_at, triggering_actor: .triggering_actor.login}'

# 3. Which proofs the run planned, and which it left to producer sessions, in the plan job's own log.
gh run view RUN_ID --repo OWNER/REPO --job PLAN_JOB_ID --log | grep -E 'Dispatch:|Planned|Nothing to run'

# 4. Dependency caching: the cache steps and their durations on the job that executed the contract.
gh api repos/OWNER/REPO/actions/runs/RUN_ID/jobs \
  --jq '.jobs[] | {name, steps: [.steps[] | {name, conclusion, started_at, completed_at}]}'

# 5. Manual proofs requested at submit: the gap between pipeline.submittedAt and the manual
#    producer request for the same head, on an item that carries producerProofs.
graphyard status GY-N |
  jq '{submittedAt: .pipeline.submittedAt,
       manual: [(.autoDispatch.producers[], .autoDispatch.history[])
                | select(.group == "manual") | {requestedAt, proofs, sha: .sha[0:12]}]}'
```

### Standing record — 2026-09-21T23:46Z

| Clause | Observed | Verdict |
| --- | --- | --- |
| Trusted evidence published by CI | 67 records across 20 items since the deployment, every one `trusted`, `executed: 5`, `skipped: 0`, bound to the evidence commit and to the job the control plane read back from GitHub | Holds |
| No hand-started run | All 67 came from an `acceptance.yml` run the master loop requested itself (`event: workflow_dispatch`, `ref: main`); the candidate lane additionally runs on every candidate push (`pull_request_target`). No run was started by a person | Holds |
| For an item whose contracts are registered on `main` | All 67 records are `integration:claim-safety`, and no item required it: it is the *default* of the workflow's `proof` input. The loop's request names no proof — `requestProof` sends `pr`, `work_id` and `policy_revision` only — so every dispatch certifies that default. The candidate lane plans only registered contracts and has published nothing: the `ci-proofs` producer has never published a record on this deployment | Partial — the lane is live and trusted, but no item's *own* required proof has been certified by CI since the deployment |
| Cached dependencies | Run `35663665694` (GY-87, PR #93): `actions/setup-node` with `cache: npm`, the `postgres:17-alpine` image restored from cache in 3 s, and the per-pull-request Docker layer cache (`type=gha`) carrying the build in 37 s. Loop request 22:37:54Z → published evidence 22:39:31Z: **97 s** | Holds |
| `manual:` proofs requested at submit | Six post-deployment submissions carrying `producerProofs`; the manual group was requested 2.8–8.4 s after `pipeline.submittedAt` every time — GY-90 2.8 s, GY-95 3.1 s, GY-93 3.8 s, GY-103 6.2 s, GY-97 6.9 s, GY-101 8.4 s | Holds |

The gap is not a broken lane; it is an empty one. `scripts/contracts.mjs` registers four contracts on `main` (`integration:claim-safety`, `integration:herdr-recovery`, `integration:merge-authorization`, `unit:ci-proofs-enumeration`). No item submitted since the deployment has required one of them, so the candidate lane plans nothing and says so in its own log — for GY-103's head `419939cc1b2c` at 2026-09-21T23:44:04Z:

```text
Planned no proofs for GY-103 PR #105 at 419939cc1b2c…; left to producer sessions:
unit:approver-name-bounded-and-unique (no registered contract; a producer session must run it
until one reaches main), … manual:blocked-approvals-cleared (manual:* proofs are not automatable in CI).
```

That is the bootstrap ordering rule working as written. Its consequence is that every `unit:` and `integration:` proof which actually decides an item's acceptance gate is still produced by a `production-acceptance-producer` agent session — which is where the minutes AC-2 measures go.

## AC-2 — routine submit→merge p50 ≤ 30 min, p90 ≤ 60 min

### The procedure

```sh
GRAPHYARD_URL=… GRAPHYARD_TOKEN_FILE=… node scripts/measure-pipeline-speed.mjs \
  --since 2026-09-20T16:57:11.865Z --record .graphyard/measurements/pipeline-speed
```

`--since` bounds the window at the deployment instant. `--split GY-54` answers a slightly different question — it splits at GY-54's *merge* (`2026-09-20T16:54:26.358Z`) and counts GY-54's own delivery in `after` — and over this window the two agree, because no routine item merged in the 2 m 45 s between the merge and the deployment.

The verdict is the script's, not the reader's: `met` is `true` or `false` only once ten routine deliveries are measured, and `null` with the count until then. A routine delivery is one with at most one rework round and no hand-off — a `blocked` report or a requirements revision — between submit and merge.

### Standing record — 2026-09-21T23:46Z

```text
Overall: 15 measured (5 routine, 0 unmeasured); submit→merge p50 741.2 min p90 1227.4 min;
routine p50 112.2 min p90 334.1 min; rework median 2 p90 4; hand-offs on 6 item(s);
execution share 31%; target not judged (5 routine deliveries measured; the target is judged over at least 10)
```

| Routine delivery | Merged | Submit→merge | Rework rounds | Last gate satisfied → merge |
| --- | --- | --- | --- | --- |
| GY-85 | 2026-09-20T19:15:54Z | 18.0 min | 0 | 3.2 min |
| GY-83 | 2026-09-20T18:55:54Z | 52.2 min | 0 | 44.0 min |
| GY-96 | 2026-09-21T04:37:24Z | 112.2 min | 1 | 12.1 min |
| GY-90 | 2026-09-21T05:22:05Z | 161.5 min | 1 | 0.8 min |
| GY-86 | 2026-09-21T01:21:54Z | 334.1 min | 1 | 270.9 min |

Coverage is complete: every delivery in the window is measured from its own timeline, and none is `awaiting-backfill`, `events-pruned` or `no-submission`.

**AC-2 is not judgeable on this record, and is missed on the population that exists.** Five of the ten routine deliveries it is stated over have merged; their p50 is 112.2 min against a 30 min target and their p90 is 334.1 min against 60 min. Five more deliveries of today's shape would not bring either figure inside the target.

### Where the time goes

Three sinks account for the misses, each visible in the item's own timeline:

- **A rework round restarts every proof.** GY-86, GY-90 and GY-96 each took one reviewer *requested changes* verdict, and the next head re-requests the review and every producer group from zero. GY-90's first head had every gate satisfied 6.4 min after submit and still merged 161.5 min after it; 100 min of that was the interval between the verdict and the next pushed head. The post-deployment rework median over all deliveries is 2, above the target's 1.
- **Producer sessions, not CI, run the automatable proofs.** A group costs 2–23 min per head — GY-96's first head paid 21.0 min for one `unit:` proof and 22.7 min for three `integration:` proofs — and pays it again on every head. This is the same gap the AC-1 record names: the proofs that must pass have no registered contract, so no CI lane can carry them.
- **A hand-off or a base move after the last gate.** GY-83 sat 44 min with every gate passing, behind a lease-loss escalation; it merged 30 s after that decision was taken (requested 18:53:46Z, approved 18:55:21Z, merged 18:55:51Z). GY-86 sat 270.9 min after its last proof until the queue carried its approval and proofs onto the moved base at 01:14:58Z, and merged at 01:21:51Z.

None of this is traded against a gate, a proof, an identity rule or a lease rule. The figures move when the rework round, the producer session and the post-gate wait are removed — not when the target is.

## Re-running this verification

Run both procedures against the live deployment, replace each standing record with the dated output, and leave the verdicts as the commands report them. `master status` carries the same figures continuously under `speed`; this page exists so that the two post-merge criteria are judged by a stated procedure rather than by whichever number was read on the day.
