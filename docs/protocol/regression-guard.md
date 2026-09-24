<!-- page: Agent protocol | 8 | how submit classifies every changed file against `plannedFiles` and refuses out-of-scope regressions. -->
# Submit-time regression guard

Before recording `submit`, the control plane observes the PR and compares every changed file outside `plannedFiles` by blob with the bound base (the branch tip, or a speculative tip's predicted base). A revert, deletion or rewrite refuses with `409`: `Submission refused for GY-N: Candidate changes K files outside its planned files ...; Out-of-scope regression: PATH: DETAIL (shipped by GY-A, GY-B)`. A refusal writes nothing, so the same idempotency key may be retried after the fix. The head branch must be the registered workspace branch.

Each observation carries `scopeFiles` (`path`, `status`, `previousPath`, `sha`, `additions`, `deletions`, `binary`, `baseSha`), and the `build` gate re-derives the refusal on every new head.

Paths in `GRAPHYARD_GENERATED_FILES` are classified `generated` and refused only when deleted; see [generated files](../coordination.md#generated-files-never-conflict).

`graphyard sync GY-N` is the worker-side check: it merges `origin/BASE` (never rebases), prints the same classification as JSON, and exits non-zero when a file outside `plannedFiles` differs from the base. Only the audited `requirements` command changes `plannedFiles`.
