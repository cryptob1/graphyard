# Executor Version Skew & Silent Fault Bypass

**Observation:** 
During the pilot initialization, the Graphyard executor had version skew and control-plane configuration bugs. The master loop failed to start correctly, but the system didn't automatically bypass or surface the fault clearly enough to prevent a total pipeline stall.

**Friction Log:**
- The `acceptance-drafting` stage stalled.
- A configuration fault (`GY-1`) blocked the loop, yet the control plane configuration bypassed the fault in a way that wasn't transparent.
- Silent failures masked the root cause, requiring deep `journalctl` debugging to uncover the runner spawn issues.

**Proposed Solution / Next Steps:**
File a GY item to improve how global configuration faults (`GY-1`) interact with the master loop, ensuring that version skew or config faults are surfaced in the UI or board rather than silently stalling all goal progression.
