# GY-3048 documentation review

Reviewed README and every Markdown file under docs, including protocol. Generated indexes (`docs/README.md` and `docs/protocol.md`) were regenerated, not hand-edited. Counts use Python `len(text.split())`, including code and metadata, against synced base `d67724adb3e8`.

The handwritten set went from **14,906 to 12,351 words (17.1% shorter)**, including the new rendering guide. This report is outside that guide count. Counts include shipped documentation through the current base.

| Reviewed file | Before | After |
| --- | ---: | ---: |
| `README.md` | 277 | 427 |
| `docs/coordination.md` | 683 | 600 |
| `docs/delivery-redesign.md` | 519 | 407 |
| `docs/delivery.md` | 820 | 674 |
| `docs/deployment.md` | 886 | 650 |
| `docs/development.md` | 1276 | 1183 |
| `docs/glossary.md` | 542 | 510 |
| `docs/how-graphyard-works.md` | 545 | 540 |
| `docs/install.md` | 469 | 382 |
| `docs/master-agent-reference.md` | 668 | 561 |
| `docs/master-agent-sessions.md` | 3278 | 2191 |
| `docs/master-agent.md` | 1217 | 1027 |
| `docs/onboarding.md` | 641 | 480 |
| `docs/operations.md` | 541 | 494 |
| `docs/protocol/work-commands.md` | 696 | 619 |
| `docs/setup-from-zero.md` | 521 | 398 |
| `docs/validation.md` | 1327 | 838 |
| `docs/walkthrough.md` | 0 | 370 |

Setup-from-zero is the setup checklist; install owns provider/key steps; onboarding owns fleet setup. Delivery owns trial/revert behavior, deployment owns serving, and sessions owns runtime recovery. Other guides link there. Removed issue narration, the old brief word-count table and references to deleted docs tests. Existing section anchors remain.

Checked live source for dispatch, trial acceptance, supervision and serving: master dispatch accepts eligible system-driven items; control-plane acceptance counts trial proofs rather than producer evidence; the watchdog detects incomplete cycles; the deploy service serves main. Epoch 3 synced merged GY-3047 (`1e80c20737cf`) and replaced the temporary pending-candidate text with implemented changed-cause wakes and the bounded heartbeat. No domain behavior or requirement changed.

## Current validation and rework (epoch 112)

Synced main `a8c4b54fb692`, preserving latest clean docs/video candidate `fe33949104ba`. Read its independent REQUEST_CHANGES and current policy revision 3; all three criteria and bound `e2e:create-work-item` remain required. GY-3047 and GY-3068 are delivered. Main now includes GY-3069 recovery-base advance and GY-3068 early-exit diagnosis. Resolved the master-agent conflict with the delivered runtime-start timing and reporter-finished cleanup details. Checked `src/daemon/worker-launch-health.ts`, `src/daemon/cycle.ts` and `src/server/merge-record.ts`: the early-exit and original-flight recovery explanations now match shipped code. No future application changes were imported.

`npm run build`, `npm run docs:check` and `WALKTHROUGH_BROWSERS_PATH=/home/vish/.cache/ms-playwright npm test -- tests/documentation-validation.test.ts` pass on the synced worktree. The focused test renders thirteen frames and checks chapters, scrubbing and playback. No broad host full suite or host `complete` was run. Native ordinary verification and completion recheck, final exact-head independent review, and canonical full/E2E checks remain mandatory; these local checks do not replace them.

Both preserved media assets fully decode with ffmpeg. ffprobe reports H.264 MP4 1200×838 and GIF 800×559, both 120.1 seconds. Visually inspected decoded MP4 frames at 0, 55 and 103 seconds: populated opening, readable captions, independent review and the failed-check handoff. The earlier GIF opening inspection remains applicable because both assets are byte-for-byte unchanged from `fe33949104ba`. Repeatable commands remain in [the rendering guide](../../docs/walkthrough.md).

Self-review: AC-1 preserves implemented master wakes, independent ownership, exactly three human decisions and the concrete failed-check handoff. AC-2 preserves the corrected storyboard, rendered media and repeatable rendering. AC-3 preserves operational details and working links while shortening the handwritten guides; the two blocking live-source inconsistencies are resolved by delivered main. No requirements or gates changed.


## Peer-integration preparation (epoch 113)

Preserved submitted `806913fb547e23d2c4bfcd88595b083a3a3e8767` and synced delivered main `d67724adb3e8021e6c5d59faee0c8d8a1de6fb13`. Resolved the two actual shared-guide conflicts, retaining GY-3070's positive executed-proof counts before push and GY-3060's streamed native history, retained records, live wake retries and absent-master fallback. These descriptions match the delivered source, without importing pending runtime changes.

Merged exact approved header commit `8cddc260a3e637983d23b667923d210143b2c974` with its ancestry and authorship intact. Resolved only the shared onboarding prose; its `web/` and header E2E files are byte-for-byte unchanged. Regenerated indexes with `node scripts/check-docs.mjs --write`.

Preparation checks pass: `npm run build`, `npm run docs:check` and `WALKTHROUGH_BROWSERS_PATH=/home/vish/.cache/ms-playwright npm test -- tests/documentation-validation.test.ts` (one passing integration test, thirteen rendered frames). Self-review finds AC-1, AC-2 and AC-3 met for the prepared head; no blocking findings. The original storyboard/media remain unchanged. No ordinary verification or completion ran. Hold this head and lease until GY-3059 is Done, then sync actual delivered main, reconcile its runtime environment/readiness documentation, refresh counts and repeat the final checks/self-review. Native ordinary verification, mandatory native completion recheck, independent exact-head review and canonical full/E2E gates remain required for submission.
