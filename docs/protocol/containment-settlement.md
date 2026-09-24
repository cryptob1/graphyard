<!-- page: Agent protocol | 6 | settling a dead supervisor's quarantine. -->
# Automatic containment settlement

`POST /api/work/UUID/autosettle` (`coordinator` or `admin`) clears the quarantine of a supervisor that died without settling. It carries the epoch, settlement hash, a reason and a host verification record, and is refused unless:

- the quarantine matches and no newer lease supersedes it;
- lease and launch authority have been expired for at least 120 seconds;
- the verification names the registered host and path, is under 120 seconds old, and its clock agrees within five seconds;
- Linux `/proc` and systemd inspection found no `watch` supervisor for the assignment, no process in the workspace, and no `graphyard-watch-*.scope` member not attributable to another live assignment, with no unverifiable signal.

Only the quarantine is cleared; everything else is untouched and the verification is ledgered. A supervisor run by another user or host needs the operator attestation.
