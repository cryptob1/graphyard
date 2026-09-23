<!-- page: Operate Graphyard | 5 | accounts, capacity. -->
# Agent fleet: accounts and capacity

For the master adding capacity: which account a session runs on, and why one cannot start.

## The agent registry

The fleet is control-plane state, not a file: **runtimes** (an agent CLI and its launch contract), **accounts** (one login of a runtime, held by reference — host and login home, never the credential), the **model** each account runs, and the **roles** `worker`, `reviewer`, `producer`, `approver` and `escalation-handler`, each naming eligible accounts in preference order with a concurrency limit. Admin or coordinator configures it from the CLI, `GET|POST /api/agent-registry` or the dashboard's Agent fleet page ([onboarding](onboarding.md#configure-the-fleet)); logging an account in, or buying one, is the only human part.

| `master registry …` | Meaning |
| --- | --- |
| *(none)*, `history [--limit N]` | Every account and its state; every change and selection |
| `propose [--directory DIR] [--apply]` | Store what this host's logins imply; a rerun proposes only what is new |
| `runtime set NAME\|@FILE` | `--kind`, `--arg=A`, `--home-variable VAR`, `--model-flag=FLAG`, `--login COMMAND`, `--login-file PATH` (present means logged in), `--env K=V`, `--description TEXT` |
| `model set NAME\|@FILE` | `--provider P`, `--id ID`, `--input-cost USD`, `--output-cost USD`, `--tier frontier\|strong\|fast`, `--context TOKENS`, `--notes TEXT` |
| `account set NAME\|@FILE` | One login, *placed* on the host holding it: `--runtime R`, `--model M`, `--home PATH`, `--host HOST`, `--max-sessions N`, `--disable`, `--enable`, `--note TEXT` |
| `account quota NAME exhausted\|available\|unknown [--resets-at ISO]` | A hand mark, holding against the probe until its reset or until cleared |
| `role set ROLE ACCOUNT[,ACCOUNT…] [--concurrency N]` | The accounts a role may use, most preferred first |
| `runtime\|model\|account\|role remove NAME` | Removing a runtime removes its accounts; roles fall back in order |
| `session end ID` | End one live session the registry counts — the only end it cannot infer |

Every command takes `--reason R`, a `set` names only what changes, and a contract carrying a secret is refused; spelled in full, the commands are `master registry propose`, `master registry runtime set`, `master registry model set`, `master registry account set`, `master registry account quota`, `master registry role set`, `master registry session end` and `master registry history`. Routes: `POST /api/agent-registry/(runtimes|models|accounts|roles|apply|select)[/ID/(remove|quota)]` and `POST /api/agent-registry/sessions/[0-9a-f-]{36}/end`; reads `GET /api/agent-registry`, `GET /api/agent-registry/document` and `GET /api/agent-registry/history` (`limit`, default `?limit=100`).

**Selection** happens inside the coordination transaction, so limits hold across every executor host: the first account of the role, in its order, that is enabled, placed on the asking executor's host, logged in, within quota and under its session limit, with the role under its concurrency limit — recorded as `agent-registry.selected` with its reason and every account passed over. Nothing is cached between actions, so a change holds from the next action of a running `master run`; a role the registry does not define launches from the profile's own `accounts` (`fleet.next`), and an unreachable control plane launches that role not at all. `master status` reports it under `fleet`, with `ineligible` per account and one attention item per blocked or unconfigured role.

## Agent environments

