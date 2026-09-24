<!-- page: Agent protocol | 6 | how a coordinator proves a dead supervisor and settles its quarantine. -->
# Automatic containment settlement

A supervisor that dies without settling leaves a quarantine only an operator attestation or this proof can clear.

`POST /api/work/UUID/autosettle` (`coordinator` or `admin`) carries the quarantine's epoch and settlement hash, a reason, and a host verification record. The server refuses unless:

- the quarantine exists at exactly that epoch and hash, and no other epoch's lease supersedes it;
- the lease and launch authority have each been expired for at least 120 seconds;
- the verification names the registered host and path, was observed within 120 seconds, and its clock agrees within five seconds;
- it reports Linux `/proc` and systemd scope inspection with no surviving process, no scope holding the workspace's processes, and no unverifiable signal.

The host reads `/proc` for the `watch KEY EPOCH` supervisor and for processes whose cwd is in the workspace, then lists `graphyard-watch-*.scope` units. A scope member fences settlement unless its ancestry leads to a supervisor for a *different* assignment. Unreadable command lines, an unreachable user manager or a non-Linux host are unverifiable and refuse.

Settlement clears only the quarantine; lease, gates, candidate, evidence and delivery are untouched, and the verification is appended to the ledger. A supervisor run by another user or host needs the operator attestation.
