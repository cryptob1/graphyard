# Setup guide

The details the [README](../README.md) leaves out. `graphyard guide setup` prints every prerequisite check and fix; `graphyard doctor` verifies a host.

## Host

- Docker and Compose: on an AppArmor host up loads the `graphyard-trial` profile with sudo.
- Docker and Compose are needed even for `--local`; merge trials run in them.
- Fair sharing: each worker, reviewer and producer session gets the same CPU and disk weight and a memory share (memory in proportion to the host's cores divided by the live sessions, never under two cores). A lone session may use the whole machine; on a full machine each gets about the same CPU. The loop, the master, the server and the database weigh more, so they answer under load. `master status` → `sessionUsage` and Workers → Session usage show each session's use beside its share; the overload alarm names a session only when the machine is saturated and it has used over twice its share for five minutes.

## More hosts

- A host lends Graphyard its compute and nothing else: merge trials send it test shards. Run `graphyard host prepare` here and the script it prints once on the host with sudo: it creates the unprivileged `gy-compute` user (no sudo, not in the docker group) with rootless Docker, and lets this machine's SSH key run only `graphyard-host-shim`, never a shell. The host needs no rootless extras preinstalled: when `dockerd-rootless-setuptool.sh` and `slirp4netns` are missing, the script itself fetches the static Docker rootless extras for the host's Docker version and a static slirp4netns into `gy-compute`'s home, checks them, and uses those; when the tools (or its own fetched copy) are there it downloads nothing. It needs `curl`, `python3` and `git`.
- `graphyard host add gy-compute@HOST` refuses a host it cannot reach, one without Docker, a key that opens a plain shell, root, and a docker-group user, each with the reason. Workers lists every host, this machine first, with cores, temperature, CPU steal and runs now; one that stops answering shows Away.
- Compute-only port: where port 22 is Tailscale SSH, which ignores keys and so the shim, the script also starts an OpenSSH for `gy-compute` only on port 2222 (key-only, no shell, tty or forwarding, always the shim). Add it as `gy-compute@HOST:2222`, or as an alias from `~/.ssh/config` such as `graphyard host add vish-msi-compute`.
- Tailnet check rule: every Tailscale ssh rule that reaches a host must use action `check`, never `accept`, so no account there logs in unattended. `host add` tries your own account on the host's port 22 and warns when it gets in without you.
- `graphyard host remove USER@HOST` stops reading one; `graphyard host list` shows the one host list.
- Accepted risk: a host can forge its own shard results, so add only machines you own. Remote shard runs read this same host list.
- Each trial sends each test shard to the host with the most free CPU under its heat limit. There the shard gets a clone of the commit and runs with no network, under CPU, memory and process limits. A host that drops a shard hands it back: capacity, never a fault. `master status` → `remoteShards` shows each host.
- Tests that need Docker or the network — compose, trial-container and e2e tests, anything starting a server or a database — stay on this machine: a host's shard has no network and no Docker socket, so they would only fail there. Every other test file may run on a host.

## Onboarding a project

- A project is onboarded only when main's `graphyard.json` declares two things: an `e2e.serve` that starts the real application, and a feature map (`featureMap`). Setup and `graphyard master status` read them from main, not from your working copy.
- The feature map lists each feature of the app: its name, the URL path on the served app or a command to run, and its traps (known pitfalls, empty when none). Example: `"featureMap": [{"name":"Home","url":"/","traps":[]}]`.
- Every batch check runs the feature map against the served app, and every deploy check runs it against the deployed site.
- A missing serve, a missing feature map, or the generated placeholder serve that runs none of the app shows as a Master fault naming the project in `graphyard master status`, and Setup shows the same Master fault. The checks never report a pass for it. The master files the work to add the real serve and map; there is nothing for you to do.

## Your app's address

- Onboarding step: add `"app": { "url": "https://HOST.TAILNET.ts.net:PORT" }` to `graphyard.json` on main, with the tailnet or public address where the app runs. The dashboard's top bar then shows Open app, and Work's Where it runs card shows the link, the machine, the serving commit, its deploy time and the dashboard's own link.
- The master refuses `127.0.0.1`, `localhost` and `::1`, which open only on that machine, and says why; `graphyard master status` names the setting while none is set.

## Accounts and access

- Workers and reviewers run headless, logged per item (`graphyard guide runtimes`).
- Where a SAML organization or org policy blocks deploy keys, `--push-auth gh` pushes with your gh login instead of a deploy key.
- Setup invites or revokes viewers and maintainers.
- Sharing one machine across installs: the [shared server guide](shared-server.md).

## Shipped means live

Work counts a merge as shipped once the live app runs a commit that contains it; until then it is going live. The top bar and the Work page show the same two numbers. When your app deploys somewhere else, such as Railway, tell Graphyard where to ask which commit is live, in `graphyard.json`:

```json
{ "app": { "healthUrl": "https://your-app.example.com/version" } }
```

The URL must answer the commit it runs: the plain SHA, or JSON with a `commit` or `sha` field. Graphyard asks at most once a minute. Without it, Graphyard reads the commit from its own deploy, and with neither nothing counts as shipped.

## Delivery feedback

Work's **Taste** feed shows recent deliveries with why and evidence: **Looks good** records your call, **Send back** turns your note into a follow-up item and a proposed master lesson; nothing waits on a taste.

## Apps deployed elsewhere

Graphyard watches an app another host deploys, such as a Go service on Railway, when `graphyard.json` names where it reports its commit:

```json
{ "delivery": { "mode": "local", "applications": [
  { "id": "api", "directory": "services/api", "versionUrl": "https://api.example.com/healthz" }
] } }
```

The `versionUrl` answers the commit it serves (JSON `commit` or `sha`, or plain text). `master status` reads this from the main branch, not the local checkout, and lists the app as current, deploying, lagging or failed. If main's declaration is invalid, it names the bad fields. Graphyard never deploys or previews such an app.

## Publishing

- Verified deploys publish `@cryptob1/graphyard` with npm OIDC provenance plus both GHCR images via Actions — no host publish token. `graphyard guide publishing` covers owner setup.
