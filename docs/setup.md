# Setup guide

The details the [README](../README.md) leaves out. `graphyard guide setup` prints every prerequisite check and fix; `graphyard doctor` verifies a host.

## Host

- Docker and Compose: on an AppArmor host up loads the `graphyard-trial` profile with sudo.
- Docker and Compose are needed even for `--local`; merge trials run in them.

## More hosts

- A host lends Graphyard its compute and nothing else; work does not run there yet, the loop only watches it. Run `graphyard host prepare` here and the script it prints once on the host with sudo: it creates the unprivileged `gy-compute` user (no sudo, not in the docker group) with rootless Docker, and lets this machine's SSH key run only `graphyard-host-shim`, never a shell.
- `graphyard host add gy-compute@HOST` refuses a host it cannot reach, one without Docker, a key that opens a plain shell, root, and a docker-group user, each with the reason. Workers lists every host, this machine first, with cores, temperature, CPU steal and runs now; one that stops answering shows Away.
- Compute-only port: where port 22 is Tailscale SSH, which ignores keys and so the shim, the script also starts an OpenSSH for `gy-compute` only on port 2222 (key-only, no shell, tty or forwarding, always the shim). Add it as `gy-compute@HOST:2222`, or as an alias from `~/.ssh/config` such as `graphyard host add vish-msi-compute`.
- Tailnet check rule: every Tailscale ssh rule that reaches a host must use action `check`, never `accept`, so no account there logs in unattended. `host add` tries your own account on the host's port 22 and warns when it gets in without you.
- `graphyard host remove USER@HOST` stops reading one; `graphyard host list` shows the one host list.
- Accepted risk: a host can forge its own shard results, so add only machines you own. When remote shard runs come, they will read this same host list.

## Accounts and access

- Workers and reviewers run headless, logged per item (`graphyard guide runtimes`).
- Where a SAML organization or org policy blocks deploy keys, `--push-auth gh` pushes with your gh login instead of a deploy key.
- Setup invites or revokes viewers and maintainers.
- Sharing one machine across installs: the [shared server guide](shared-server.md).

## Publishing

- Verified deploys publish `@cryptob1/graphyard` with npm OIDC provenance plus both GHCR images via Actions — no host publish token. `graphyard guide publishing` covers owner setup.
