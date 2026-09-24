<!-- page: Agent protocol | 2 | idempotency keys and error codes. -->
# Requests and retries

Every mutation requires `Idempotency-Key`, at most 200 characters. Generate a UUID once and reuse it only when retrying the identical request after a timeout. A successful replay returns the original result without repeating the command. Different input under the same key returns `409`.

Errors return JSON `{ "error": "actionable reason" }`. Invalid JSON/schema is `400`, unauthenticated is `401`, wrong role is `403`, unknown route/item is `404`, coordination refusal is `409`, and oversize input is `413`. Do not retry a coordination refusal blindly; read status and resolve its reason.
