# Graphyard

**Turn a fleet of coding agents into an engineering system.**

Agents write code; Graphyard records ownership and evidence and merges only the exact change every gate allowed.

```text
Backlog → Ready → Build → Review → Test → Acceptance → Merge → Done
```

[Install](docs/install.md) · [How it works](docs/how-graphyard-works.md) · [Onboard a repository](docs/onboarding.md) · [Documentation](docs/README.md)

## Install

```sh
cd /path/to/your-repository
node /path/to/graphyard/bin/graphyard.mjs install --provider railway --repo OWNER/REPO --plan  # then --apply
```

**[docs/install.md](docs/install.md) is the primary install path**; use `--provider compose` to evaluate locally.

## Contribute

Read [AGENTS.md](AGENTS.md) and [development](docs/development.md); run `npm run build` and `npm test`. Apache 2.0.
