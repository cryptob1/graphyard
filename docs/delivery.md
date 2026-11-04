<!-- page: Build integrations | 4 | trials, deploys and recovery -->
# Releases and delivery

## One delivery path

Exact-candidate gates allow merge. The merge writer alone pushes main; a separate deploy supervisor serves it. Done means merged, not live or verified. See [merge ownership](delivery-redesign.md).

The control plane always merges passing heads; Delivery names it as the merge writer. There is no merger-mode or automatic-merging setting. `master init` refuses the retired `--auto-merge`/`--no-auto-merge` flags. `/api/auto-merge` and `POST /api/merge-queue` are removed; `GET /api/merger` remains for the E2E delivery probe. Old policy events remain in history; rewriting old master config drops `autoMerge` and `mergeQueue.rerunFailedChecks`.

## Continuous deployment

`master init` installs loop and deploy user units; the loop restores a missing deploy unit. New names include the repository; legacy names are `graphyard-master.service` and `graphyard-deploy.service`.

The deploy unit runs `graphyard upgrade --watch --checkout <install>/deploy/src`: fetch, build, restart and verify health at the expected commit. It retains serving/previous images. Failed deploys restore when safe; migrations may require roll-forward. `.graphyard/deploy.json` names the serving tip and repository; the loop reloads newly served code. For managed apps, see [serve configuration and live checks](deployment.md#serving-the-managed-repositorys-app).

## Merge trials

Trials run [without credentials](master-agent-reference.md#merge-trial). Commands prefer the running Node installation over host version-manager shims, so the fresh HOME needs no host mise trust setup. A successful merge trials before pushing and schedules no advisory trial afterwards; older cursors discard that retired ledger. `mergeWriter.inFlight` names the step/start; 30 minutes without advancement or exit without verdict reports a stall. Logs include durations; abandoned checkouts are reclaimed.

`scripts/ci-tests.mjs` selects affected/proof tests. Each selected Node test file has a five-minute bound; a hung file fails by name through the ordinary flake/base retry logic. The bounded runner preserves the caller’s TAP reporter so required proofs count as executed. Identical trees do not reuse prior trial proofs. E2E shutdown cancels its grace timer once the server exits, so completed case runners exit promptly. The overall trial deadline remains 20 minutes. Otherwise use `delivery.mergeGate.preMerge`, falling back to npm test/typecheck. Missing checks are explicit in trial/status/doctor. Overall trial timeouts requeue. Head failures request rework; failures reproduced on base hold the head as `base failure` so repairs go first. Bug proofs must fail on base or the head refuses as `not reproduced`.

Batches record each head’s merge intent before starting their shared trial. The board counts all heads in running positions as in flight; remaining heads show their waiting position and the flight ahead, while recorded blockers remain Blocked.

Opening (including fallback/retrial) and landing re-read candidate, policy, rework, ownership and build/review gates. Obsolete flights requeue without pushing or disturbing replacement leases; incidental work revisions do not fence a valid flight. Already-pushed reconciliation retains its original intent and proof bindings. Current-candidate trial results remain in case history even when build or review gates hold landing; obsolete trials supply no replacement evidence. The daemon summary shows standing merge refusals from the ledger; after an item lands, its earlier refusals remain in ledger history only.

Required live-case failures after the last verified commit can trigger a gated revert. The loop chooses the landing whose proof names the case, else the newest identifiable landing, and files one `Re-land GY-N` with original criteria and failed case. Further failures keep that culprit. Production and serve-revert unit tests share the revert sequence; the loop persists and schedules its trial beside the cycle. Reverts, refused reverts and re-land filings are recorded transactionally as `merge.serve-revert` events on the culprit’s merge ledger, folded beside its merge state. The loop reads already-reverted merges and standing refusals from that ledger after restart or cursor archival; the cursor keeps in-flight work, not outcome history. A failing revert trial holds; an indeterminate trial waits the base-failure interval unless main moves.

### E2E record credential

`e2e record` uses `GRAPHYARD_E2E_RECORD_TOKEN`. Workers do not receive this trusted producer credential.

## Managed repositories

`init --scan` discovers checks; `--apply` writes `delivery.mergeGate` in `graphyard.json`. `deploy.adapter` is `railway` or `command`; `install --plan` lists the setup.

`mode: local` uses the command adapter. `delivery.applications`/`delivery.cases` bind static previews (`/preview/KEY/`) or isolated Compose apps. Merger remains control-plane.

Repository policy includes `risk.sensitive` entries `{rule,glob}` and `e2e.pendingOutcomes` (`non-blocking` or `blocking`), deployed as `GRAPHYARD_REPOSITORY_POLICY`.

## Release API

Registered builders build; admins or promoters select releases; observers acquire `POST /api/delivery/lease`. Environments register as `{"kind":"environment","services":[…]}` and observers as `{"kind":"registration","role":"observer"}`.

`POST /api/delivery/build` records the registered builder, source SHA, input digest and artifacts:

```json
{"registration":{"id":"production-builder","revision":1},"sourceSha":"0123456789abcdef0123456789abcdef01234567","buildInputsDigest":"sha256:5b8e0d3a7f21c94e6082d5b1a3f7c0e94d26b8a15f309c7e4b1d02a6f8395c7e","artifacts":[{"service":"api","digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111"}],"provenanceUrl":"https://ci.example.test/builds/812"}
```

`POST /api/delivery/release` selects manifest members, excluding reverted ones with a note. `POST /api/delivery/approve` selects by `approvalId` and `expectedGeneration`; this API does not add a routine human approval step.

## Observe and verify

`POST /api/delivery/observe` carries all service instances with host-attested digests, never self-reports. `observe-sha` marks contained merges Deployed with an exact 40-hex SHA and every service. Smoke-required work also needs an `e2e:deploy-smoke` pass naming that SHA. Complete listings verify through `notify`; `graphyard delivery sweep` runs at `freshnessSeconds`. `/api/validation/result` binds signatures, manifests and measurements; mismatches void passes as `attribution-undermined`.

`release GY-N EPOCH` leases release work. `release status` and `graphyard delivery` show ledger and pipeline.

## Rollback

Rollback registrations declare fencing: `provider`, `serialized` or `none`; `none` cannot roll back automatically. `POST /api/delivery/rollback` requests an operation. The rollback actor claims and settles it as `applied`, `failed` or `unknown`. Unknown holds further action until `rollback-resolve` supplies the provider operation and evidence. `automaticRollback: true` reverts degraded generations.

## Coordinator recovery

If self-merge leaves the loop stalled, `graphyard master recover [--to SHA] --admin-token-stdin` repins and restarts it. The AI master diagnoses delivery failures; a cycle watchdog only detects a hung loop.
