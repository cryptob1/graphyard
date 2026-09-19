<!-- page: Agent protocol | 9 | evidence submission, proof authority grants, and the post-deployment smoke proof. -->
# Evidence and proof authority

```json
{
  "proof": "integration:claim-safety",
  "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "baseSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "policyRevision": 1,
  "result": "pass",
  "executed": 32,
  "skipped": 0,
  "url": "https://github.com/OWNER/REPO/actions/runs/RUN"
}
```

SHA fields are full 40-character lowercase Git SHAs. Results are `pass` or `fail`. Counts must be nonnegative integers. For manual acceptance, executed means the number of criteria actually inspected, not a fabricated test count.

The server supplies evidence ID, identity, timestamp, and trust. Clients cannot set `trusted` or `producer`. Unknown fields are rejected. A producer may submit an unauthorized proof, but it remains untrusted. A producer is a trust boundary, not a guarantee that its test was well designed.

## Proof authority

Trust is decided against the live grant set inside each mutation transaction, never against process configuration. `POST /api/proof-grants/ID/grant` and `POST /api/proof-grants/ID/revoke` take `{ "patterns": [...], "reason": "...", "expectedRevision": N }` and require the `admin` role; `expectedRevision` is optional and refuses a stale write when supplied. A pattern is an exact proof name, a whole kind such as `integration:*`, or a bounded prefix such as `manual:gy-43/*`; nothing else parses. Grants apply only to `producer` principals — `worker`, `reader`, `coordinator` and `operator-agent` are refused with `403` — while `admin` holds the `manual:*` lane by role. Validation collector registrations are bounded by the same live authority, so revoking a grant immediately withdraws a collector's scope. Environment allowlists seed the grant store once at startup and decide nothing afterwards. See [Proof authority grants](../operations.md#proof-authority-grants).

Work creation and every requirement revision record `proofGaps`: the required proof names that had no authorized producer at that moment. A nonempty list means the acceptance gate cannot be satisfied by anyone, and it is visible in `graphyard status`, `graphyard diagnose`, and the dashboard before the item is dispatched.

All required proof names must pass. Evidence is selected for the exact head/base/policy tuple. A later matching failure supersedes an earlier pass. Stale evidence is retained for audit without satisfying the current candidate.

`e2e:deploy-smoke` is the one proof submitted after delivery. For it, `sha` is the deployed commit the checks ran against — the one recorded by the `deployment` command — and `baseSha` is the item's merge commit. It is accepted only from a producer granted that proof, only when the work policy sets `deploySmoke`, only after the deployment observation exists, and only with exactly those two commits and the current policy revision; any other submission is refused rather than stored untrusted. The result is recorded as `delivery.smoke`.
