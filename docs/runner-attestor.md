<!-- page: Build integrations | 5 | attestor signature. -->
# The host attestor and its attestation

For the operator deploying the [packaged runner](runner-setup.md): what the signature is worth.

```bash
GRAPHYARD_ATTESTOR_KEY=/etc/graphyard/attestor.key \
GRAPHYARD_ATTESTOR_URL=https://graphyard.example.test \
GRAPHYARD_ATTESTOR_TOKEN_FILE=/etc/graphyard/attestor.token \
  graphyard runner supervise
```

## The attestor verifies authority itself

It holds a **read-only** Graphyard credential of its own for one call, `GET /api/validation/attempt/REQUEST_ID`. It reads twice; both reads gate execution:

- **Credential:** role `reader`, no proof scope, never the runner's or collector's
- **Before provisioning:** the plan's `grant` must be exactly the authority Graphyard dispatched
- **Pipe handshake:** a sequencing signal, never authority to execute, so no container starts after the collector observed settlement

## Limits of this path

- The target must be immutable and operator-configured: a URL from arbitrary pull-request output is unacceptable input.
