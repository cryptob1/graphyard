<!-- page: Build integrations | 8 | replay of retained artifacts with explicit coverage, scoped reuse of the newest compatible attempt, and execution cost analytics. -->
# Evidence replay, scoped reuse and execution analytics

Graphyard can re-run the deterministic verifier over the artifacts it retained for an attempt, let the newest compatible attempt's pass stand for a new head of the same work item under an operator-defined applicability policy, and report what attempts cost and how long they took. Each is a record with its own coverage statement; none of them relaxes what a live validation attempt proves.

**This is D6 of the [delivery roadmap](turnkey-delivery-roadmap.md): optimizations over the correct pinned-candidate path.** A replay never authorizes anything. A reuse is bound to the exact requirement, scenario, proof policy, bundle and environment revisions the executed attempt was pinned to, to the base it was compared against, and to a freshness bound; any newer live attempt — queued, running, timed out, unmeasured, failed or passed — supersedes it. Missing scope is refused, not guessed.

## Attempt order

Every dispatch takes a durable sequence number under the coordination lock (`validation_attempts.seq`, reported as `sequence` on the attempt). "The newest attempt" for a proof means the highest sequence, decided when execution authority was granted and never by when a result arrived. A result for an older attempt that arrives after a newer dispatch is rejected by the existing attempt-authority rules and cannot regain authority; the sequence it was dispatched under does not change. Attempts recorded before this generation carry no sequence and are never reused.

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

`relevant` is the applicability definition the roadmap requires: which paths are dependencies, lockfiles, build inputs, configuration, migrations, and which paths belong to each service of the environment. Every service the environment declares must be named. A change to any relevant path forbids reuse and the decision names the category. `ignorable` names the paths known not to affect the proof. Patterns are repository-relative globs: `**` spans directories, `*` stays within one segment. A path that matches a relevant pattern is relevant whatever `ignorable` says; a path that matches neither is **unknown, and unknown refuses** — the policy widens applicability only by naming what is ignorable.

`artifacts: identical` (the default) additionally requires the trusted build attestation for the new head to declare the same artifact manifest as the executed one; `scoped` accepts a differing manifest when the declared build inputs are unchanged and every changed path is ignorable. Both settings require the attestation's `buildInputsDigest` to be unchanged. `freshnessSeconds` (60 seconds to 30 days) bounds how old the executed pass may be; a granted reuse expires at that bound or at the original artifact retention, whichever comes first, and the gate evaluator refuses it from then on.

No cross-revision compatibility is defined: a different requirement revision, scenario revision or hash, proof policy revision, approved bundle revision or environment revision refuses, even when no file changed. A relaxation of any of those needs its own reviewed policy and is not part of this increment.

## Reuse decisions

After the head moves and a separate build producer has attested the new build, the operator asks:

```sh
graphyard validation reuse decision.json
graphyard validation decisions
```

```json
{
  "workId": "9a7d6b2f-4e1c-4c5a-9f3e-2b8d1c0a7e51",
  "expectedWorkRevision": 12,
  "proof": "e2e:confirmed-booking-sends-sms",
  "policy": {"id": "preview-reuse", "revision": 1},
  "buildAttestationId": "5c2e9a1b-7d3f-4a8e-b6c4-0f1d2e3a4b5c"
}
```

`POST /api/validation/reuse` (operator only, `Idempotency-Key` required) evaluates the newest sequenced attempt for that work item and proof, and commits one decision either way; `GET /api/validation/reuse?cursor=SEQ` lists decisions newest first. A decision is **refused** — with every reason, so the record is the measurement — when:

- any request for the proof is queued, dispatched, running or collecting, or the newest attempt is not a settled, accepted pass (a blocked, timed-out, cancelled, unmeasured, artifact-incomplete or failed newest attempt prevents fallback to an older pass);
- the executed pass is older than the policy freshness, its artifacts have expired, or its collector has since held an assignment on the item;
- the requirement/proof policy revision, the scenario pin, the environment or bundle revision, or the base SHA differ from the executed attempt;
- the declared build inputs differ, or the artifact manifest differs under `artifacts: identical`;
- a changed path is relevant or unknown, or either head's file comparison was never independently observed.

The file comparison is Graphyard's own: each candidate snapshots the changed-file list with blob identities from the GitHub observation that selected it, and the decision compares that snapshot with the current observation. Nothing a client says about what changed is consulted.

A **granted** decision selects a derived candidate for the new head, bound to the executed request and attempt, and records a trusted evidence entry for the new head that carries the original collector as producer, the original counts and artifacts, an `expiresAt` at the freshness bound, and a `reuse` block naming the decision, the original evidence, the executed head and the sequence. The acceptance gate treats it like any other current evidence. Creating a live request for the proof supersedes the reused selection at once, and a later failure is then the current evidence; retrying the executed request is refused because its candidate no longer matches the head. Reconciliation revalidates the derived candidate's build, bundle, environment and registration authority on every configuration change, exactly as it does for an executed one. The derived candidate carries the manifest hash and compatibility signature of the head it stands for, so [attribution](attribution.md) reads it like any other candidate record; a later authoritative observation that undermines the executed attempt's window re-anchors the binding and the reused entry stops authorizing with it.

