<!-- page: Build integrations | 2 | versioned E2E scenarios. -->
# E2E test-case registry

For anyone defining an E2E proof: what lives where, and what a report must match.

- **Registry:** a scenario's purpose, setup, actions, expected results and target environment
- **Git:** the executable Playwright, Cypress or custom test, linked by runner and path
- **Work item:** pins the scenario version at creation
- **Evidence ledger:** commit, base, result, executed and skipped counts, producer and environment
- **CI or object storage:** screenshots, videos, traces and large logs, linked by evidence URL

## Define, version and link a case

- **Dashboard:** open **Test cases** → **New test case**
- **CLI, as an operator:** `graphyard scenario scenario.json` (`graphyard scenarios` lists them)
- **Definition fields:** stable `id`, `title`, `purpose`, `setup`, `steps`, `expected`, `environment`, `runner`, `testPath`, `expectedRevision`

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

## Report an execution

A trusted producer holding that exact proof name submits ordinary [evidence](protocol/evidence.md) plus `{"scenarioRevision": 1, "environment": "staging"}`, which must match the pinned scenario revision and environment, the candidate and policy:

- A staging run cannot satisfy a production requirement
- An older or newer scenario run cannot satisfy the pinned version

