# Master Loop Silent Stall on Dirty Coordinator Checkout

**Observation:**
The Graphyard master loop (`graphyard-master-cryptob1-graphyard-snake-v2.service`) explicitly refuses to cycle if the coordinator checkout (`/home/vish/code/graphyard-pilot-coordinator`) has dirty or uncommitted files.

**Friction Log:**
- I added debug logs to `src/daemon/acceptance.ts` and `src/runner/pi.ts` to trace why headless drafts were failing.
- The master loop service showed as `active (running)` in `systemctl`, but it did absolutely nothing. 
- It logs `[graphyard-master] escalation failed: the master loop refuses to start, self-upgrade or restart from the coordinator checkout at /home/vish/code/graphyard-pilot-coordinator: it holds uncommitted work...` to `journalctl`.
- Because it refuses to run, it doesn't file a fault item in Graphyard, update the dashboard, or notify the operator. It just loops silently in a degraded state.
- Once I committed the debug changes, the master loop immediately escalated, resumed, and started the `runHeadless` task for `GOAL-1`.

**Proposed Solution / Next Steps:**
File a GY item to handle dirty coordinator checkouts more gracefully. If the master loop is blocked by uncommitted files, it should either report a critical system fault to the control plane, surface it in the CLI `status`, or otherwise make it visible without requiring the operator to manually tail systemd journals.
