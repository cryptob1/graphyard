<!-- page: Understand or contribute | 2 | where new features go and how to validate. -->
# Development and dogfooding

## Where a new feature goes

| Adding | Touch |
| --- | --- |
| A CLI command | A module under `src/cli/` (`defineCommands`); help is generated |
| An HTTP route | A module under `src/server/routes/` (`defineRoutes`) |
| A schema or gate rule | The concern module under `src/model/` |
| A table | A `defineTable` under `src/store/tables/`; migrations and backups derive from it |
| A dashboard view | A page under `web/pages/` plus one entry in `web/pages/index.tsx` |
| A protocol topic | A page under `docs/protocol/` starting `<!-- page: Agent protocol \| N \| summary -->`, then `npm run docs:check -- --write` |
| Managed `AGENTS.md` text | The template in `src/repository-setup.ts` or `src/master.ts`; re-render and commit `AGENTS.md` |

Commands, routes and gates run through `src/engine.ts`; GitHub I/O is in `src/github.ts`. `docs/README.md` and `docs/protocol.md` are generated in full by `npm run docs:check -- --write`; never edit them by hand. `graphyard sync` regenerates them on conflict, and the regression guard exempts them when the deployment sets `GRAPHYARD_GENERATED_FILES` to what `scripts/check-docs.mjs --manifest` prints. `tests/hotspots.test.ts` holds each assembler to a size budget; raise one only with a further split.

## Validate a change

```sh
npm ci
npm run build
npm test
```

Tests run disposable Postgres on ports 15438–15448 (`GRAPHYARD_TEST_PORT` moves them); never point them at production and run as non-root. Test behaviour — conflicting claims, stale epochs, replays, stale evidence, producer scope — and keep GitHub calls outside transactions. Never weaken policy to get Graphyard's own PRs through ([repository bootstrap](first-pr.md)).
