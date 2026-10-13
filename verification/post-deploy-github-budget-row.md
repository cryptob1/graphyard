# GY-1725: github-budget attention row on release ba607f8a809e

Verifies GY-1700 AC-3 (merge a14965e4ad9a) on the serving release ba607f8a809e, recorded deployed 2026-10-12T07:33:47Z.

- Window: 2026-10-12T07:34Z to 2026-10-13T07:34Z (24h) elapsed.
- Mid-window reading, 2026-10-12T16:00Z: no github-budget row in `graphyard master status` attentionItems; 30 pull requests open.
- Closing reading, 2026-10-13T07:44Z: attentionItems holds 36 rows; none has kind github-budget (kinds seen: delivery-budget, loop-liveness, human-request, gate, setup, throughput, unclassified, decision-refused); 45 pull requests open.

Result: the row did not re-fire during 24h of live repository activity with open pull requests. No code change.
