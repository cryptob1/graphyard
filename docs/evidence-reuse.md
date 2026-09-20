<!-- page: Build integrations | 8 | replay, scoped reuse, cost analytics. -->
# Evidence replay, scoped reuse and execution analytics

For an operator weighing whether to re-run a validation attempt.

## Attempt order

Every dispatch takes a durable sequence number under the coordination lock, reported as `sequence` on the attempt. "The newest attempt" for a proof means the highest sequence, decided when execution authority was granted and never by when a result arrived; a result for an older attempt arriving after a newer dispatch is rejected and cannot regain authority. Attempts recorded before this generation carry no sequence and are never reused.

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

After the head moves and a separate build producer has attested the new build, the operator asks with `graphyard validation reuse decision.json` (`graphyard validation decisions` lists the outcomes):

```json
{
  "workId": "9a7d6b2f-4e1c-4c5a-9f3e-2b8d1c0a7e51",
  "expectedWorkRevision": 12,
  "proof": "e2e:confirmed-booking-sends-sms",
  "policy": {"id": "preview-reuse", "revision": 1},
  "buildAttestationId": "5c2e9a1b-7d3f-4a8e-b6c4-0f1d2e3a4b5c"
}
```

`POST /api/validation/reuse` (operator only, `Idempotency-Key` required) evaluates the newest sequenced attempt for that work item and proof and commits one decision either way. A decision is **refused** — listing every reason, so the record is the measurement — when any request for the proof is live; when the newest attempt is not a settled, accepted pass, which prevents fallback to an older one; when the executed pass is older than the policy freshness, its artifacts have expired, or its collector has since held an assignment on the item; when the requirement or proof policy revision, scenario pin, environment or bundle revision, or base SHA differ; when the declared build inputs or, under `artifacts: identical`, the artifact manifest differ; or when a changed path is relevant or unknown, or either head's file comparison was never independently observed. That comparison is Graphyard's own — each candidate snapshots the changed-file list with blob identities from the GitHub observation that selected it — and nothing a client claims about what changed is consulted.

A **granted** decision selects a derived candidate for the new head, bound to the executed request and attempt, and records trusted evidence carrying the original collector as producer, the original counts and artifacts, an `expiresAt` at the freshness bound and a `reuse` block naming the decision, the original evidence, the executed head and the sequence. The acceptance gate treats it like any other current evidence. Creating a live request supersedes the reused selection at once and a later failure is then current; retrying the executed request is refused because its candidate no longer matches the head. Reconciliation revalidates the derived candidate's build, bundle, environment and registration authority on every configuration change, and a later authoritative observation undermining the executed attempt's window re-anchors the binding, after which the reused entry stops authorizing with it.

## Replay

`graphyard validation replay REQUEST_UUID ATTEMPT_UUID` (`replays` lists the records) reads the artifacts Graphyard retained for one attempt, verifies each against the digest recorded at upload, parses the ones the pinned [report adapter](report-adapters.md) understands and re-runs its verifier. It is available to an operator or a read-only audit credential; runner and collector credentials refuse.

| Dimension | Status | Why |
| --- | --- | --- |
| `inventory`, `behavior` | `covered` when both the inventory and the report were retained, unexpired, intact and parsed; otherwise `unmeasured` with the missing instrumentation named | The verifier re-derives executed/skipped counts and the verdict from the retained files |
| `artifactIntegrity` | `covered` when every artifact read matches its recorded digest; `unmeasured` when one fails or none could be read | Bytes are verified on every read |
| `bundleIdentity`, `targetAttribution`, `settlement`, `deploymentHealth` | always `not-covered` | These were independent measurements at the execution boundary and on the target; a stored file cannot repeat them, and a replay never establishes current live behavior |

`outcome` is `consistent` or `inconsistent` against the report summary the collector submitted, `uncompared` when the attempt predates those summaries, and `unmeasured` when the artifacts lack the instrumentation to replay at all — a clean-looking replay without the retained inventory is unmeasured, not passed. The record carries the measured cost and states that `authorizes` is always `nothing` and `liveVerification` always `not-established`: no evidence, selection or gate changes because of a replay.

## Execution analytics

`graphyard validation analytics` groups every sequenced attempt by proof, environment and runner registration and reports per group: outcomes; Graphyard's own observed timings from the attempt timeline as sample counts with median and maximum; and the runner-reported duration and CPU time, kept separate from those observed timings. Cost is split into **observed**, **estimated** and **unavailable**, and is never reported as zero when nobody metered it. Runner measurements are optional and arrive with the collector's `result`; a `basis` must be `observed` or `estimated`, and a cost without one is refused rather than counted. The response also reports the reuse ledger and the replay ledger by outcome with its measured cost. Groups are never ranked against each other, and the response carries that caveat.
