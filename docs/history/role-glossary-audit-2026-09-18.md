<!-- page: Maintainer and historical records | 3 | the audit behind the glossary. -->
# Role-glossary audit — September 18, 2026

For a maintainer editing the guides: why the role vocabulary is fixed.

The September 2026 audit read every guide for role ambiguity and found seven recurring substitutions: bare *operator* for automation, *the agent* where a role was meant, *session* where a credential was meant, *Herdr owns the work*, *Graphyard runs the agents*, *the tester* or *QA*, and *user*. Each was resolved into one canonical term, and those terms are now the authoritative rule in the canonical usages in [the glossary](../glossary.md#the-eight-distinctions); `tests/docs-glossary.test.ts` keeps the eight distinctions, their canonical usages and the roles table from drifting.