A principal is who claims, reviews or proves; an *agent environment* is whose provider subscription a session spends ([onboarding](onboarding.md#agent-environments)). Each launch profile lists its environments in `accounts`, in failover order; `master environments [--create KINDS] [--directory DIR] [--apply]` discovers, creates and profiles them.

### Exhaustion in the middle of a session

An account that runs out *while its session works* stops it on the provider's limit notice; the loop fails it over within two minutes. It reads the last 40 lines of the terminal (`herdr agent read`) of every launched worker, reviewer or producer session Herdr reports `idle`, `done` or `blocked`, and a notice must *lead* a short line behind at most a two-word label, so prose about usage limits is not one and a session still `working` is never judged on what it prints; a notice naming no reset records an unknown one rather than a guess. A worker's uncommitted changes are committed on the attempt's own branch as `WIP: GY-N attempt E interrupted by provider quota exhaustion` (`git add -A`, unpushed, never stashed) and named in the next attempt's prompt, or the worktree is reset and the record says `discarded`. The account is held (`*.environments.json`, `exhausted`) until the reset the notice named, one hour when it named none, a profile with no `accounts` under `profile:NAME`. `POST /api/work/GY-N/capacity` (coordinator) writes `capacity.exhausted` onto `capacity.exhaustions` — role, profile, account, runtime, notice, reset, how the work was kept — and for a worker the same transaction ends the attempt as `released`, so no `lease-loss` is raised; the loop then stops the watch supervisor through the containment scope it recorded, and the item is claimable once that quarantine settles, while a reviewer or producer session is ended `failed` and its request relaunched at once with the exhausted profile last. Each failover is one `failover` action in `daemon.actions`, `work[].capacity` carries the exhaustions, and the kept work is at `partialWork.commit`, on `partialWork.branch` in `partialWork.path`; a session exiting *at launch* on the same notice is classified from [its pane](executors.md#the-dispatchers-own-state).

### When a role has no account left

Every account of a role being spent is capacity, not a launch failure — a logged-out account or an unreadable credential is fixed in one command — so only a profile every one of whose accounts was passed over as *spent* is out of capacity. Each waiting item records one **capacity escalation** (`capacity.escalations[]` with each account, its profile, its reset and the reason, plus `retryAt`; a `capacity.escalated` entry per distinct set, never per cycle) which blocks nothing and nobody clears. The loop stops launching that role — no failed dispatches, no cool-offs, no `No worker profile can take GY-N` escalations, no failure limit counting it — and waits a minute until its accounts are due to be read, while nothing needing another role is delayed. `master status` says it in one `capacity` line and attention item: `worker capacity is exhausted on every configured account (claude-a resets …, zai resets …); worker launches are paused until …, and nothing else is delayed; waiting: GY-7, GY-9`. The cycle an account reports quota again the loop withdraws it (`capacity.restored`) and dispatches what waited; buying quota stays the human's decision.

### Per-role concurrency

A reviewer or producer profile carries `concurrency` (1–20; absent means 1): how many sessions it runs at once, declared per role — reviewer profiles bound the review lane, producer profiles the proof lane. A profile running one session keeps its fixed `agentName`; one running more names each session for its request (`<agentName>-<first 8 hex of the request id>`, the attempt appended after the first, inside Herdr's 32-character limit). The dispatcher counts running sessions from Herdr's inventory each tick and launches on the first profile with a slot; a request no profile has room for waits, and the tick names the limit (`every reviewer profile is busy: claude-reviewer: at its concurrency limit (3 running, limit 3)`). The limit is read before each tick, so raising it starts more sessions without a restart and lowering it stops none, and a producer profile whose principal held an assignment on the item is skipped for it however many slots it has. `master status` reports `concurrency` per role — `running` against `limit`, each profile under `profiles`, `waiting`, `longestWaitMs` with that request under `longest`, and `starved` — raising `reviewer concurrency` or `producer concurrency` in `attentionItems` after ten minutes starved and counting it in `counts.concurrencyStarved`. Sizing: [onboarding](onboarding.md#size-review-and-proof-capacity).

## Session checkouts

Proof and review checkouts are created under the [managed worktree root](deployment.md#agent-hosts-the-managed-worktree-root), never the system temporary directory; the path check that guards a credential refuses one inside the repository, an assignment worktree or another checkout.

