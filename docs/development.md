<!-- page: Understand or contribute | 2 | repository layout, where new features go, and validating a change. -->
# Development and dogfooding

## Repository layout

| Path | Responsibility |
| --- | --- |
| `src/model/` | Schemas, types and pure gate evaluation (barrel `src/model.ts`) |
| `src/store/` | Postgres transactions, events, jobs; `src/store/tables/` is the schema registry |
| `src/engine.ts` | Authenticated commands, ownership, evidence, reconciliation |
| `src/github.ts` | App auth, observations, check publishing |
| `src/server/` | HTTP assembly; `src/server/routes/` one module per resource |
| `src/cli/` | One command module per group; help is generated from them |
| `scripts/` | Trusted contracts, acceptance publisher, `protect-github`, `verify-enforcement`, `check-docs` |
| `web/pages/` | One dashboard page per view |
| `docs/` | Guides; `docs/protocol/` one page per topic; diagrams under `docs/diagrams/` (`node scripts/render-docs-diagrams.mjs`) |

## Where a new feature goes

| Adding | Touch |
| --- | --- |
| A CLI command | One entry in a module under `src/cli/` (`defineCommands`) |
| An HTTP route | One entry in a module under `src/server/routes/` (`defineRoutes`) |
| A schema or gate rule | The concern module under `src/model/` |
| A table | A `defineTable` under `src/store/tables/`; migrations and backups derive from it |
| A dashboard view | A page under `web/pages/` and one entry in `web/pages/index.tsx` |
| A protocol topic | A page under `docs/protocol/` with a `<!-- page: Agent protocol \| N \| summary -->` first line, then `npm run docs:check -- --write` |
| Managed `AGENTS.md` text | The template in `src/repository-setup.ts` or `src/master.ts`, then re-render and commit `AGENTS.md` |

`docs/README.md` and `docs/protocol.md` are generated in full by `npm run docs:check -- --write`; never edit them by hand. `graphyard sync` regenerates them on conflict, and the regression guard exempts them once the deployment sets `GRAPHYARD_GENERATED_FILES` to the paths `scripts/check-docs.mjs --manifest` prints. `tests/hotspots.test.ts` holds each assembler to a size budget; raise one only with a further split.

## Validate a change

```sh
npm ci
npm run build
npm test
```

Tests run isolated Postgres on ports 15438–15448 (`GRAPHYARD_TEST_PORT` moves the range). Never point tests at production. Run as a non-root user. Test behaviour — conflicting claims, stale epochs, replays, stale evidence, producer scope — and keep GitHub calls outside transactions.

Graphyard's own repository routes work through Graphyard; see the [repository bootstrap guide](first-pr.md). Never weaken policy to get Graphyard's own PRs through. Issues and PRs must not contain tokens or keys. Apache-2.0.
