<!-- page: Agent protocol | 1 | authentication and retries. -->
# Roles, requests and reads

For an integration author: which credential may call what.

Every credential's authority is tabulated once, in [the roles at a glance](../glossary.md#the-roles-at-a-glance). All control-plane endpoints except `/healthz` require `Authorization: Bearer TOKEN`, and API credentials are not Git credentials.

## Requests and retries

Every mutation requires `Idempotency-Key`, at most 200 characters: generate a UUID once and reuse it only when retrying the identical request after a timeout, since a replay returns the original result without repeating the command and different input under that key returns `409`. Errors return JSON `{ "error": "actionable reason" }` — `400` invalid JSON or schema, `401` unauthenticated, `403` wrong role, `404` unknown route or item, `409` a coordination refusal, `413` oversize input. Never retry a coordination refusal blindly: read status and resolve its reason.

Reads are listed on their own page: [read endpoints](read-endpoints.md).
