<!-- page: Agent protocol | 1 | authentication, retries. -->
# Roles, requests and reads

For an integration author: which credential may call what.

Every credential's authority is tabulated once, in [the roles at a glance](../glossary.md#the-roles-at-a-glance). All control-plane endpoints except `/healthz` and the HMAC-verified webhook require `Authorization: Bearer TOKEN`, over HTTPS from a remote machine; API credentials are not Git credentials.

## Requests and retries

- Never retry a coordination refusal blindly: read status and resolve its reason, and see [read endpoints](read-endpoints.md).
