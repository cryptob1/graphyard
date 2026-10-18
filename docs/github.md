<!-- page: Operate Graphyard | 2 | deploy key, observation. -->
# GitHub access

Graphyard install registers **no** GitHub App and writes **no** branch protection or ruleset (GY-2009). The merge writer's deploy key (read-write on OWNER/REPO) is the only GitHub credential install creates; the control-plane trial (merge, build, typecheck, tests, secret scan) is the gate.

## Deploy key

`install --apply` and `up`'s deploy-key step create `INSTALL_DIR/deploy-key` (ed25519, mode 0600) and register it as `graphyard-merge-writer-<host>` with write access. Re-runs are idempotent by fingerprint. The merge writer pushes base advances with that key alone.

## App permissions

Optional for observation-only / legacy App binds only. New installs take no App. Saved keys: `graphyard app import` / `app list` / `app bind`.

## Require the check

Install never writes branch protection or rulesets. The merge writer's trial is the gate.

## Failed checks

Rework rules: [work commands](protocol/work-commands.md), [leases](protocol/leases.md).

### Bindings and carry

[Leases](protocol/leases.md), [webhook](protocol/github-webhook.md).

### Proofs in CI

Trusted producers still publish proof evidence. **plan** reads `/api/status` and `GET /api/work?pr=N` (never the work list) bounded by `planReads` (`scripts/enumerate-ci-proofs.mjs`), then finds `unit:*`/`integration:*` proofs; exercise and publish stay producer-side (no Actions PR gate).

## Identity-bound agent review

`reviewProvider`: `codex` or `agent` profiles; see [delivery](delivery.md). The control-plane merger does not require a reviewer App.
