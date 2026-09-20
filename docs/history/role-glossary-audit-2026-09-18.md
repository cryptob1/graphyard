<!-- page: Maintainer and historical records | 3 | the audit behind the glossary. -->
# Role-glossary audit — September 18, 2026

For a maintainer editing the guides: why the role vocabulary is fixed.

The audit found seven recurring substitutions across the guides — bare *operator* for automation, *the agent* where a role was meant, *session* for a credential, *Herdr owns the work*, *Graphyard runs the agents*, *the tester* or *QA*, and *user* — and resolved each into one canonical term. Those terms are the authoritative rule in [the glossary](../glossary.md#the-eight-distinctions), and `tests/docs-glossary.test.ts` keeps them from drifting.
