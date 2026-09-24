<!-- page: Build integrations | 2 | versioned E2E scenarios. -->
# E2E test-case registry

A test-case definition says what should be tested; evidence says what a trusted runner observed. Executable tests live in Git; artifacts live in CI or object storage, linked by URL.

## Define a case

Use **Test cases → New test case** in the dashboard, or as the human operator:

```json
{
  "id": "confirmed-booking-sends-sms",
  "title": "Booking confirmation sends one SMS",
  "purpose": "Prove the customer receives exactly one correctly formatted confirmation",
  "setup": ["A test customer and pending booking exist", "SMS requests are captured by the staging test sink"],
  "steps": ["Confirm the booking", "Retry the same confirmation", "Inspect captured SMS requests"],
  "expected": ["Exactly one SMS was sent", "The message includes the booking date and time"],
  "environment": "staging",
  "runner": "Playwright",
  "testPath": "tests/e2e/booking-sms.spec.ts",
  "expectedRevision": 0
}
```

```sh
graphyard scenario scenario.json
graphyard scenarios
```

API: `POST /api/scenarios` (`admin`, idempotency key) and `GET /api/scenarios`. Revise with `expectedRevision` equal to the current revision; revisions are immutable and hashed.

## Link to acceptance

Add `e2e:confirmed-booking-sends-sms` to a criterion's proofs. Work creation pins the latest revision, hash and environment; later edits never change existing work. To adopt a newer revision, create a follow-up item.

## Report an execution

A producer granted that proof submits ordinary [evidence](protocol/evidence.md) plus:

```json
{
  "scenarioRevision": 1,
  "environment": "staging"
}
```

It must match the pinned revision, environment, candidate and policy. A worker's report of a pass is not trusted.
