# GY-3048 documentation review

Reviewed README and every Markdown file under docs, including protocol. Generated indexes (`docs/README.md` and `docs/protocol.md`) were regenerated, not hand-edited. Counts use Python `len(text.split())`, including code and metadata, against synced base `718331036f27`.

The handwritten set went from **12,294 to 9,684 words (21.2% shorter)**, including the new rendering guide. This report is outside that guide count. These counts include the newer shipped documentation reconciled through epoch 9.

| Reviewed file | Before | After |
| --- | ---: | ---: |
| `README.md` | 277 | 427 |
| `docs/coordination.md` | 579 | 508 |
| `docs/delivery-redesign.md` | 334 | 193 |
| `docs/delivery.md` | 725 | 599 |
| `docs/deployment.md` | 809 | 569 |
| `docs/development.md` | 698 | 605 |
| `docs/glossary.md` | 542 | 510 |
| `docs/how-graphyard-works.md` | 545 | 540 |
| `docs/install.md` | 457 | 369 |
| `docs/master-agent-reference.md` | 551 | 444 |
| `docs/master-agent-sessions.md` | 2016 | 996 |
| `docs/master-agent.md` | 1103 | 883 |
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


Epoch 8 rework:

- Confirmed saved epoch-6 commit `d560fa71c79f` is already an ancestor of this branch. Synced `f94e14e4b663` in merge commit `9e9df60530f0`. Resolved coordination and master-agent conflicts; master-agent-sessions merged cleanly. All three files named in the failed trial are reconciled. Preserved GY-3016's advisory nits and GY-3053's queued capacity waits, retries without a lease or cooldown, and wakes for real failures.
- Refreshed the counts above against the synced base. Build, docs checker and `graphyard verify GY-3048` passed; the documentation proof rendered frames and exercised browser controls, and failed against base as expected.
- Fully decoded both committed media assets without errors. ffprobe confirms MP4 H.264 1200×838 and GIF 800×559, both 120.1 seconds. Inspected decoded MP4 frames at 0, 55, 100 and 116 seconds and GIF frames at 0 and 100 seconds: readable captions, distinct roles, populated opening, failed-check handoff and exactly three human decisions.
- Ran `review self GY-3048` and reviewed the diff against the synced base. AC-1 met: roles, ownership, failed-check example, shipped wakes and autonomy are explicit. AC-2 met: corrected storyboard and regenerated assets remain intact, rendering and decoding pass, sample frames are readable, and rendering commands are documented. AC-3 met: all handwritten guides remain reviewed, operational rules and links are preserved, and counts match the current base. No blocking finding remains.


Epoch 9 rework:

- Confirmed saved epoch-6 merge `d560fa71c79f` is already in this branch. Synced `718331036f27` in merge `ab258fc324c6`. Coordination and master-agent-sessions conflicts are resolved; delivery is already reconciled. Preserved restart-safe reviewer/spec-check tokens and the continuing master conversation, including failover transcripts and unanswered inputs.
- Build and `graphyard verify GY-3048` passed; the documentation proof checks generated guides/links, renders frames and exercises playback controls, and fails against base as expected. Refreshed counts above against the synced base.
- Both committed media assets fully decode without errors: MP4 H.264 1200×838 and GIF 800×559, each 120.1 seconds. Visually checked decoded MP4 frames at 0, 55, 100 and 116 seconds: populated opening, distinct roles, readable captions, failed-check handoff and exactly three human decisions. Rendering commands remain in the walkthrough guide.
- Ran `review self GY-3048` and judged the synced diff. AC-1 met: roles, control-plane ownership, failure example, shipped wake behavior and autonomy remain explicit. AC-2 met: corrected storyboard and regenerated media remain intact, with passing rendering/decoding and readable samples. AC-3 met: handwritten guides reviewed, shipped operational details retained, counts refreshed and generated links checked. No blocking finding remains.
