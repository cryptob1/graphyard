<!-- page: Operate Graphyard | 6 | merge ownership -->
# Delivery redesign

## One rule

Only Graphyard writes to main. All installs now use the control-plane merge writer; the old GitHub gates and shadow mode are retired.

## Flow

A worker submits its commit, Graphyard checks gates, the merge writer trials and pushes main, and a separate deploy supervisor serves it. See [delivery](delivery.md) for procedures and failure handling.

## Merge writer

Up to four oldest heads share a trial and push; failed batches retry individually. Ledger order: `merge.intent`, tested merge commit, `merge.pushed`, `merge.reconciled`. Push uses `git push --force-with-lease`; a moved tip retrials. Lost replies replay idempotently. A superseded intent is refused and the current head queued again. Status: `mergeWriter.queue`.

## The merger

Only the writer receives the deploy key. Candidates come from the shared object store, base repairs and `Hotfix:` first. `/api/work/:id/merge-record` refuses pushed/reconciled commits that differ from the open intent. A `refused` record names the submitted head or the open intent superseded by resubmission.

## Rollout

Control-plane mode is shipped; the Snake pilot remains the rollout exercise.

## Measures

Use item histories and serving observations. Aggregate throughput/latency metrics are not recorded.
