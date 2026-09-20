<!-- page: Build integrations | 7 | manifests, exact-target validation, re-anchoring. -->
# Candidate-to-deployment attribution

For anyone reading a validation pass: what binds it to one target.

## Manifests and trust

A **manifest** maps every service of an environment to an artifact digest and a source SHA at one configuration revision. A manifest is never supplied — it is derived from a release revision (its `manifest`, `sourceSha`, environment revision and explicit `members`) or from the validation build attestation a candidate pins (`artifacts`, `sourceSha`, `baseSha`). `GET /api/attribution/manifest/RELEASE_ID/REVISION` returns a release manifest with its `hash`, its `digestHash` and its membership, excluded members included. What each identity may establish:

- **Builder registration (`producer`):** Source → artifact mapping, as a build attestation
- **Operator (`admin`) or promoter:** Release identity and membership
- **Observer registration with a current lease:** What its services are running, per instance, with a `measurement` of `provider` or `host-attestation`
- **Collector registration:** The result of an attempt, rechecked by Graphyard against the pinned candidate and the observers' record
- **Implementation worker, runner, validation client, application self-report, client-supplied SHA:** Nothing. A worker or runner credential is refused; a `self-report` or `unknown` measurement is `unknown` even when the claimed digest agrees; a `sha`, `sourceSha`, `commitSha` or similar field on a result is refused before the report is parsed, and the refusal is ledgered

## Exact-target validation

A request record is bound once to the candidate's manifest hash and digest hash, its **compatibility signature**, the environment's target kind — `immutable-preview` or `shared-staging` — and the target identity its observers report at that instant (`unobserved`, `matched`, `mismatched` or `unknown`, with the observation identifiers). A target already measured running another manifest refuses the request outright, before any paid execution, and the ledger records the mismatch and the avoided run; at dispatch the grant is rechecked, and a known mismatch withholds it and re-anchors the request. Shared staging is stricter, because nothing declares its target fixed: it is granted only once observers have measured the candidate manifest running, and passes only if the observed identity stayed `matched` across the whole execution window. An immutable preview may execute while unobserved, but any measured observation contradicting the candidate manifest during the window fails the result.

### Whole-run coverage

Coverage requires measurements bracketing the whole execution interval with no gap longer than `maxGapMs`, so an A → B → A rollout inside it is either observed or left uncovered. Only that interval is judged — the nearest measurement at or before the start and at or after the finish are the boundaries — so a rollout an hour later does not invalidate the run and a measurement an hour earlier does not cover it.

| Situation | Attribution | Outcome |
| --- | --- | --- |
| Continuous coverage, every measurement matches | `matched` | Can pass |
| A mid-run measurement differs, boundaries agree | `changed` | Attempt and behaviour retained, attribution invalid |
| The final measurement differs | `mismatched` | Refused |
| Fewer than two measurements, a gap over `maxGapMs`, or any `unknown` measurement | `unknown` | Refused |

## Compatibility signatures

A candidate's signature is the content address of everything a pass depends on, each component hashed on its own: `manifest`, `build-inputs` (the builder's `buildInputsDigest`), `test-bundle`, `configuration`, `source`, `policy` and `artifacts`. Any change regenerates the signature: a later candidate whose signature differs writes a `signature-regenerated` record naming the components that moved, and the earlier candidate's requests are superseded. No cross-signature compatibility is ever inferred.

## Re-anchoring

A target *moves* when the latest authoritative observation measures a manifest other than the candidate's.

1. The existing request is superseded in place: state `superseded`, attempt history intact, attribution untouched. Nothing is edited, relabelled or retargeted, and a run it would have started is recorded as avoided.
2. Graphyard decides whether the observed target **contains the intended change**, from trusted records only: a builder's attestation for this work item and environment whose artifacts are the observed manifest and whose source is the current candidate, or a release of this environment whose manifest is the observed one and whose source is the candidate. Records of another environment say nothing about this one.
3. If it does, a fresh candidate and request are created in the same transaction, each carrying `reanchoredFrom` and keeping the same runner, collector, deadline and budget. Fresh execution is required; no earlier pass carries over.
4. Otherwise the binding is left visibly **blocked** on the work item with its reasons, and the next observation retries the decision. Each reason and its resolution:

- **Overlapping authoritative observations disagree:** Wait for the observers to converge, or correct the one that is wrong
- **Some service is unobserved, incomplete or only self-reported:** Fix the observer so every service is measured
- **The observed target matches no trusted attestation or release manifest:** Attest the build or define the release the target is running
- **A release names the change but no attestation for this item covers its manifest:** Attest the build of this candidate that produced the released manifest
- **The observed target does not contain the intended change:** Deploy a target that does; the ledger names the record that excludes it
- **The superseded request's deadline has passed:** Request validation again

## Cost and metrics

One cost unit is one paid run: an attempt the runner acknowledged, which is what authorizes a container start. Units are counted, never priced. **Spent** is acknowledged attempts in the window, **attributed** those whose result was bound to the observed target, **wasted** those whose target changed during execution or whose pass was later undermined, and **saved** the grants and requests refused because the target already mismatched. A window with no acknowledged attempt and no avoided run reports cost as unknown, not zero.

