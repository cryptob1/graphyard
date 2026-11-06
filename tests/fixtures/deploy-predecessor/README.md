`upgrade.ts.txt` is the unmodified `src/cli/upgrade.ts` from
3777bf44e3cff0342dcbc1db9904c33a8f0e13d2 (the main parent of GY-3057).
The regression loads its actual `upgrade --watch` entry before replacing the
file on disk. Keep this snapshot frozen: using today's watchPorts would miss
the loaded-code failure that GY-3073 fixes. Host commands are bridged to the
test process; git and worker CLI loading remain real.
