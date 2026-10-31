# Vendored Elephant-Goldfish Model reviewer prompts

`egm-comprehension.md` and `egm-implementation-readiness.md` are vendored verbatim from
[google/elephant-goldfish-model](https://github.com/google/elephant-goldfish-model) (Apache-2.0),
as their front matter records. Graphyard's spec check before dispatch (`src/spec-check.ts`)
interpolates both into one reviewer session's request instead of installing the plugin; see
`src/model/spec-check.ts` for the report the session answers with.
