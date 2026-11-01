<!-- page: Understand or contribute | 1 | change code and validate -->
# Development and dogfooding

## Where a new feature goes

| Concern | Source |
| --- | --- |
| CLI | `src/cli/` |
| HTTP routes | `src/server/routes/` |
| Domain rules | `src/model/` |
| Persistence | `src/store/tables/` |
| Dashboard | `web/pages/` |
| Generated AGENTS.md block | `src/repository-setup.ts` |
| Protocol guides | `docs/protocol/` |

Claim work and use its assigned worktree before editing ([AGENTS.md](../AGENTS.md)).

## Validate a change

```sh
npm run build
node "$GRAPHYARD_CLI" verify GY-N
```

Install dependencies with `npm ci` only when needed; assigned worktrees may share the exact lockfile's install. Domain/API changes also require `npm test`. CI owns the full-suite gate; own-criterion failures always block. Tests use a temporary real Postgres database and `temporaryDirectory(label[, parent])` from `tests/helpers/temp-dirs.ts`. Worker hosts need [bubblewrap](install.md#preconditions).

### Verification maps

`verification/AREA.md` maps source globs in `Paths:` to `## Tests`, `## Drive`, `## Invariants` and `## Gotchas`. Keep each map at most 250 words. Read the relevant map before changing its area.

### Base failures

When a trial's failure also occurs on base, the writer holds the head on one attention entry naming the test; it does not request head rework. It retries the current tip after 30 minutes. The master diagnoses and advances a repair.

### Golden eval

`eval/golden/` has ten fixed items with criteria/proofs and scaffold archives under 1 MB, covering delivery and recovery cases.

Run before and after dispatch, brief, session or merge-trial changes. This consumes fleet time and is outside `npm test`:

```sh
node --import tsx scripts/eval-golden.ts --release SHA --runs 2 --repo OWNER/SCRATCH-REPO --port 4390
node --import tsx scripts/eval-golden.ts --compare eval/results/OLD.json eval/results/NEW.json
```

Use the release's checkout, one release at a time. Each run creates/removes a scratch Compose install with its own port and Herdr; start its loop. It waits `--bound-minutes` (90) per item. `eval/results/SHA.json` records outcomes, attempts, rework and claim-to-Done time; comparison names changed rows before totals.

## Documentation

Edit handwritten guides and their `<!-- page: Section | order | summary -->` metadata. `npm run docs:check -- --write` generates `docs/README.md` and `docs/protocol.md`; `npm run docs:check` validates relative links and anchors. The [generated-file policy](coordination.md#generated-files) keeps sync from hand-merging indexes.

Diagram specs live in `scripts/render-docs-diagrams.mjs`. The opening video has a separate HTML source and renderer under `scripts/walkthrough/`; [rendering instructions](walkthrough.md) cover both committed media assets.
