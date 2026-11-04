<!-- page: Operate Graphyard | 6 | merge writer, rollout. -->
# Delivery redesign

## One rule

Only Graphyard writes to main.

## Flow

1. **Head submission under a lease:** `complete GY-N EPOCH --head SHA`; the lease ends in the same transaction.
2. **One serial merge writer** records merge intent, then pushes the exact tested merge commit with the install's deploy key, leased on the tested tip; between them it trial-merges and runs build and fast tests on the merged tree.
3. **Each new main is deployed by the loop**, its E2E cases run, and a failing deploy is rolled back.
4. **One independent reviewer per item.** Sensitive diffs get a blocking review before step 2; the rest a non-blocking review after merge.

## Merge writer

Four oldest heads share one trial and push, each delivered at its commit; a failed batch merges singly: `merge.intent`, merge-commit trial (affected and proof tests, one retry), `git push --force-with-lease` with `run.mergeWriter.deployKeyFile` alone, `merge.pushed`, `merge.reconciled` delivers. A moved tip re-trials; a conflict or failed trial reworks. Lost replies replay; reused-key refusals adopt the ledger; a superseded intent is refused and the current head queued again. `master status`: `mergeWriter.queue`.

## The merger

The control plane is every install's only merge writer: nothing sets another, and old `policy.merger.set` events are never read. Launches get no push credential or keyring proxy; setup and `doctor` name no remote-side setup beyond the merge writer's deploy key. Candidates: object store, `Hotfix:`/base-repair first, then oldest item. `POST /api/work/:id/merge-record` records each step; `pushed`/`reconciled` name the open intent's merge commit, else 409. A `refused` names the submitted head, or the open intent its resubmission superseded. Ordinary reconciliation retains its ancestry check. Restart also recovers an orphan/unpushed refusal when first-parent main holds its original merge: the latest actual passing trial must retain the original head, base, policy, review and required proof bindings. Later unrelated main progress may advance the observed candidate base: recovery judges the preserved original flight, with unchanged current head, requirements and accepted approval, without retargeting proof. Recovery appends pushed/reconciled records without rerunning the trial, changing counts or pushing again; other refusals remain held. A confirmed recovery rejection keeps the original intent and trial held and reports its reason; the cycle excludes that head from fresh merges while advancing unrelated candidates. Unknown replies remain errors.

## Rollout

1. **Shadow mode**: trials beside the old gate, nothing written; done, and deleted (GY-2087).
2. **Switch** `control-plane`: done, for every install.
3. **Run the Snake pilot.**
4. **Done (GY-2010):** the github-mode API client, webhooks, caches and main guard are deleted; gates read the merge ledger alone.

## Measures

None is recorded: Graphyard keeps no throughput, lead-time or latency reading (GY-2876).

Before the leased push, single and batch writers require every declared `unit:`/`integration:`/`e2e:` proof to have `executed > 0` and `failed = 0` in the real trial. A successful command alone supplies no proof count. Missing, unexecuted or failing proofs retain their actual trial records and refuse the head with the proof name for ordinary rework; a failed batch falls back to individual trials. Other items’ proofs and declared post-deploy observations add no premerge requirement.
