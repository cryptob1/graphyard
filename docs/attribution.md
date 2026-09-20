<!-- page: Build integrations | 7 | manifests, targets, re-anchoring. -->
# Candidate-to-deployment attribution

For anyone reading a validation pass: what binds it to one target.

## Manifests and trust

A **manifest** maps every service of an environment to an artifact digest and a source SHA at one configuration revision. It is never supplied: it is derived from a release revision (its `manifest`, `sourceSha`, environment revision and explicit `members`) or from the build attestation a candidate pins (`artifacts`, `sourceSha`, `baseSha`). `GET /api/attribution/manifest/RELEASE_ID/REVISION` returns one with its `hash`, `digestHash` and membership, excluded members included. What each identity may establish:

- **Builder registration (`producer`):** Source → artifact mapping, as a build attestation
- **Operator (`admin`) or promoter:** Release identity and membership
- **Observer registration with a current lease:** What its services run, per instance, with a `measurement` of `provider` or `host-attestation`
- **Collector registration:** An attempt's result, rechecked against the pinned candidate and the observers' record
- **Implementation worker, runner, validation client, application self-report, client-supplied SHA:** Nothing. A worker or runner credential is refused; a `self-report` or `unknown` measurement stays `unknown` even when the claimed digest agrees; a `sha`, `sourceSha` or `commitSha` field on a result is refused before the report is parsed, and the refusal is ledgered

## Exact-target validation

A request record is bound once to the candidate's manifest hash and digest hash, its **compatibility signature**, the environment's target kind — `immutable-preview` or `shared-staging` — and the target identity its observers report then (`unobserved`, `matched`, `mismatched` or `unknown`, with the observation identifiers). A target already measured running another manifest refuses the request before any paid execution, and the ledger records the mismatch and the avoided run; at dispatch the grant is rechecked, and a known mismatch withholds it and re-anchors the request. Shared staging is stricter: granted only once observers have measured the candidate manifest running, and passing only if the observed identity stayed `matched` across the whole window. An immutable preview may execute while unobserved, but any measured observation contradicting the candidate manifest during the window fails the result.

### Whole-run coverage

Coverage requires measurements bracketing the whole execution interval with no gap longer than `maxGapMs`, so an A → B → A rollout inside it is either observed or left uncovered. Only that interval is judged, bounded by the nearest measurement at or before the start and at or after the finish: a rollout an hour later does not invalidate the run, and a measurement an hour earlier does not cover it.

| Situation | Attribution | Outcome |
| --- | --- | --- |
| Continuous coverage, every measurement matches | `matched` | Can pass |
| A mid-run measurement differs, boundaries agree | `changed` | Attempt and behaviour retained, attribution invalid |
| The final measurement differs | `mismatched` | Refused |
| Fewer than two measurements, a gap over `maxGapMs`, or any `unknown` measurement | `unknown` | Refused |

## Compatibility signatures

A candidate's **compatibility signature** content-addresses everything a pass depends on, each component hashed on its own: `manifest`, `build-inputs` (the builder's `buildInputsDigest`), `test-bundle`, `configuration`, `source`, `policy`, `artifacts`. A later candidate whose signature differs writes a `signature-regenerated` record naming the components that moved and supersedes the earlier candidate's requests; no cross-signature compatibility is inferred.
## Re-anchoring

A target *moves* when the latest authoritative observation measures a manifest other than the candidate's.

1. The existing request is superseded in place: state `superseded`, attempt history intact, attribution untouched, and a run it would have started recorded as avoided.
2. Graphyard decides whether the observed target **contains the intended change**, from trusted records only: a builder's attestation for this work item and environment whose artifacts are the observed manifest and whose source is the current candidate, or a release of this environment whose manifest is the observed one and whose source is the candidate. Another environment's records say nothing about this one.
3. If it does, a fresh candidate and request are created in the same transaction, each carrying `reanchoredFrom` and keeping the same runner, collector, deadline and budget; fresh execution is required.
4. Otherwise the binding is left visibly **blocked** with its reasons and retried on the next observation: observations disagree (wait for the observers to converge, or correct the wrong one); a service is unobserved, incomplete or only self-reported (fix the observer); the observed target matches no trusted attestation or release manifest (attest the build or define the release it runs); a release names the change but no attestation covers its manifest (attest the build that produced it); the target does not contain the intended change (deploy one that does — the ledger names the excluding record); or the superseded request's deadline has passed (request validation again).

## Cost and metrics

One cost unit is one paid run: an attempt the runner acknowledged. Units are counted, never priced: **spent** is acknowledged attempts in the window, **attributed** those bound to the observed target, **wasted** those whose target changed mid-execution or whose pass was undermined, **saved** the requests refused because the target already mismatched. A window with no acknowledged attempt and no avoided run reports cost as unknown, not zero.
