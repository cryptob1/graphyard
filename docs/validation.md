<!-- page: Build integrations | 2 | bind cases and run checks -->
# E2E validation

## Every item carries an e2e: proof

Every item — chore, bug or feature — needs an `e2e:NAME` criterion bound to a new or existing `e2e/cases/NAME.json` on the head. No description opts out. Cases creating work must bind those items too; manual/unit proofs alone do not suffice. Create/requirements enforce this; missing/failing cases refuse the trial. Ready checks apply to open unheld work, not retroactively to claimed/submitted items. New cases register after merge/sync; trusted trial runs populate Tests history.

`init --scan --apply` writes `e2e/cases/served-head.json` if no case exists and `e2e.serve` if no previewable app serves a head. Replace the fallback Node server (which serves graphyard.json) with the application's server. `graphyard up` publishes these files; onboarding names the first case.

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

`delivery-pipeline` uses `scripts/e2e-serve.mjs` with temporary local bare origin, checkout and separate worker/coordinator credentials. It creates/claims work, submits an exact head, posts independent review, runs the real build/test trial and leased push, then checks delivery and bare origin's main. Initialization and refreshes use the writer's transport ports. The scratch item binds unit and `e2e:scratch-delivery` proofs; its trial serves submitted code on a temporary port and checks HTTP before pushing. No network or install credential is needed. `tests/graphyard-e2e-serve.test.ts` also runs the case with `--unwritable`, removing bare-repository write permission: the trial passes, push fails and the case fails with work undelivered.

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

Graphyard's trial server (`scripts/e2e-serve.mjs`) manages `cryptob1/graphyard`, so its fresh database lists the shipped scenarios, including the required capacity-limit-redispatch case. That case runs the capacity hold and silent-exhaustion tests through the port-reserving test runner.

## Release verdicts

Passed, failed, flaky (one retry passes at same SHA), unrun, blocked or pending. Failed/unaccepted flaky required cases block. Pending blocks for shared delivered outcomes or `e2e.pendingOutcomes: blocking`. `e2e/contract.json` binds customer outcomes to required UAT cases.

**pending** (the case's outcome has no delivered item yet): its failure is recorded with the failing step but does not block the candidate, unless the blocking rules above apply.

Legacy `/api/validation/import` requires external-runs:import, is idempotent by producer/runId, accepts only rc-tagged commits and gates nothing. The release-filing operator agent can read `GET /api/validation/import/:sha` and seal released imports with `POST /api/validation/import/:sha/seal`; it cannot import runs. The seal-authority route is removed.

## Evidence reuse and replay

A reuse policy allows the newest compatible settled pass on identical pins:

```json
{"kind":"reuse","id":"preview-reuse","expectedRevision":0,"environment":{"id":"preview","revision":1},"enabled":true,"freshnessSeconds":86400,"artifacts":"identical","relevant":{"dependencies":["package.json","**/package.json"],"lockfiles":["package-lock.json"],"buildInputs":["Dockerfile","tsconfig.json"],"configuration":["config/**"],"migrations":["migrations/**"],"services":{"api":["src/**"]}},"ignorable":["docs/**"]}
```

Relevant services must cover every service; changed relevant or unknown paths refuse. `validation reuse decision.json` names workId, expectedWorkRevision, proof, policy `{id,revision}` and buildAttestationId. `validation replay REQUEST ATTEMPT` preserves evaluator/time/outcome and grants no authority; evaluator-error reruns at most twice, fail never does. `validation analytics` reports outcomes, faults and cost.

## Host verification capacity

Host verification reservations hold a kernel `flock` on their existing owner file.
The owning process retains the descriptor; exit or interruption releases it across
PID namespaces, so a reused numeric PID cannot retain capacity. Budget reads reclaim
unlocked reservations before subtracting declared files, including trial declarations.
Live locks stay reserved; slot limits and the memory floor remain unchanged. Legacy
PID-only records lack this evidence and remain reserved until explicitly cleared.
`tests/verification-owner-identity.test.ts` covers host release and interrupted
private-root ownership; `e2e/cases/verification-owner-identity.json` binds the regression.
