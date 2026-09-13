# Working on Graphyard

Keep the control plane independent of agent runtimes. Herdr is the first integration, not the source of ownership truth.

The initial MVP is a single-agent bootstrap under the operator's supervision. Do not launch other agents for bootstrap work. Once Graphyard's own repository is connected and its gates are active, claim subsequent implementation work in Graphyard and use its assigned worktree.

Domain mutations must be transactional, append history, and enforce principal identity and lease epochs. Never add a client-controlled arbitrary lifecycle-state endpoint. Do not grant implementation workers trusted evidence-producer credentials. Never weaken a task's requirements to make its implementation pass.

Run `npm run build` and `npm test` for domain/API changes. Tests run a temporary real Postgres database; do not substitute production data. Update the relevant guide under `docs/` when behavior changes. Keep external I/O outside coordination transactions.

No secrets belong in Git. `.graphyard/credentials.json` and `.env` are local-only. Deployment changes use the Dockerfile and `.railway/railway.ts`; preview infrastructure changes before applying.
