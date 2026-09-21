<!-- page: Agent protocol | 1 | authentication, retries. -->
# Roles, requests and reads

For an integration author: which credential may call what.

Every credential's authority is tabulated once, in [the roles at a glance](../glossary.md#the-roles-at-a-glance). All control-plane endpoints except `/healthz` and the HMAC-verified webhook require `Authorization: Bearer TOKEN`, over HTTPS from a remote machine; API credentials are not Git credentials.

## Requests and retries

- **`Idempotency-Key`:** required on every mutation, at most 200 characters. Generate a UUID once, reusing it only to retry the identical request after a timeout.
- **Replay:** returns the original result without repeating the command; different input under that key returns `409`.
- **Errors:** JSON `{ "error": "actionable reason" }`: `400` invalid JSON or schema, `401` unauthenticated, `403` wrong role, `404` unknown route or item, `409` a coordination refusal, `413` oversize input.
- Never retry a coordination refusal blindly: read status and resolve its reason.

Reads: [read endpoints](read-endpoints.md).