The attempt sequence, the decisions and the replays live in three tables — `validation_attempts`, `validation_reuse_decisions` and `validation_replays` — registered in the schema registry so every logical backup carries them. Adding them moved the schema generation from 2 to 3; a release running this code migrates an older database additively on start, and an older backup restores into it with the three tables reported as left empty (see [Deployment](deployment.md#backup-upgrade-rollback)).

## Replay

```sh
graphyard validation replay REQUEST_UUID ATTEMPT_UUID
graphyard validation replays
```

`POST /api/validation/replay` (operator or read-only audit credential; runner and collector credentials refuse) reads the artifacts Graphyard retained for one attempt, verifies each against the digest recorded at upload, parses the ones the pinned [report adapter](report-adapters.md) understands and re-runs its verifier. The record states, per dimension, what the replay covered:

| Dimension | Status | Why |
| --- | --- | --- |
| `inventory`, `behavior` | `covered` when both the inventory and the report were retained, unexpired, intact and parsed; otherwise `unmeasured` with the missing instrumentation named | The verifier re-derives executed/skipped counts and the verdict from the retained files |
| `artifactIntegrity` | `covered` when every artifact read matches its recorded digest; `unmeasured` when one fails or none could be read | Bytes are verified on every read |
| `bundleIdentity`, `targetAttribution`, `settlement`, `deploymentHealth` | always `not-covered` | These were independent measurements at the execution boundary and on the target; a stored file cannot repeat them, and a replay never establishes current live behavior |

`outcome` is `consistent` or `inconsistent` against the report summary the collector submitted, `uncompared` when the attempt predates those summaries, and `unmeasured` when the artifacts lack the instrumentation to replay at all — a clean-looking replay without the retained inventory is unmeasured, not passed. The record carries the measured cost: wall-clock duration, bytes read, artifacts read and the backend. `authorizes` is always `nothing` and `liveVerification` always `not-established`: no evidence, selection or gate changes because of a replay, and the record says so.

**Redaction and retention.** Replay inputs follow artifact retention exactly: an expired, pending, failed or already swept artifact is not read and is listed with its state. Exports never include artifact bytes or the parsed documents; test identities are the adapter's hashes; and every string in the record and in the `validation.replayed` ledger event passes the redaction filter, which masks credential-shaped tokens (`Authorization`/bearer values, `token=`, `password:`, GitHub and AWS key shapes, JWTs) and URL credentials.

## Execution analytics

```sh
graphyard validation analytics
```

`GET /api/validation/analytics` groups every sequenced attempt by proof, environment and runner registration — the three things that decide the workload — and reports per group: outcomes; Graphyard's own observed timings from the attempt timeline (queue wait, acknowledgement latency, execution until collection took over, collection, and total) as sample counts with median and maximum; the runner-reported duration and CPU time, kept separate from the observed timings; and cost split into **observed** (metered by the runner or its provider), **estimated** (derived from a rate) and **unavailable** (nothing reported). Cost is never reported as zero when nobody metered it.

Runner measurements are optional and arrive with the collector's `result` as `measurements: {durationMs, cpuSeconds, cost: {amount, currency, basis, source}}`; `basis` must be `observed` or `estimated`, and a cost without one is refused rather than counted. The response also reports the reuse ledger — decisions, grants, refusals by reason class, grants that a later live run superseded, grants a later live run contradicted with a failure (false reuse), and grants no later run replaced (avoided executions) — and the replay ledger by outcome with its measured cost. Groups are never ranked against each other; the response carries that caveat, and the dashboard's **Validation** view shows the same numbers per group.

## Acceptance checks

`npm test` runs `tests/evidence-reuse.test.ts` against a disposable Postgres database. Its tests are named after the D6 acceptance checks in the [roadmap](turnkey-delivery-roadmap.md#d6-evidence-replay-compatible-reuse-and-analytics): D6-1 relevant dependency and configuration changes invalidate reuse while an ignorable change is reused with exact binding; D6-2 requirement, scenario, proof policy, bundle, environment, freshness and independence changes invalidate reuse when source is unchanged; D6-3 newer blocked, timed-out, unmeasured or incomplete attempts prevent fallback and delayed older results cannot override the newest attempt; D6-4 unknown scope never widens applicability; D6-5 replay reports coverage and cannot authorize current live behavior; D6-6 redaction and retention rules apply to replay inputs and exports. The JSON samples above are parsed by the same schemas the API uses.
