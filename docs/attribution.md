<!-- page: Build integrations | 7 | release manifests, exact-target validation, safe re-anchoring, and attribution analytics. -->
# Candidate-to-deployment attribution

A validation pass is a claim about one artifact running on one target. Attribution is how Graphyard keeps that claim honest: every validation request is bound to the exact manifest its candidate was built into, to a content-addressed compatibility signature, and to what independently registered observers measured the target running for the whole execution window. When the target moves, Graphyard never edits the request that was bound to the old target — it preserves and supersedes it, decides from trusted release records whether the new target still contains the intended change, and creates a fresh request that needs fresh execution. Everything it decides is appended to an attribution ledger that the **Attribution** section of the [analytics page](flow-analytics.md) reads.

This builds on [validation](validation.md) (candidates, requests, attempts, trusted results) and on [observed production delivery](delivery.md) (releases, observers, observations). Nothing here talks to a provider; every decision is made from records those two protocols already authenticate.

## Manifests

A **manifest** maps every service of an environment to an artifact digest and a source SHA at one configuration revision (the environment definition revision). Two manifests that run the same bytes under a different configuration revision, or that were built from different sources, are different manifests. A manifest is never supplied; it is derived from one of two append-only records:

| Manifest of | Derived from | Established by |
| --- | --- | --- |
| A release | The release revision: its `manifest`, `sourceSha`, environment revision and explicit `members` | Operator, or a promoter with a current lease, citing a builder's attestation and independently observed merges ([delivery](delivery.md#define-and-select-a-release)) |
| A candidate | The validation build attestation the candidate pins: `artifacts`, `sourceSha`, `baseSha` | A `builder` registration attesting the independently observed candidate source ([validation](validation.md#configure-a-candidate)) |

`GET /api/attribution/manifest/RELEASE_ID/REVISION` returns a release manifest with its `hash` (services, sources and configuration revision), its `digestHash` (services and digests only — the content address an observed target is matched against, identical to the release registry's `manifestHash`) and its membership, excluded members included. Implementation workers, validation clients and observers cannot create or revise a release; a deployment's self-reported version and any SHA a client sends are never part of a manifest.

## Trust boundaries

| Who or what | May establish |
| --- | --- |
| Builder registration (`producer`) | Source → artifact mapping, as a build attestation |
| Operator or promoter | Release identity and membership |
| Observer registration (`producer`) with a current lease | What its services are running, per instance, with a `measurement` of `provider` or `host-attestation` |
| Collector registration (`producer`) | The result of an attempt, rechecked by Graphyard against the pinned candidate and the observers' record |
| Implementation worker, runner, validation client, application self-report, client-supplied SHA | Nothing. A worker or runner credential is refused; a `self-report` or `unknown` measurement is `unknown` even when the claimed digest agrees; a `sha`, `sourceSha`, `commitSha` or similar field on a result is refused before the report is parsed and the refusal is ledgered |

Every mutation that touches attribution runs inside one coordination transaction with the ledger writes it produces; no provider or network call happens inside those transactions.

The ledger lives in two tables, `attribution_records` and `attribution_reanchors`, registered in the schema registry so every logical backup carries them. Adding them moved the schema generation from 1 to 2: a release running this code migrates a generation-1 database additively on start, and a generation-1 backup restores into it with both tables reported as left empty (see [Deployment](deployment.md#backup-upgrade-rollback)).

## Exact-target validation

When an operator creates a validation request, the request record is bound once to:

- the candidate's manifest hash and digest hash, derived from its trusted build attestation;
- the candidate's **compatibility signature** (below);
- the environment's target kind — `immutable-preview` (`immutable: true`) or `shared-staging` (`immutable: false`);
- the **target identity** its observers report at that instant: `unobserved`, `matched`, `mismatched` or `unknown`, with the observation identifiers.

A target already measured running another manifest refuses the request outright, before any paid execution; the ledger records the mismatch and the avoided run. At dispatch the grant is checked again: a known mismatch withholds the grant and re-anchors the request (below). Shared staging is stricter than an immutable preview because nothing declares its target fixed: a shared-staging request is granted only once observers have measured the candidate manifest running, and its result passes only if the observed identity stayed `matched` across the entire execution window. An immutable preview may execute while unobserved — the collector's whole-run measurement remains mandatory — but any measured observation that contradicts the candidate manifest during the window fails the result.

At result time Graphyard judges the window itself. The collector's `target.attribution` claim is necessary, never sufficient: a claimed match on an `unknown` measurement, or a claimed match while observers measured another manifest, is recorded as an unsupported success claim and the result fails. A pass records its attribution — manifest, signature, target kind, window state and the observations that support it — on the evidence. A pass is never reused: a new request for the same candidate needs fresh execution, and a newer request supersedes any earlier pass while it is queued, running or incomplete.

Prefer immutable preview environments. Every request and every evidence record shows which kind of target it ran against, and the analytics report the immutable-preview share.

## Compatibility signatures

A candidate's signature is the content address of everything a pass depends on, each component hashed on its own:

| Component | Covers |
| --- | --- |
| `manifest` | Services, artifact digests, source SHA and configuration revision |
| `build-inputs` | The builder's `buildInputsDigest`: dependencies, lockfiles, migrations, helpers — whatever the attested build digested |
| `test-bundle` | The approved bundle digest, runner image digest, scenario hash and revision, and the proof |
| `configuration` | The environment definition revision |
| `source` | Candidate head and base SHA |
| `policy` | The work item's policy revision |
| `artifacts` | The required artifact names |

Any change regenerates the signature: a later candidate for the same work item and proof whose signature differs writes a `signature-regenerated` record naming the components that moved, and the earlier candidate's requests are superseded. No cross-signature compatibility is ever inferred; a request binds exactly one signature.

## Re-anchoring

A target *moves* when the latest authoritative observation of the request's environment measures a manifest other than the candidate's. Movement is handled the same way from every trigger — a new observation, a delayed observation, a dispatch poll, or a retry of a blocked binding:

1. The existing request is superseded in place: state `superseded`, attempt history intact, attribution untouched. Nothing is edited, relabelled or retargeted. If the request never reached an acknowledged attempt, the paid run it would have started is recorded as avoided.
2. Graphyard decides whether the observed target **contains the intended change**, from trusted records only: a builder's attestation for this work item and environment whose artifacts are the observed manifest and whose source is the current candidate, or a release of this environment whose manifest is the observed one and whose source is the candidate. Records of another environment say nothing about this one.
3. If it does, a fresh candidate (pinned to that attestation, with `reanchoredFrom`) and a fresh request (same runner, collector, deadline and budget, with `reanchoredFrom`) are created in the same transaction. Fresh execution is required; no earlier pass carries over.
4. Otherwise the binding is left visibly **blocked** on the work item (`validation[proof].reanchor`) with the reasons, and the next observation of that environment retries the decision.

Blocked states, each with its own resolution:

| Reason | Resolution |
| --- | --- |
| Target history is ambiguous: overlapping authoritative observations disagree | Wait for the observers to converge, or correct the observer that is wrong |
| Observed target identity is not fully measured (a service unobserved, incomplete or only self-reported) | Fix the observer so every service is measured |
| The observed target matches no trusted build attestation or release manifest | Attest the build or define the release the target is running |
| A release names the change but no build attestation for this work item covers its manifest | Attest the build of this candidate that produced the released manifest; membership alone cannot pin a fresh candidate |
| The observed target does not contain the intended change | Deploy a target that does; the ledger names the trusted record that excludes it |
| The superseded request's deadline has passed | Request validation again |

Rescheduling is idempotent: one row in `attribution_reanchors` per superseded request is the fence, so concurrent observations of the same movement — from several observers, through several replicas, racing a dispatch poll — mint exactly one fresh request. The fence records the observing principal, its registration and lease epoch. A `mismatched` observation that arrives while an attempt is running or collecting does not stop the attempt (Graphyard cannot stop a process it does not run); it records `target-changed`, and the result cannot pass. A **delayed** observation that measures another manifest inside the window of an already accepted pass records `attribution-undermined`: the evidence record is preserved unchanged, it stops being current, and the request is re-anchored. Independently observed identity stays authoritative through stale samples, mixed A → B → A sequences, rollbacks, partial convergence and self-reports, because only measured identity can match or mismatch and observations are ordered by their own observation time.

## Cost semantics

One cost unit is one paid run: an attempt the runner acknowledged, which is what authorizes a container start. Units are counted, never priced.

| Figure | Definition |
| --- | --- |
| Spent | Acknowledged attempts in the window |
| Attributed | Spent units whose result was bound to the observed target |
| Wasted | Spent units whose target changed during execution or whose pass was later undermined |
| Saved | Grants and requests refused because the target was already known to mismatch |

Run duration (acknowledged to finished) is the distribution shown next to these counts. A window with no acknowledged attempt and no avoided run reports cost as unknown, not zero.

## Metrics

The Attribution section of the analytics page, and `GET /api/analytics/attribution`, report each of these for a 7, 30 or 90 day window, with average, median, p90 and n wherever a distribution applies, and an explicit state — `measured`, `unavailable` (unknown, never zero) or `blocked`:

| Metric | Formula |
| --- | --- |
| Target mismatches | Target checks that measured another manifest for at least one service, plus changes during execution and undermined passes |
| Paid runs avoided | Requests and grants refused on a known mismatch |
| Requests superseded | Requests preserved and superseded because their target moved or their pass was undermined |
| Requests rescheduled | Fresh requests minted by re-anchoring |
| Re-anchor count | Rescheduled plus blocked decisions |
| Blocked re-anchors | Bindings blocked at the observation instant, with reasons |
| Target-convergence wait | Mismatch → first later check on the same work item and proof with every service matched |
| Multi-service convergence | Per environment and manifest, first partial match → first full match |
| Candidate-to-release drift | Services differing per mismatch |
| Signature regeneration | Regenerated signatures, by component |
| Immutable-preview share | Requests on immutable previews over all requests |
| Unsupported-success claims prevented | Refused client SHAs, unsupported collector claims, changed targets and undermined passes |
| Cost accounting | Spent, attributed, wasted and saved units, with run durations |

Every report carries `coverage` (records and requests read, scan bounds, open waits and rollouts) and `exclusions` (open convergence waits, unconverged rollouts, clock-inverted intervals). Every aggregate drills down, bounded to 200 rows, to the work item, release or manifest, request, attempt, evidence and artifact behind it; identifiers beyond the work key require an operator, coordinator or producer role. The metrics derive from the ledger and immutable validation records only: editing a work document changes no figure, and there is no endpoint that writes to the ledger.

## Verification

`npm test` runs `tests/attribution.test.ts` against a disposable Postgres database, one named test per acceptance proof: release manifests, exact-target validation, content-address compatibility, immutable history, safe automatic re-anchoring, re-anchor races, the analytics metrics and windows, drill-down, cost accounting and the security regressions. `npm run test:browser` runs `browser-tests/attribution.spec.ts` for the desktop and mobile Attribution views, filters, states, coverage, keyboard and screen-reader access and drill-down. The [protocol page](protocol/attribution.md) lists the endpoints and record shapes.
