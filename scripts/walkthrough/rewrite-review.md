# GY-3048 documentation review

Reviewed README and every Markdown file under docs, including protocol. Generated indexes (`docs/README.md` and `docs/protocol.md`) were regenerated, not hand-edited. Counts use Python `len(text.split())`, including code and metadata, against synced base `5a433ec91f7b`.

The handwritten set went from **14,515 to 12,053 words (17.0% shorter)**, including the new rendering guide. This report is outside that guide count. Counts include shipped documentation through the current base.

| Reviewed file | Before | After |
| --- | ---: | ---: |
| `README.md` | 277 | 427 |
| `docs/coordination.md` | 683 | 600 |
| `docs/delivery-redesign.md` | 418 | 336 |
| `docs/delivery.md` | 820 | 674 |
| `docs/deployment.md` | 886 | 650 |
| `docs/development.md` | 1276 | 1183 |
| `docs/glossary.md` | 542 | 510 |
| `docs/how-graphyard-works.md` | 545 | 540 |
| `docs/install.md` | 469 | 382 |
| `docs/master-agent-reference.md` | 668 | 561 |
| `docs/master-agent-sessions.md` | 3102 | 2017 |
| `docs/master-agent.md` | 1103 | 1006 |
| `docs/onboarding.md` | 641 | 448 |
| `docs/operations.md` | 541 | 494 |
| `docs/protocol/work-commands.md` | 696 | 619 |
| `docs/setup-from-zero.md` | 521 | 398 |
| `docs/validation.md` | 1327 | 838 |
| `docs/walkthrough.md` | 0 | 370 |

Setup-from-zero is the setup checklist; install owns provider/key steps; onboarding owns fleet setup. Delivery owns trial/revert behavior, deployment owns serving, and sessions owns runtime recovery. Other guides link there. Removed issue narration, the old brief word-count table and references to deleted docs tests. Existing section anchors remain.

Checked live source for dispatch, trial acceptance, supervision and serving: master dispatch accepts eligible system-driven items; control-plane acceptance counts trial proofs rather than producer evidence; the watchdog detects incomplete cycles; the deploy service serves main. Epoch 3 synced merged GY-3047 (`1e80c20737cf`) and replaced the temporary pending-candidate text with implemented changed-cause wakes and the bounded heartbeat. No domain behavior or requirement changed.

## Current validation and rework (epoch 111)

Synced actual main `5a433ec91f7b` and resolved the delivery-redesign conflict. Preserved docs/video candidate `65e2dcf13825` and epoch-18 commit `4065cdef87db` remain ancestors. Recovery retains original intent/trial bindings, records successful recovery without another trial or push, and holds confirmed rejections while unrelated candidates advance.

Read pending native-tested follow-ups `5975ebc49da0` (delivery-redesign) and `77679d8f58ad` (master-agent). Retained their two changed paragraphs verbatim so upcoming merges do not conflict; imported no application code from either. Read-only `git merge-tree --write-tree` succeeds against each pending commit. The rest of the guides remain concise. These explanations ship with those runtime fixes after their review/gates pass. All canonical tests, independent review and merge gates remain required.

Both committed media assets fully decode with ffmpeg. ffprobe reports H.264 MP4 1200×838 and GIF 800×559, both 120.1 seconds. Rendering commands remain in [the rendering guide](../../docs/walkthrough.md). The preserved storyboard/assets still distinguish master, loop and deploy supervisor; this rework changes no media content.

`npm run build`, `npm run docs:check` and ordinary `graphyard verify GY-3048` pass. Own verification executes the complete documentation-validation test, renders thirteen frames, checks chapter/scrubber/playback behavior, and fails its base exercise as expected. Uses the existing browser cache through `WALKTHROUGH_BROWSERS_PATH=/home/vish/.cache/ms-playwright`. No old broad full-suite rerun was performed; mandatory submission checks and canonical gates remain in force.

Visually inspected the MP4 opening, review, recovery and final scenes (0, 55, 90, 116 seconds) and GIF opening: readable captions, populated first frame, distinct roles, independent review and exactly three human decisions. Self-review: AC-1 retains implemented master wakes, independent ownership and the concrete failed-check handoff; AC-2 retains corrected rendered media and repeatable rendering; AC-3 preserves operational details and links while shortening all handwritten guides. No BLOCKING finding remains.
