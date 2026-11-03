# GY-3048 documentation review

Reviewed README and every Markdown file under docs, including protocol. Generated indexes (`docs/README.md` and `docs/protocol.md`) were regenerated, not hand-edited. Counts use Python `len(text.split())`, including code and metadata, against synced base `73ca5f5cb1aa`.

The handwritten set went from **13,930 to 11,310 words (18.8% shorter)**, including the new rendering guide. This report is outside that guide count. Counts include shipped documentation through the current base.

| Reviewed file | Before | After |
| --- | ---: | ---: |
| `README.md` | 277 | 427 |
| `docs/coordination.md` | 683 | 600 |
| `docs/delivery-redesign.md` | 334 | 193 |
| `docs/delivery.md` | 820 | 674 |
| `docs/deployment.md` | 886 | 650 |
| `docs/development.md` | 775 | 682 |
| `docs/glossary.md` | 542 | 510 |
| `docs/how-graphyard-works.md` | 545 | 540 |
| `docs/install.md` | 469 | 382 |
| `docs/master-agent-reference.md` | 668 | 561 |
| `docs/master-agent-sessions.md` | 3102 | 2017 |
| `docs/master-agent.md` | 1103 | 907 |
| `docs/onboarding.md` | 641 | 448 |
| `docs/operations.md` | 541 | 494 |
| `docs/protocol/work-commands.md` | 696 | 619 |
| `docs/setup-from-zero.md` | 521 | 398 |
| `docs/validation.md` | 1327 | 838 |
| `docs/walkthrough.md` | 0 | 370 |

Setup-from-zero is the setup checklist; install owns provider/key steps; onboarding owns fleet setup. Delivery owns trial/revert behavior, deployment owns serving, and sessions owns runtime recovery. Other guides link there. Removed issue narration, the old brief word-count table and references to deleted docs tests. Existing section anchors remain.

Checked live source for dispatch, trial acceptance, supervision and serving: master dispatch accepts eligible system-driven items; control-plane acceptance counts trial proofs rather than producer evidence; the watchdog detects incomplete cycles; the deploy service serves main. Epoch 3 synced merged GY-3047 (`1e80c20737cf`) and replaced the temporary pending-candidate text with implemented changed-cause wakes and the bounded heartbeat. No domain behavior or requirement changed.

## Current validation and rework (epoch 88)

The saved epoch-18 commit `4065cdef87db` is already an ancestor of this branch. Sync confirms base `73ca5f5cb1aa`. The inherited changes preserve shipped filesystem isolation, reviewer credentials and continuing master conversations. Earlier rework restored the reviewer's four-session default and selected the trial image's bundled Chromium before importing Playwright.

This round makes the existing-cache export explicit in the rendering guide. Verification initially failed without that cache; with `WALKTHROUGH_BROWSERS_PATH=/home/vish/.cache/ms-playwright`, the documentation proof passes and its base exercise fails as expected. It renders thirteen frames and checks chapters, scrubbing and playback. No dependency install, runtime change or gate waiver was needed.

Reran every file named in the trial refusal with `npm test --` followed by these paths (all under `tests/`):

| Test file | Result |
| --- | --- |
| `action-claim-observation.test.ts` | Pass |
| `slow-tick-repeat-receipt.test.ts` | Pass, including twenty consecutive executions |
| `action-claim-order.test.ts` | Pass |
| `backup-restore.test.ts` | Pass |
| `snapshot-bounded-reads.test.ts` | Pass |
| `action-queue.test.ts` | Pass |
| `action-totality.test.ts` | Pass |
| `bootstrap-policy.test.ts` | Pass |
| `close-work.test.ts` | Pass |
| `lease-pool.test.ts` | Pass |
| `master-defer-sets-observation-window.test.ts` | Pass |
| `session-liveness-model.test.ts` | Pass |
| `submit-head.test.ts` | Fixture Git push fails: Invalid cross-device link |
| `unblock-stale-revision.test.ts` | All five cases pass |
| `worker-filesystem-isolation-e2e.test.ts` | Confined session host ends before command runs |
| `agent-registry.test.ts` | Pass |
| `candidate-history-still-loads.test.ts` | Pass |
| `serve-revert.test.ts` | Fixture Git push fails: Invalid cross-device link |
| `capacity-hold-respects-machine-bounds.test.ts` | Pass |
| `expired-worker-partial-work-handoff.test.ts` | Pass |

The run executed 111 cases: 87 passed, 24 failed, none skipped. The failures are confined to three unchanged test files: Git cannot migrate temporary fixture objects in submit-head and serve-revert (also reproduced running serve-revert alone); the nested filesystem-isolation session exits before its test command. These sandbox failures are recorded in the commit message. CI retains the full-suite gate.

`npm run build` and `npm run docs:check` pass. Both committed assets fully decode with ffmpeg. ffprobe confirms H.264 MP4 1200×838 and GIF 800×559, both 120.1 seconds. Inspected MP4 at 0, 55, 100 and 116 seconds and the GIF opening: readable captions, distinct roles, populated opening, independent review and exactly three human decisions. The prior regenerated media remains valid; this round changes setup instructions and this report only.

Reproduce with [the rendering guide](../../docs/walkthrough.md).

Self-review after `review self GY-3048`: AC-1 met (roles, independent ownership, concrete failed-check handoff, shipped master wakes and three human decisions); AC-2 met (corrected storyboard and regenerated assets retained, readable samples, decoding and repeatable rendering); AC-3 met (all handwritten guides reviewed, operational details preserved, counts refreshed and generated links valid). No blocking finding remains.
