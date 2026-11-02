# GY-3048 documentation review

Reviewed README and every Markdown file under docs, including protocol. Generated indexes (`docs/README.md` and `docs/protocol.md`) were regenerated, not hand-edited. Counts use Python `len(text.split())`, including code and metadata, against synced base `0d6b141370fa`.

The handwritten set went from **12,196 to 9,384 words (23.1% shorter)**, including the new rendering guide. This report is outside that guide count. These counts include the newer shipped documentation reconciled through epoch 7.

| Reviewed file | Before | After |
| --- | ---: | ---: |
| `README.md` | 277 | 427 |
| `docs/coordination.md` | 534 | 431 |
| `docs/delivery-redesign.md` | 334 | 193 |
| `docs/delivery.md` | 725 | 599 |
| `docs/deployment.md` | 809 | 569 |
| `docs/development.md` | 698 | 605 |
| `docs/glossary.md` | 542 | 510 |
| `docs/how-graphyard-works.md` | 545 | 540 |
| `docs/install.md` | 457 | 369 |
| `docs/master-agent-reference.md` | 551 | 444 |
| `docs/master-agent-sessions.md` | 2019 | 823 |
| `docs/master-agent.md` | 1047 | 833 |
| `docs/onboarding.md` | 641 | 448 |
| `docs/operations.md` | 541 | 494 |
| `docs/protocol/work-commands.md` | 654 | 571 |
| `docs/setup-from-zero.md` | 521 | 398 |
| `docs/validation.md` | 1301 | 814 |
| `docs/walkthrough.md` | 0 | 316 |

Setup-from-zero is the setup checklist; install owns provider/key steps; onboarding owns fleet setup. Delivery owns trial/revert behavior, deployment owns serving, and sessions owns runtime recovery. Other guides link there. Removed issue narration, the old brief word-count table and references to deleted docs tests. Existing section anchors remain.

Checked live source for dispatch, trial acceptance, supervision and serving: master dispatch accepts eligible system-driven items; control-plane acceptance counts trial proofs rather than producer evidence; the watchdog detects incomplete cycles; the deploy service serves main. Epoch 3 synced merged GY-3047 (`1e80c20737cf`) and replaced the temporary pending-candidate text with implemented changed-cause wakes and the bounded heartbeat. No domain behavior or requirement changed.

Validation:

- Epoch 3: npm run build passed.
- Epoch 3: npm run docs:check passed after regeneration.
- Previous attempt only: six related regression files ran 40 cases: 39 passed. The existing unit:executor-trial-runs-criterion-tests case failed outside changed files because this sandbox cannot create `/home/vish/.gy/tmp/gy-*` (EROFS). Retrying the merge-executor file with TMPDIR=/var/tmp hit the same fixed fallback. This is separate from the passing documentation proof.
- Epoch 3: graphyard verify GY-3048 passed integration:documentation-validation; the check fails against base. It exercises the actual renderer and browser controls, populated opening and constant frame dimensions.
- Epoch 3 regenerated both assets from 1201 frames at 10 fps. MP4: H.264, 1200×838, 120.1 seconds. GIF: 800×559, 416 encoded frames, 120.1 seconds. ffprobe inspected both; ffmpeg decoded both fully without errors.
- Epoch 3 visually inspected MP4 frames at 0, 15, 28, 55, 75, 90, 103 and 116 seconds, plus decoded GIF opening and later failure scene. Captions fit, roles remain distinct and the first frame is populated. Local fonts remove rendering's network dependency.

Reproduce with [the rendering guide](../../docs/walkthrough.md).

Self-review: AC-1 met (roles, autonomy, concrete failure and shipped wake behavior); AC-2 met (storyboard, regenerated media, decode and visual inspection); AC-3 met (all handwritten guides reviewed, concise rewrite, counts and working generated indexes/links). No blocking finding remains.

Epoch 4 rework:

- Merged `37c69b2413d2` and resolved all eight conflicts, including the seven named in the trial refusal and the newer delivery-redesign conflict. Preserved shipped reviewer recovery, immediate dispatch, Node selection, retired advisory trials, superseded-intent handling, current-checkout launch and removal of the direct-merge bypass.
- Build, docs checker and `graphyard verify GY-3048` passed after reconciliation; the documentation proof fails against base as expected.
- Fully decoded both unchanged epoch-3 media assets again. Confirmed H.264 MP4 1200×838 and GIF 800×559, both 120.1 seconds. Visually inspected decoded MP4 frames at 0, 28, 90 and 116 seconds, and GIF opening and 90-second frames: populated opening, distinct roles, readable captions and deploy-supervisor recovery.
- Self-review judged AC-1, AC-2 and AC-3 met. Updated the second session-liveness summary to preserve completed-review recovery consistently. No blocking finding remains.


Epoch 7 rework:

- Brought forward epoch 6's saved merge commit `d560fa71c79f`; `graphyard sync GY-3048` now passes against `0d6b141370fa`. All five files named by the failed trial are reconciled: coordination, how-graphyard-works, master-agent, protocol/work-commands and validation. Preserved the shipped E2E requirement, master account recovery, trial mise isolation and isolated pre-submit reruns, including the related master-agent-reference additions.
- Refreshed the file counts above against that synced base. No requirement or runtime behavior changed.
- Build, docs checker and `graphyard verify GY-3048` passed. The documentation proof rendered sample frames and exercised browser controls; its base exercise failed as expected.
- Self-review caught and fixed the remaining video caption limiting product review to user-facing features. Regenerated both media assets from the corrected HTML. Fully decoded both with ffmpeg; ffprobe confirms MP4 H.264 1200×838 and GIF 800×559, both 120.1 seconds. Visually inspected opening, review and later recovery frames for role labels, readable captions and correct deploy-supervisor recovery.
- Ran `review self GY-3048` and judged the diff against the synced base: AC-1 met (roles, failed-check handoff, implemented wakes and three human decisions); AC-2 met (storyboard and regenerated media, rendering, decoding, dimensions and visual checks); AC-3 met (all handwritten guides reviewed, concise task entries, preserved operational rules, refreshed counts and passing links/indexes). No blocking finding remains.
