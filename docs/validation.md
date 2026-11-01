<!-- page: Build integrations | 2 | bind cases and run checks -->
# E2E validation

## Every user-facing item carries an e2e: proof

Features and bugs need an `e2e:NAME` criterion bound to `e2e/cases/NAME.json` on the head. Create/requirements enforce it; invisible changes opt out with `No user-facing change: <reason>`. Ready checks apply to open unheld work, not retroactively to claimed/submitted items. Missing/failing cases refuse the trial. New cases register after merge/sync; trusted trial runs populate Tests history.

Declare `e2e.serve` in graphyard.json:

```json
{"e2e":{"serve":{"command":"node scripts/e2e-serve.mjs","url":"http://127.0.0.1:4391/healthz?ready","readySeconds":120}}}
```

The trial starts command, waits for 2xx, supplies `GRAPHYARD_E2E_TOKEN`, runs cases and tears down descendants. Graphyard's script uses temporary Postgres. Existing `delivery.applications` previews can supply serving through `delivery.cases` or the sole app; otherwise creation refuses without e2e.serve.

`human:NAME` is limited to physical checks named by the criterion. Needs you asks once per head with steps/commit/preview; pass advances, fail reworks. It is not general approval.

## Approve the bundle and run an attempt

Pinned validation uses `validation define|build|candidate|request|dispatch|ack|heartbeat|result FILE.json`. Admins define, worker runners poll/ack/heartbeat, producer builders/collectors attest/publish. Builder and collector remain separate; [grants](protocol/work-commands.md#evidence-and-pipeline) determine trust.

```sh
graphyard runner inspect [packages/web]
graphyard runner snapshot selected-files.json > oracle-source.json
graphyard runner bundle-digest ./oracle
```

Define pins digest/runnerImageDigest. `runner attempt runner.json` uses non-root runAsUser and boundary GID. `runner supervise` enumerates offline, executes read-only and signs inventory.

### The acknowledgement is retried, never repeated

Use identical `ATTEMPT_ID-ack` requests. Already acknowledged succeeds; unexpected 2xx or confirmed refusals stop. Transport/timeouts/408/429/5xx retry up to five sends, after 1/2/4/8 seconds, within 60 seconds total. No heartbeat or attestor execution starts before acknowledgement.

### Attempt boundary

```sh
groupadd --gid 20001 graphyard-boundary
useradd -r --uid 10001 -g graphyard-boundary graphyard-container
useradd -r graphyard-collector
usermod -aG graphyard-boundary graphyard-attestor
usermod -aG graphyard-boundary graphyard-collector
install -d -o graphyard-attestor -g graphyard-boundary -m 2750 /srv/graphyard/attempts
setfacl -d -m g:graphyard-boundary:rx /srv/graphyard/attempts
```

Container writes; attestor/collector read. Never add the runner account. `runner collect collector.json` uses proof-scoped credentials to verify signature, inventory and teardown and upload artifacts. Observations bracket the run within maxGapMs.

## E2E case repository

Code-reviewed cases have id/title, optional description/tags, target (`uat`/`any`), required (false), timeoutSeconds (600), secrets and ordered steps:

| Kind | Fields and behavior |
| --- | --- |
| http | method/path/status, dotted expect, save, GET waitSeconds. Cases share wait budget equally; unset reads fail with nearest value. |
| browser | Playwright Chromium open/fill/click/expectText. |
| command | run in checkout with TARGET_URL; exit 0 passes, last 50 lines retained. |
| agent | goal/path/success via agent-browser; screenshot and `VERDICT: PASS\|FAIL - reason`. |

Agent `compare: true` also runs at BASELINE_URL (previous build, adjacent port); a judge compares transcripts/screenshots as SAME/BETTER/WORSE. WORSE fails. No baseline means one run.

Secrets come from `~/.config/graphyard/INSTALL/e2e-secrets.TARGET.env` (0600), as variables or `{{secret:NAME}}`, redacted from output.

`e2e run CASE|--tag T|--all --url URL` prints failures and exits nonzero. Unwired cases/previews remain pending. Tests lists the repository's synced cases, with actual landing times; Graphyard scenarios register only for its own repository.

Required UAT cases run every deploy via GRAPHYARD_UAT_URL/GRAPHYARD_SUITE_DETAIL; static sites use GRAPHYARD_UAT_STATIC. `e2e record REPORT` needs the [record credential](delivery.md#e2e-record-credential).

## Release verdicts

Passed, failed, flaky (one retry passes at same SHA), unrun, blocked or pending. Failed/unaccepted flaky required cases block. Pending blocks for shared delivered outcomes or `e2e.pendingOutcomes: blocking`. `e2e/contract.json` binds customer outcomes to required UAT cases.

Legacy `/api/validation/import` requires external-runs:import, is idempotent by producer/runId, accepts only rc-tagged commits and gates nothing.

## Evidence reuse and replay

A reuse policy allows the newest compatible settled pass on identical pins:

```json
{"kind":"reuse","id":"preview-reuse","expectedRevision":0,"environment":{"id":"preview","revision":1},"enabled":true,"freshnessSeconds":86400,"artifacts":"identical","relevant":{"dependencies":["package.json","**/package.json"],"lockfiles":["package-lock.json"],"buildInputs":["Dockerfile","tsconfig.json"],"configuration":["config/**"],"migrations":["migrations/**"],"services":{"api":["src/**"]}},"ignorable":["docs/**"]}
```

Relevant services must cover every service; changed relevant or unknown paths refuse. `validation reuse decision.json` names workId, expectedWorkRevision, proof, policy `{id,revision}` and buildAttestationId. `validation replay REQUEST ATTEMPT` preserves evaluator/time/outcome and grants no authority; evaluator-error reruns at most twice, fail never does. `validation analytics` reports outcomes, faults and cost.
