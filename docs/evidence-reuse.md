<!-- page: Build integrations | 8 | replay, reuse. -->
# Evidence replay, scoped reuse and execution analytics

For an operator weighing a re-run: when an earlier pass may stand for a new head.

## Attempt order

Every dispatch takes a durable sequence number under the coordination lock, reported as `sequence`.

- **"The newest attempt"** for a proof is the highest sequence, decided when execution authority was granted
- An older attempt's result arriving after a newer dispatch is rejected
- Attempts predating this generation carry no sequence and are never reused

## Reuse policy

Reuse is off until an operator publishes a `reuse` definition for the environment, through the `define` command and revision rules of environments, registrations and bundles:

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

Once the head moves and a build producer attests the new build, the operator asks with `graphyard validation reuse decision.json` (`graphyard validation decisions` lists outcomes):

```json
{
  "workId": "9a7d6b2f-4e1c-4c5a-9f3e-2b8d1c0a7e51",
  "expectedWorkRevision": 12,
  "proof": "e2e:confirmed-booking-sends-sms",
  "policy": {"id": "preview-reuse", "revision": 1},
  "buildAttestationId": "5c2e9a1b-7d3f-4a8e-b6c4-0f1d2e3a4b5c"
}
```

`POST /api/validation/reuse` (operator only, `Idempotency-Key` required) evaluates the newest sequenced attempt for that item and proof and commits one decision, listing every reason when **refused**:

- Live request for the proof
- Newest attempt not a settled, accepted pass; nothing falls back to an older one
- Executed pass older than the policy freshness, with expired artifacts, or whose collector has since held an assignment
- Differing requirement or proof policy revision, scenario pin, environment, bundle revision or base SHA
- Differing declared build inputs or, under `artifacts: identical`, artifact manifest
- Changed path that is relevant or unknown
- Head whose file comparison was never independently observed

That comparison is Graphyard's own: each candidate snapshots the changed-file list with blob identities from the GitHub observation that selected it; no client claim is consulted.

A **granted** decision:

- **Selects** a derived candidate for the new head, bound to the executed request and attempt
- **Records trusted evidence** the acceptance gate treats as current: the original collector as producer, the original counts and artifacts, an `expiresAt` at the freshness bound, a `reuse` block naming the decision, the original evidence, the executed head and the sequence

Afterwards:

- **A live request:** supersedes the reused selection at once
- **Retrying the executed request:** refused, its candidate no longer matching the head
- **Reconciliation:** revalidates the derived candidate's build, bundle, environment and registration authority on every configuration change
- **An observation undermining the executed attempt's window:** re-anchors the binding, and the reused entry stops authorizing

## Replay

`graphyard validation replay REQUEST_UUID ATTEMPT_UUID` (`replays` lists the records) reads one attempt's retained artifacts, verifies each against the digest recorded at upload, parses those the pinned [report adapter](report-adapters.md) understands and re-runs its verifier.

Operator and read-only audit credentials may; runner and collector credentials refuse.

Coverage is per dimension:

- **`inventory`, `behavior`:** `covered` when both files were retained, unexpired, intact and parsed, otherwise `unmeasured` with the missing instrumentation named
- **`artifactIntegrity`:** `covered` when every artifact read matches its recorded digest
- **`bundleIdentity`, `targetAttribution`, `settlement`, `deploymentHealth`:** always `not-covered`: measurements at the execution boundary and on the target no stored file can repeat
- **`outcome`:** `consistent` or `inconsistent` against the collector's submitted summary, `uncompared` when the attempt predates those summaries, `unmeasured` when the artifacts cannot be replayed
- **The record:** carries the measured cost and states `authorizes: nothing` and `liveVerification: not-established`; a replay changes no evidence, selection or gate

## Execution analytics

`graphyard validation analytics` groups every sequenced attempt by proof, environment and runner registration.

- **Reports:** outcomes, Graphyard's observed timings, and separately the runner-reported duration and CPU time
- **Cost:** **observed**, **estimated** or **unavailable**, never zero when nobody metered it
- **Refused:** a measurement whose `basis` is neither `observed` nor `estimated`
- **Also carried:** the reuse and replay ledgers by outcome; the response never ranks groups
