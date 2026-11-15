# Setup guide

The details the [README](../README.md) leaves out. `graphyard guide setup` prints every prerequisite check and fix; `graphyard doctor` verifies a host.

## Host

- Docker and Compose: on an AppArmor host up loads the `graphyard-trial` profile with sudo.
- Docker and Compose are needed even for `--local`; merge trials run in them.

## More hosts

- Put a spare laptop or VPS to work with `graphyard host add USER@HOST`. The host needs only Docker, Tailscale and this machine's SSH key; nothing is installed on it. The command checks Docker over SSH and refuses, with the reason, a host it cannot reach or one without Docker.
- Workers lists every host, this machine first, with cores, temperature, CPU steal and runs now. A host that stops answering shows Away and the master's loop tries it again each cycle.
- `graphyard host remove USER@HOST` stops using one; `graphyard host list` shows what is added.

## Accounts and access

- Workers and reviewers run headless, logged per item (`graphyard guide runtimes`).
- Where a SAML organization or org policy blocks deploy keys, `--push-auth gh` pushes with your gh login instead of a deploy key.
- Setup invites or revokes viewers and maintainers.
- Sharing one machine across installs: the [shared server guide](shared-server.md).

## Publishing

- Verified deploys publish `@cryptob1/graphyard` with npm OIDC provenance plus both GHCR images via Actions — no host publish token. `graphyard guide publishing` covers owner setup.
