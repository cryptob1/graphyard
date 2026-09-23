<!-- page: Build integrations | 7 | manifests, targets. -->
# Candidate-to-deployment attribution

For anyone reading a validation pass: what binds it to one target.

## Manifests and trust

A **manifest** maps every service of an environment to an artifact digest and a source SHA at one configuration revision, never supplied, only derived from:

- **A release revision:** its `manifest`, `sourceSha`, environment revision and explicit `members`
- **The build attestation a candidate pins:** `artifacts`, `sourceSha`, `baseSha`

What each identity may establish:

- **Builder registration (`producer`):** Source → artifact mapping, as a build attestation
- **Operator (`admin`) or promoter:** Release identity and membership
- **Observer registration with a current lease:** What its services run, per instance, with a `measurement` of `provider` or `host-attestation`
- **Collector registration:** An attempt's result, rechecked against the pinned candidate and the observers' record

## Exact-target validation

A request record is bound once to:

- The candidate's manifest hash, digest hash and **compatibility signature**
- **Environment's target kind:** `immutable-preview` or `shared-staging`
- **Target identity its observers report then:** `unobserved`, `matched`, `mismatched` or `unknown`

Enforcement:

- **`immutable-preview`:** may execute while unobserved; any measured observation contradicting the candidate manifest during the window fails the result

### Whole-run coverage

Coverage requires measurements bracketing the whole execution interval with no gap over `maxGapMs`, so a rollout inside it is observed or leaves the run uncovered. Only that interval is judged, bounded by the nearest measurement at or before the start and at or after the finish: a later rollout never invalidates the run, an earlier measurement never covers it.

- **Continuous coverage, every measurement matching:** `matched`, can pass
- **A mid-run measurement differing, boundaries agreeing:** `changed`; attempt and behaviour retained, attribution invalid
- **The final measurement differing:** `mismatched`, refused
- **Fewer than two measurements, a gap over `maxGapMs`, or any `unknown` measurement:** `unknown`, refused

## Compatibility signatures

A candidate's **compatibility signature** content-addresses everything a pass depends on:

- **Components, each hashed on its own:** `manifest`, `build-inputs` (the builder's `buildInputsDigest`), `test-bundle`, `configuration`, `source`, `policy`, `artifacts`

## Re-anchoring

A target *moves* when the latest authoritative observation measures a manifest other than the candidate's.

2. Graphyard decides whether the observed target **contains the intended change**, from trusted records only: a builder's attestation for this item and environment, or a release of this environment, whose manifest is the observed one and whose source is the current candidate.
4. Otherwise the binding stays visibly **blocked** with its reasons, retried on the next observation, per reason:
   - **Observations disagree:** wait for the observers to converge, or correct the wrong one
   - **Service unobserved, incomplete or only self-reported:** fix the observer
   - **Observed target matches no trusted attestation or release manifest:** attest the build or define the release it runs
   - **Release names the change but no attestation covers its manifest:** attest the producing build
   - **Superseded request's deadline passed:** request validation again

## Cost and metrics

One cost unit is one paid run, an attempt the runner acknowledged; units are counted, never priced:

- **spent:** acknowledged attempts in the window
- **attributed:** those bound to the observed target
- **wasted:** those whose target changed mid-execution or whose pass was undermined
- **saved:** requests refused because the target already mismatched

A window with no acknowledged attempt or avoided run reports cost unknown, not zero.
