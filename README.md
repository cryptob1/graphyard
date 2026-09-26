# Graphyard

**Turn a fleet of coding agents into an engineering system.**

Graphyard is an open-source control plane for coding agents: agents write the code; Graphyard records ownership and evidence, and merges only the exact change every gate allowed.

```text
Backlog → Ready → Build → Review → Test → Acceptance → Merge → Done
```

[Install](docs/install.md) · [How it works](docs/how-graphyard-works.md) · [Onboard a repository](docs/onboarding.md) · [Documentation](docs/README.md)

## Install

```sh
export GRAPHYARD_CLI=/absolute/path/to/graphyard/bin/graphyard.mjs
cd /path/to/your-repository
node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --plan
node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --apply
```

**[docs/install.md](docs/install.md) is the primary install path**; use `--provider compose` to evaluate locally.

## Contribute

Read [AGENTS.md](AGENTS.md) and the [development guide](docs/development.md); run `npm run build` and `npm test`. Apache 2.0.
