<!-- page: Operate Graphyard | 6 | merge ownership -->
# Delivery redesign

## One rule

Only Graphyard writes to main. All installs now use the control-plane merge writer; the old GitHub gates and shadow mode are retired.

## Flow

A worker submits its commit, Graphyard checks gates, the merge writer trials and pushes main, and a separate deploy supervisor serves it. See [delivery](delivery.md) for procedures and failure handling.

## Merge writer

Up to four oldest heads share a trial and push; failed batches retry individually. Ledger order: `merge.intent`, tested merge commit, `merge.pushed`, `merge.reconciled`. Push uses `git push --force-with-lease`; a moved tip retrials. Lost replies replay idempotently. A superseded intent is refused and the current head queued again. Status: `mergeWriter.queue`. Master status also shows `mergeWriter.trials`: the last 20 completed trials, their covered item/head pairs and step durations in milliseconds (including scan, bound E2E cases (`tests: e2e`, also on failure), test shards, preview and push when run). Batch fallbacks and retrials have separate records. `mergeWriter.stepMedians` reports each step’s median milliseconds across those records; older state starts with no timings. Timings are diagnostic, not gate evidence.

## The merger

The control plane is every install's only merge writer: nothing sets another, and old `policy.merger.set` events are never read. Launches get no push credential or keyring proxy; setup and `doctor` name no remote-side setup beyond the merge writer's deploy key. Candidates: object store, `Hotfix:`/base-repair first, then oldest item. `POST /api/work/:id/merge-record` records each step; `pushed`/`reconciled` name the open intent's merge commit, else 409. A `refused` names the submitted head, or the open intent its resubmission superseded. Ordinary reconciliation retains its ancestry check. Restart also recovers an orphan/unpushed refusal when first-parent main holds its original merge: the latest actual passing trial must retain the original head, base, policy, review and required proof bindings. Later unrelated main progress may advance the observed candidate base: recovery judges the preserved original flight, with unchanged current head, requirements and accepted approval, without retargeting proof. Recovery appends pushed/reconciled records without rerunning the trial, changing counts or pushing again; other refusals remain held. A confirmed recovery rejection keeps the original intent and trial held and reports its reason; the cycle excludes that head from fresh merges while advancing unrelated candidates. Unknown replies remain errors.

## Rollout

Control-plane mode is shipped; the Snake pilot remains the rollout exercise.

## Measures

Use item histories and serving observations. Aggregate throughput/latency metrics are not recorded.

Before a leased push, single and batch writers require each declared `unit:`/`integration:`/`e2e:` proof to report `executed > 0` and `failed = 0` in the real trial. A successful command alone supplies no proof count. Missing, unexecuted or failing proofs keep their actual trial records and refuse the head with the proof name for ordinary rework. A failed batch retries individually. Other items’ proofs and declared post-deploy observations add no premerge requirement.
