<!-- page: Build integrations | 2 | E2E scenarios. -->
# E2E test-case registry

For anyone defining an E2E proof: what lives where, and what a report must match.

- **Registry:** a scenario's purpose, setup, actions, expected results and target environment
- **Git:** the executable Playwright, Cypress or custom test, linked by runner and path
- **Work item:** pins the scenario version at creation
- **Evidence ledger:** commit, base, result, executed and skipped counts, producer and environment
- **CI or object storage:** screenshots, videos, traces and large logs, linked by evidence URL

## Define, version and link a case

- **Dashboard:** open **Test cases** → **New test case**

## Report an execution

A trusted producer holding that exact proof name submits ordinary [evidence](protocol/evidence.md) plus `{"scenarioRevision": 1, "environment": "staging"}`, matching the pinned scenario revision and environment, the candidate and policy:

- A staging run cannot satisfy a production requirement

