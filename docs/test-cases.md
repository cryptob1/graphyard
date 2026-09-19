<!-- page: Build integrations | 2 | versioned E2E scenarios pinned to environments. -->
# E2E test-case registry

Graphyard stores versioned test-case definitions separately from execution evidence. A test-case definition describes what should be tested. An evidence record describes what a trusted runner actually observed.

## What lives where

| Information | Location |
| --- | --- |
| Scenario purpose, setup, actions, expected results, target environment | Graphyard test-case registry |
| Executable Playwright/Cypress/custom test | Git, linked by runner and file path |
| Scenario version required by a work item | Pinned in the work item at creation |
| Commit, base, result, executed/skipped counts, producer, environment | Graphyard evidence ledger |
| Screenshots, videos, traces, large logs | CI/object storage, linked by evidence URL |

The MVP does not upload large artifacts or schedule E2E execution. It stores definitions and enforces the relationship between scenarios, criteria, and reported executions. Runner orchestration and object-storage retention can follow independently.

## Define a case

Open **Test cases** in the sidebar and choose **New test case**. Enter a stable ID, purpose, setup, steps, expected outcomes, environment, runner, and file path. For example:

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

Alternatively, as an operator:

```sh
graphyard scenario scenario.json
graphyard scenarios
```

The API is `POST /api/scenarios` and `GET /api/scenarios`. All requests require authentication; publication also requires the human operator's `admin` credential and an idempotency key. Reads return all immutable revisions ordered by ID and newest revision first.

## Versioning

A new case uses `expectedRevision: 0`. To revise an existing case, submit its ID with `expectedRevision` equal to the current revision. The server publishes the next immutable version and a content hash. Concurrent edits with a stale revision refuse. Previous versions cannot be overwritten or deleted through the application or normal SQL updates.

This is definition versioning, not automatic Git synchronization. If executable assertions or intended outcomes change, publish a new scenario version and create work with the revised requirement. Graphyard records the executable path but does not parse the test code to infer its meaning.

## Link to acceptance

Add `e2e:confirmed-booking-sends-sms` to an acceptance criterion's required proofs. The scenario must already exist. Work creation pins the latest published revision, content hash, and environment. Later scenario edits do not silently change existing work's requirements.

Operators can revise a work item's acceptance criteria and dependencies through the audited [requirement revision workflow](coordination.md#revise-requirements-explicitly). Release active ownership first; a revision invalidates previous acceptance evidence and review authorization, and submitted implementation requires a new attempt. Existing E2E proof names retain their pinned scenario versions; newly added E2E proofs pin the latest registered definition. Selecting a newer version for an existing scenario pin is not supported by this command—use a follow-up work item for that version, retaining the previous item for history.

## Report an execution

A trusted producer with permission for that exact proof name submits ordinary evidence plus:

```json
{
  "scenarioRevision": 1,
  "environment": "staging"
}
```

Include the exact tested head SHA, base SHA, policy revision, result, counts, and artifact URL described in the [agent protocol](protocol/evidence.md). The evidence must match the pinned scenario revision and environment, in addition to the candidate and policy. A passed staging run cannot satisfy a production requirement. An older or newer scenario run cannot satisfy the pinned version accidentally.

Defining a case does not count as running it. Running it does not count as passing it. A worker reporting pass does not make the result independently trusted.

## Loading and revised work

The library distinguishes loading, failed reads and a confirmed empty result. The empty-library prompt appears only after a successful read returns nothing. Retry a failed read; definitions already observed stay on screen and are labeled potentially stale. When a read fails and no definition has been observed, the library reports that its contents are unknown instead of implying the library is empty or that stale definitions are displayed. A rejected publish is reported on the form alone and never changes what the page says about the last read. Adding a definition does not run tests. Work requirements can be revised by an operator using the [coordination guide](coordination.md), while existing scenario pins remain unchanged.
