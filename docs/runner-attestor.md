<!-- page: Build integrations | 5 | the attestor and its signature. -->
# The host attestor and its attestation

For the operator deploying the [packaged runner](runner-setup.md): what the signature is worth.

```bash
GRAPHYARD_ATTESTOR_KEY=/etc/graphyard/attestor.key \
GRAPHYARD_ATTESTOR_URL=https://graphyard.example.test \
GRAPHYARD_ATTESTOR_TOKEN_FILE=/etc/graphyard/attestor.token \
  graphyard runner supervise
```

## The attestor verifies authority itself

It holds a **read-only** Graphyard credential of its own — role `reader`, no proof scope, never the runner's or collector's — for one call, `GET /api/validation/attempt/REQUEST_ID`. It reads twice, and both reads gate execution: before provisioning, the plan's `grant` must be exactly the authority Graphyard dispatched; after the runner reports acknowledgement, that authority must still stand with `state: running`, an acknowledged attempt and an unexpired lease. The pipe handshake is a sequencing signal, never authority to execute, and because `collecting` fails the second read no container starts after the collector observed settlement.

## Limits of this path

- The target must be immutable and operator-configured; a URL from arbitrary pull-request output is not acceptable input.
- Trace, screenshot and video capture are unimplemented under the protection policy and are refused, so failure diagnosis relies on the data-minimised step trace plus the target's own logs.
- The attestor, the Docker daemon and the collector share one host, because preflight measures mounted bytes on the attestor's own filesystem; a remote execution endpoint is refused rather than trusted, and the three identities stay separate.
- Container isolation is asserted here, but a container boundary is a claim about this executor's configuration, not a proof of sufficient isolation against hostile code.
- Settlement is verified through the container runtime. External side effects in a shared system are not settled by removing a container: use approved test accounts and fresh isolated resources, or refuse dispatch.
