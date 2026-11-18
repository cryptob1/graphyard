# GY-3505: correlating the Lumina push token with a source install

Continues `reports/gy-3471-lumina-merge-provenance.md` with the new audit metadata the core
Master relayed on 2026-11-18T07:09:35Z. Investigated 2026-11-18T07:29Z–07:35Z by worker
`graphyard-opencode-2` (epoch 1) on host `vishrog`, against the core install
(`http://127.0.0.1:4311`), using only that worker's own identity. Read-only: no Lumina code,
gate, deployment, credential or token was touched, read or changed, and no person was contacted.

## Result

**The push token is linked to a GitHub CLI OAuth grant for one organization member. It is not
linked to any Graphyard install, host or merge ledger.** No source review or proof decision was
found for `1239175b099c` (candidate `f52351f`) or `e23dda776c12`. Lumina's deployment and handoff
should stay pending on that gap.

## New audit metadata (peer report, not re-read here)

The core Master's message on GY-3505 (2026-11-18T07:09:35Z) relays a peer's query
(`Peer3723328`). This worker did not repeat the query because it holds no organization audit
access. What the peer reported:

- Query bounds: organization audit log, `include=web`, `actor:Abhishek-457`,
  `created>=2026-11-01`. Stopped at 10 pages / 981 records.
- One match: `org_credential_authorization.grant`, `token_id` **6230811737** (the token ID
  reported for the pushes), `application_name` **GitHub CLI**, timestamp `1794492862590`
  (**2026-11-12T14:14:22.590Z**). The row also has `application_id`/`application_type` and
  `oauth_credential_type` fields. The token's contents were not accessed.
- No other matching-token, OAuth, integration or application action in those bounds.

## Correlation

### Direct links (one record names both sides)

1. **Push token → GitHub CLI grant.** The pushes' token ID and the grant's `token_id` are the
   same value, 6230811737 (peer report). So the token behind the pushes is a GitHub CLI OAuth
   token that member Abhishek-457 authorized for the organization at 2026-11-12T14:14:22Z. It is
   not a deploy key, a GitHub App installation token or a fine-grained token.

Nothing else is directly linked. No record read here connects token 6230811737 to a host, a
Graphyard install, an install ID, a daemon record or a merge-ledger row.

### What the source code says a GitHub CLI token means (verified in this repository)

A Graphyard merge writer pushes with a GitHub CLI token only under `--push-auth gh` (GY-3269,
merged `322d249306`, 2026-11-12T22:29:27Z). In that mode the install records `pushAuth: 'gh'`
(`src/install/index.ts:78`, `:956`), and `gh auth token` supplies the credential at each push.
The token is never stored (`src/install/index.ts:641-643`). Every other install mode pushes
with a deploy key or a piped fine-grained token, and neither would show up as a GitHub CLI
grant.

So a GitHub CLI token on Lumina main fits exactly two writers:

- **(a)** a Graphyard install that runs under that member's gh login with `--push-auth gh`; or
- **(b)** any `git push` that used that member's gh credential helper outside a merge writer,
  whether by a person or by a session.

The records read here do not tell (a) from (b).

### Timestamp inference only (not proof)

- The grant (2026-11-12T14:14:22Z) is about 7 hours **before** GY-3269 (`--push-auth gh`)
  existed. Its first commit was 21:20Z and it merged at 22:29Z. So the grant was not made by a
  Graphyard `--push-auth gh` install. It fits a `gh auth login`/refresh against the
  organization's SSO. The token could still have been used by such an install later.
- The pushes (2026-11-18T02:28:46Z and later) come after both the grant and GY-3269. They also
  come about 3.5 days after the last cycle of the only named candidate install, the
  `rexera-remote` daemon record (2026-11-14T20:29Z, reported by Lumina). That record's last
  cycle cannot explain these pushes unless the install was later restarted.
- The merge titles (GY-3, GY-5, GY-2 lineage) still fit a second, young Graphyard board
  (GY-3471). Timing and titles together are consistent with (a). Nothing excludes (b).

## Access limits (exact; nothing here is claimed as authorized)

| Read attempted | Result |
| --- | --- |
| `ls -la /home/vish/.config/gh` (gh's config: hosts and login names) | `Permission denied` (sandbox mask `d--x--x--x`). The gh token is not read either way. |
| `which gh` | not installed in the worker environment |
| `ls -la /home/vish/.config/graphyard/workers /home/vish/.config/graphyard/cryptob1-graphyard` (install records that would show `pushAuth`) | refused by the harness: "Permission to use Bash with command … has been denied" |
| `ssh -o BatchMode=yes -o ConnectTimeout=6 rexera-remote true`, 2026-11-18T07:29Z | `connect to host rexera-remote port 22: Connection timed out` |
| `graphyard audit-merge-admission`, 2026-11-18T07:29:59Z | core install: 1672 merges enumerated, 584 audited, **0** occurrences of `lumina`, `1239175`, `f52351f`, `e23dda7` or `6230811737`. Install discovery: "Configured install list unavailable; only the current connection could be discovered." |
| GitHub organization audit log, repository activity log | no access from this identity. Only the peer's bounded query above. |

`HOME` for this worker is `/tmp/home`, so `~/.config/gh` resolves to an empty, absent directory.

## AC-2: source review/proof decisions — gap remains

No independent review or proof decision for `f52351f`/`1239175b099c` or `e23dda776c12` exists
in any ledger this worker can read. The core ledger did not merge them (audit above, unchanged
since GY-3471). Neither the earlier passing batch on `1239175` nor an empty associated-PR list is
provenance, and neither is used as provenance here.

## What closes it (all read-only, none needs code)

1. **Which install, if any, runs on that gh login with `--push-auth gh`.** Each install records
   this as `pushAuth: "gh"` in its install record and `run.mergeWriter.pushAuth` in
   `master.json`. A reader of the install records on the hosts where Abhishek-457's gh login is
   signed in can find it. That means this host's `/home/vish/.config/graphyard/` (refused to
   this worker), `rexera-remote` once it is reachable, and any Lumina host. Reading
   `pushAuth` means no token is read.
2. **That install's own ledger** for the exact heads: `graphyard audit-merge-admission` and
   `graphyard events` with that install's reader identity, which show whether its merge writer
   recorded review and proof for `f52351f` and `e23dda776c12`. If no install has
   `pushAuth: "gh"` for `InspectHOA/lumina-investor`, the pushes were writer (b). Then no gate
   decision exists, and both heads stay externally merged with unknown gates.
3. Optionally, a wider organization audit query by the same peer: the same `token_id`, with
   `action:git.push` or the repository filter, beyond the 10-page bound. Lumina's GitHub activity
   log for `main` gives the push timestamps to align with any install's merge-writer events.

## Relay to Lumina

A worker identity cannot message a peer ("Only a reporter or the operator messages the Master").
This report is the relay. The core Master forwards it to `lumina-investor` on thread
`45da1d46-c2ca-4df7-93fb-be82f69ec478`. The short version: the push token is a GitHub CLI token
for Abhishek-457, authorized 2026-11-12T14:14Z. No install, host or gate decision is linked to
it. Check for `pushAuth: "gh"` on the installs that member's gh login serves, then read that
install's ledger for `f52351f` and `e23dda776c12`. Until then, keep deployment pending.
