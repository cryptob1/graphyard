# Graphyard

**Turn a fleet of coding agents into an engineering system.** Agents write the code; Graphyard records ownership and evidence, merging only the exact change every gate allowed.

```text
Backlog → Ready → Build → Review → Test → Acceptance → Merge → Done
```

**Start with [From zero to a running Graphyard](docs/setup-from-zero.md)**: the one ordered setup checklist, a new repository to a merged first item.

[Install](docs/install.md) · [How it works](docs/how-graphyard-works.md) · [Onboard a repository](docs/onboarding.md) · [Documentation](docs/README.md)

## Install

From your repository ([checklist](docs/setup-from-zero.md) step 3):

```sh
node /path/to/graphyard/bin/graphyard.mjs install --provider railway --repo OWNER/REPO --plan   # then --apply
```

**[docs/install.md](docs/install.md) is the primary install path**; `--provider compose` evaluates locally.

## Contribute

Read [AGENTS.md](AGENTS.md) and the [development guide](docs/development.md); run `npm run build` and `npm test`. Apache 2.0.
