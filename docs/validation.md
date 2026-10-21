<!-- page: Build integrations | 2 | cases -->
# E2E validation

An `e2e:` proof passes from pinned candidate/bundle/separate collector; `validation define|build|candidate|request|dispatch|ack|heartbeat|result FILE.json` wraps `POST /api/validation/ACTION`. `admin` defines cases; runners (`worker`) poll/ack/heartbeat; builders/collectors (`producer`) attest/publish, never both; only trusted attempts append **Tests** runs. [Evidence](protocol/work-commands.md#evidence-and-pipeline) carries trust and grants.

## Approve the bundle and run an attempt

```bash
graphyard runner inspect [packages/web]
graphyard runner snapshot selected-files.json > oracle-source.json
graphyard runner bundle-digest ./oracle
```

`validation define` pins `digest` and `runnerImageDigest`. `graphyard runner attempt runner.json` runs as a non-root `runAsUser` with a boundary-group GID; the attestor (`graphyard runner supervise`) enumerates offline, executes read-only, signs what it saw.

### The acknowledgement is retried, never repeated

Each send carries request key `ATTEMPT_ID-ack`, identical body; an already-acknowledged answer is success, other 2xx refuse. A confirmed refusal is a decision, never retried; transport failures, timeouts, 408, 429, 5xx retry: At most **5 sends**, paused 1, 2, 4 and 8 seconds apart; no send starts more than **60 seconds** after the first. Until the acknowledgement is confirmed, no heartbeat is sent nor the attestor told to proceed.

### Attempt boundary

```bash
groupadd --gid 20001 graphyard-boundary
useradd -r --uid 10001 -g graphyard-boundary graphyard-container
useradd -r graphyard-collector
usermod -aG graphyard-boundary graphyard-attestor
usermod -aG graphyard-boundary graphyard-collector
install -d -o graphyard-attestor -g graphyard-boundary -m 2750 /srv/graphyard/attempts
setfacl -d -m g:graphyard-boundary:rx /srv/graphyard/attempts
```

Container writes; attestor, collector read; never add the runner account. Collect with a proof-scoped `producer` credential: `graphyard runner collect collector.json` verifies signature, inventory, teardown, uploads artifacts; `observations` bracket the run within `maxGapMs`.

## E2E case repository

`e2e/cases/ID.json`, code-reviewed: `id`/`title`, optional `description`/`tags`, `target` (`uat`/`any`), `required` (default `false`), ordered `steps`: `http` (`method`, `path`, `status`, `expect` on dotted paths, `save`, GET `waitSeconds`, within its case's equal share of the run's wait budget, so no case is left 0 s; a path that reads nothing fails as `unset` with the nearest value above it); `browser` (Playwright Chromium: `open`, `fill`, `click`/`expectText`); `command`: `run` in the checkout with `TARGET_URL`, exit 0 passes, last 50 lines kept: `{"kind":"command","run":"npx playwright test"}`; `agent`: agent-browser pursues `goal` at `path` until `success` holds, ending `VERDICT: PASS|FAIL - reason`, screenshot kept: `{"kind":"agent","goal":"Win tic-tac-toe","success":["Board says You win"],"path":"/games"}`.

`timeoutSeconds` (600). `secrets: ["NAME"]` from `~/.config/graphyard/INSTALL/e2e-secrets.TARGET.env` (0600, uncommitted) as variables and `{{secret:NAME}}`, redacted. `e2e run CASE|--tag T|--all --url URL` prints failing steps, exits non-zero. Without a wired repository the delivery cases pend; without previews the preview cases do.

**Required `uat` cases run on every deploy** (`GRAPHYARD_UAT_URL`, `GRAPHYARD_SUITE_DETAIL`; static sites loop back `GRAPHYARD_UAT_STATIC`); `e2e record REPORT` records attempts ([`e2e:record` agent](delivery.md#release-filing-credential)).

## Release verdicts

One retry: **passed**; **failed**; **flaky** (retry passed at same SHA); **unrun**; **blocked**; **pending** (blocks only if a delivered outcome shares it or `e2e.pendingOutcomes: blocking`). Only failed or unaccepted flaky required cases block; promotion waits on an `evidence` decision. `POST /api/validation/import` (`external-runs:import` producers) binds external runs to a `sha`, idempotent per `producer`+`runId`; the `imports` job seals released holds.

`e2e/contract.json` lists required customer outcomes, each bound to required `uat`-targeted cases.

## Goals and acceptance

`goal FILE` records (`statement`/`users`/`constraints`/`deployTarget`). The `acceptance` role drafts outcomes (one required `uat` case each); the merge writer lands that commit on another identity's approver verdict, and `goal land` records it (any other route refused). Protected case or `e2e/contract.json` binding changes need the item's `goal case-change`, approved by neither requester nor implementer; a head the control plane observes is judged by the protected bindings it moves, otherwise any contract edit needs every protected case granted. To retire outcomes outright, `goal amend GOAL-N --apply-decision REQUEST_ID` (from a master session, `master goal-amend GOAL-N REQUEST_ID`, under its operator-agent identity) applies a goals-and-priorities request the operator answered "Go ahead as asked": the protected outcomes its `retire` clauses name, and their cases, leave the protected set (one it also keeps is refused as ambiguous), and the decision is recorded on the goal's history. [Planner](how-graphyard-works.md#from-goal-to-work-items) plans items; `goal deliver` needs each done and served in production. A failed outcome's hold clears when every attached case passes on a newer served candidate.

## Evidence reuse and replay

Under a reuse policy the newest compatible pass covers new heads:

```json
{"kind":"reuse","id":"preview-reuse","expectedRevision":0,"environment":{"id":"preview","revision":1},"enabled":true,"freshnessSeconds":86400,"artifacts":"identical","relevant":{"dependencies":["package.json","**/package.json"],"lockfiles":["package-lock.json"],"buildInputs":["Dockerfile","tsconfig.json"],"configuration":["config/**"],"migrations":["migrations/**"],"services":{"api":["src/**"]}},"ignorable":["docs/**"]}
```

`relevant.services` covers every service; changed relevant or unknown paths refuse.

Per attested head, `graphyard validation reuse decision.json`; fresh settled passes on identical pins qualify:

```json
{"workId":"9a7d6b2f-4e1c-4c5a-9f3e-2b8d1c0a7e51","expectedWorkRevision":12,"proof":"e2e:confirmed-booking-sends-sms","policy":{"id":"preview-reuse","revision":1},"buildAttestationId":"5c2e9a1b-7d3f-4a8e-b6c4-0f1d2e3a4b5c"}
```

`graphyard validation replay REQUEST ATTEMPT` (authorizes nothing) keeps each attempt's time, evaluator, outcome; `evaluator-error` reruns ≤2×, `fail` never. `graphyard validation analytics`: outcomes, faults, cost.
