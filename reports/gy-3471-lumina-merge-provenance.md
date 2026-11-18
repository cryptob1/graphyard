# GY-3471: provenance of the external merges on Lumina main

Investigated 2026-11-18T05:46Z–05:55Z by worker `graphyard-codex-1` (epoch 2) from the
core install (`http://127.0.0.1:4311`, release `afd7ce72a132`), using only that worker's own
identity. No Lumina code, ownership, deployment or gate was touched, and no other identity's
credential was read.

## Result

**The source install, its coordinator and the authorized principal are not identified, and no
source merge-ledger review or proof decision was located**, for any of:

| Commit | What it is |
| --- | --- |
| `1239175b099cf2c06ff7bdce260dae8467677047` | merge on Lumina main, 2026-11-18T02:28:46Z, parents `3e375f7` / `f52351f`, title "Merge GY-3 …" |
| `f52351ff59f93077e40979e4f8680a3242eaac71` | its candidate, authored "Lumina Graphyard Worker" |
| `e23dda776c12` | later external main, "Merge GY-5: Add MIME-sniffing protection to diagnostic endpoints" |

Nothing here supports calling the merges authorized, and nothing supports calling them
unauthorized. Lumina's deployment decision should stay pending on the blocker below.

## Verified (read by this worker, reproducible)

1. **The core install's merge ledger holds no decision for these commits.**
   `graphyard audit-merge-admission` enumerated 1665 merges and audited 577 on
   `http://127.0.0.1:4311`; none of `1239175`, `f52351f`, `e23dda7`, `3e375f7`, `4281a517`
   or the word "lumina" appears in its output. The core install did not merge them.
2. **The only core-ledger rows naming the commits are reports about them**, not merge, review,
   proof or evidence rows: GY-3471's own events (seq 3711674 create, 3717603 and 3718223
   messages, 3718213 priority) and the peer messages from reporter `lumina-investor`:
   - seq 3717596, 2026-11-18T05:17:53Z, thread `542f1273-e0b9-4bc6-911f-5817beca8536`:
     batch `1239175` verified 05:11:18; external main `e23dda776c12` validating since 05:11:38;
     "deployment remains pending provenance".
   - seq 3717655, 05:19:18Z, same thread: GY-30 trial conflicted against main `e23dda776c12`.
   - seq 3718189, 05:30:27Z, thread `45da1d46-c2ca-4df7-93fb-be82f69ec478`: provenance of
     `1239175`/`e23dda` is a final-deployment and handoff dependency.
3. **No other install's ledger is readable with this identity.** The audit's install discovery
   reported 0 installs ("Configured install list unavailable; only the current connection could
   be discovered"), and this worker holds a credential for the core control plane only. Two
   other control planes answer `/healthz` on this host (`127.0.0.1:4312` and `:4314`, both
   release `afd9d3e0fe2a`); `/healthz` names no repository, and their ledgers were not read.
4. **The legacy host is unreachable.** `ssh -o BatchMode=yes -o ConnectTimeout=8 rexera-remote`
   (`100.126.3.11`, `rexera-remote.tail3739e3.ts.net`) at 2026-11-18T05:47Z:
   `connect to host rexera-remote port 22: Connection timed out`. Same result the peer recorded.
5. **The repository itself is not readable here.** The three commits are absent from the core
   object store; `git ls-remote https://github.com/InspectHOA/lumina-investor.git` without a
   credential is refused (`could not read Username`); `gh` is not installed in the worker
   environment. So the commit, its committer and GitHub's push record were not seen by this
   worker.
6. `/home/vish/.config/graphyard/masters/` (the historical daemon record cited in the item)
   is not visible from the worker environment; that record was not re-read.

## Reported by Lumina, not re-verified here

The merge time, parents, author name, the "fetched externally at 02:32:08Z" observation, the
GY-2 lineage (`4281a517`), that launcher transcript `841acad3` has no matching merge, and that
`bb8c4c2b5183514151bb.daemon.json` names `InspectHOA/lumina-investor`, `127.0.0.1:4312`,
`rexera-remote`, last cycle 2026-11-14T20:29Z.

## Inference only — not proof

- The merge titles use item keys GY-3 and GY-5 with a GY-2 lineage, while the Lumina board on
  this host is at GY-27..GY-31 and its GY-3 is other work. That pattern fits a **second
  Graphyard install with its own young board and its own write credential for the same
  repository**. The rexera-remote daemon record is the only named candidate, and it is four
  days stale and unreachable.
- The author name "Lumina Graphyard Worker" and a passing batch on `1239175` say nothing about
  who was authorized to push. The candidate commit's own claim of local validation is not an
  independent review or proof decision.

## Evidence gap (AC-2)

No independent review or proof decision for candidate `f52351f` (or for `e23dda776c12`) exists
in any record this worker can read. Whether one exists at all is unknown until the source
ledger is found.

## Blocker, and what closes it

Source records are unreachable from an agent identity on the core install. Either of these
closes it, and neither needs new code:

1. **GitHub's push record for `InspectHOA/lumina-investor`**, read with Lumina's own repository
   access: the repository activity log for `main` names the actor and the deploy key or token
   behind the pushes of `1239175b099c` and `e23dda776c12`; the repository's deploy-key and
   token list then shows which install holds that writer. This is the shortest route and
   Lumina's master can take it without anything from the core install.
2. **The source install's own ledger**, once `rexera-remote` (or whichever host the push record
   names) is reachable: its `audit-merge-admission` and `events` for those heads, read with
   that install's own reader identity.

Until one of these is read, Lumina should keep treating both heads as externally merged with
unknown gates.

## Reporting

A worker identity cannot message the Master or a peer (`graphyard message`: "Only a reporter or
the operator messages the Master"), so this record is the worker's report; the core Master
relays it to `lumina-investor` (`master send`, thread `45da1d46-c2ca-4df7-93fb-be82f69ec478`).
