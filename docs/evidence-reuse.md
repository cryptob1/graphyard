<!-- page: Build integrations | 8 | replay, reuse, cost. -->
# Evidence replay, scoped reuse and execution analytics

For an operator weighing whether to re-run a validation attempt.

## Attempt order

Every dispatch takes a durable sequence number under the coordination lock, reported as `sequence`. "The newest attempt" for a proof is the highest sequence, decided when execution authority was granted; a result for an older attempt arriving after a newer dispatch is rejected, and attempts recorded before this generation carry no sequence and are never reused.

## Reuse policy

Reuse is off until an operator publishes a `reuse` definition for the environment, through the same `define` command and revision rules as environments, registrations and bundles:

```json
{
  "kind": "reuse",
  "id": "preview-reuse",
  "expectedRevision": 0,
  "environment": {"id": "preview", "revision": 1},
  "enabled": true,
  "freshnessSeconds": 86400,
  "artifacts": "identical",
  "relevant": {
    "dependencies": ["package.json", "**/package.json"],
    "lockfiles": ["package-lock.json", "**/yarn.lock"],
    "buildInputs": ["Dockerfile", "tsconfig.json", ".github/workflows/**"],
    "configuration": ["config/**", ".env.example", "compose.yaml"],
    "migrations": ["migrations/**"],
    "services": {"api": ["src/**"]}
  },
  "ignorable": ["docs/**", "*.md"]
}
```

## Reuse decisions

After the head moves and a build producer has attested the new build, the operator asks with `graphyard validation reuse decision.json` (`graphyard validation decisions` lists outcomes):

```json
{
  "workId": "9a7d6b2f-4e1c-4c5a-9f3e-2b8d1c0a7e51",
  "expectedWorkRevision": 12,
  "proof": "e2e:confirmed-booking-sends-sms",
  "policy": {"id": "preview-reuse", "revision": 1},
  "buildAttestationId": "5c2e9a1b-7d3f-4a8e-b6c4-0f1d2e3a4b5c"
}
```

`POST /api/validation/reuse` (operator only, `Idempotency-Key` required) evaluates the newest sequenced attempt for that work item and proof and commits one decision, listing every reason when it is **refused**: a live request for the proof; a newest attempt that is not a settled, accepted pass, so nothing falls back to an older one; an executed pass older than the policy freshness, with expired artifacts, or whose collector has since held an assignment on the item; a differing requirement or proof policy revision, scenario pin, environment, bundle revision or base SHA; differing declared build inputs or, under `artifacts: identical`, artifact manifest; or a changed path that is relevant or unknown, or a head whose file comparison was never independently observed. That comparison is Graphyard's own — each candidate snapshots the changed-file list with blob identities from the GitHub observation that selected it — and nothing a client claims is consulted.

A **granted** decision selects a derived candidate for the new head, bound to the executed request and attempt, and records trusted evidence carrying the original collector as producer, the original counts and artifacts, an `expiresAt` at the freshness bound and a `reuse` block naming the decision, the original evidence, the executed head and the sequence; the acceptance gate treats it like any other current evidence. A live request supersedes the reused selection at once, and retrying the executed request is refused because its candidate no longer matches the head. Reconciliation revalidates the derived candidate's build, bundle, environment and registration authority on every configuration change, and an observation undermining the executed attempt's window re-anchors the binding, after which the reused entry stops authorizing.

## Replay

`graphyard validation replay REQUEST_UUID ATTEMPT_UUID` (`replays` lists the records) reads the retained artifacts of one attempt, verifies each against the digest recorded at upload, parses the ones the pinned [report adapter](report-adapters.md) understands and re-runs its verifier. Operator and read-only audit credentials may; runner and collector credentials refuse.

Coverage is per dimension. `inventory` and `behavior` are `covered` when both files were retained, unexpired, intact and parsed, otherwise `unmeasured` with the missing instrumentation named; `artifactIntegrity` is `covered` when every artifact read matches its recorded digest; `bundleIdentity`, `targetAttribution`, `settlement` and `deploymentHealth` are always `not-covered`, because they were measurements at the execution boundary and on the target that a stored file cannot repeat. `outcome` is `consistent` or `inconsistent` against the collector's submitted summary, `uncompared` when the attempt predates those summaries, and `unmeasured` when the artifacts cannot be replayed at all. The record carries the measured cost and states `authorizes: nothing` and `liveVerification: not-established`: no evidence, selection or gate changes because of a replay.

## Execution analytics

`graphyard validation analytics` groups every sequenced attempt by proof, environment and runner registration, reporting outcomes, Graphyard's own observed timings and the runner-reported duration and CPU time kept separate from them. Cost is **observed**, **estimated** or **unavailable**, never zero when nobody metered it, and a measurement whose `basis` is neither `observed` nor `estimated` is refused; the response also carries the reuse and replay ledgers by outcome, and never ranks groups.
